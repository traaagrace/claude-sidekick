#!/usr/bin/env node
/**
 * Claude Sidekick - Native Messaging Host
 * 由 Chrome 按需自动启动/销毁，无需手动运行。
 * stdio 协议：4 字节小端长度 + UTF-8 JSON
 * 注意：stdout 只能写协议帧，调试日志一律走 stderr
 *
 * 多后端：每条消息可带 provider 字段（claude / codex），由 providers/ 注册表解析。
 * 本文件只保留与后端无关的通用逻辑：prompt 拼装、流式循环、日志、存笔记。
 * 各后端的命令行参数 / 输出解析 / 流式能力 / session 校验封装在 providers/<id>.js。
 */

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const providers = require("./providers");

// 保存研究笔记的目录（host.js 同目录下 notes/，已加入 .gitignore）
const NOTES_DIR = path.join(__dirname, "notes");

// ---------- 文件日志 ----------
// 默认开启，包装器里设 CLAUDE_LOG=0 可关闭；日志含 prompt 全文（选中的页面原文）
// 清除规则：host 每次启动检查 host.log 超过 2MB 即轮转为 host.log.old（覆盖旧的），
// 磁盘占用上限 ≈ 4MB。任何日志失败静默降级为仅 stderr，不影响问答主流程。
const LOG_MAX_BYTES = 2 * 1024 * 1024;
const LOG_FILE = path.join(__dirname, "logs", "host.log");

let logStream = null;
if (process.env.CLAUDE_LOG !== "0") {
  try {
    // 日志含 prompt 原文：目录/文件收紧为仅本用户可读写（Windows 忽略 mode，无副作用）
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true, mode: 0o700 });
    let size = 0;
    try { size = fs.statSync(LOG_FILE).size; } catch { /* 文件尚不存在 */ }
    if (size > LOG_MAX_BYTES) {
      // Windows 的 rename 不覆盖已存在目标，先删旧 .old
      fs.rmSync(LOG_FILE + ".old", { force: true });
      fs.renameSync(LOG_FILE, LOG_FILE + ".old");
    }
    logStream = fs.createWriteStream(LOG_FILE, { flags: "a", mode: 0o600 });
    // createWriteStream 懒打开：真实失败（权限/磁盘）走异步 error 事件，在此降级
    logStream.on("error", () => (logStream = null));
  } catch {
    logStream = null;
  }
}

function logFile(text) {
  if (!logStream) return;
  // write 失败实际由上面的 error 事件降级；try/catch 仅兜 stream 已销毁等同步异常。
  // 不做背压控制：host 为短命进程、日志量小，磁盘异常时宁可静默丢日志也不阻塞问答
  try {
    logStream.write(`${new Date().toISOString()} ${text}\n`);
  } catch {
    logStream = null;
  }
}

// ---------- 发送帧 ----------
function send(msg) {
  const body = Buffer.from(JSON.stringify(msg), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  process.stdout.write(Buffer.concat([header, body]));
}

function logErr(...parts) {
  const line = parts.join(" ");
  process.stderr.write(line + "\n");
  logFile(line);
}

// ---------- 接收帧 ----------
let inBuf = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
  inBuf = Buffer.concat([inBuf, chunk]);
  while (inBuf.length >= 4) {
    const len = inBuf.readUInt32LE(0);
    if (inBuf.length < 4 + len) break;
    const body = inBuf.subarray(4, 4 + len).toString("utf8");
    inBuf = inBuf.subarray(4 + len);
    try {
      handleMessage(JSON.parse(body));
    } catch (e) {
      send({ type: "error", error: "消息解析失败：" + e.message });
    }
  }
});

// Chrome 断开（面板关闭）→ 杀掉子进程并退出
let currentChild = null;
process.stdin.on("end", () => {
  if (currentChild) currentChild.kill();
  if (!logStream) process.exit(0);
  // 退出前 flush 日志，避免最后几行（如 [done]）丢失；300ms 兜底保证必然退出
  setTimeout(() => process.exit(0), 300);
  logStream.end(() => process.exit(0));
});

function handleMessage(msg) {
  if (msg.type === "ping") {
    send({ type: "pong" });
    return;
  }
  const provider = providers.get(msg.provider);
  if (msg.type === "ask") {
    runAsk(provider, msg.context, msg.question, msg.scenario, msg.sessionId);
    return;
  }
  if (msg.type === "save") {
    runSave(provider, msg.transcript, msg.sessionId);
    return;
  }
  send({ type: "error", error: "未知消息类型：" + msg.type });
}

// ---------- 通用流式引擎（与后端无关） ----------
// 启动 provider 子进程，prompt 走 stdin（防注入），逐行交给 provider.parseLine 归一化，
// onChunk 实时转发文字。resolve 时给出全文、session id、退出码。
// 归一化事件语义：
//   - text + final:false → 逐字增量，立即转发并标记「已出文本」
//   - text + final:true  → 整条完整回复，仅当本轮尚未出过文本时采用（兜底 / Codex 路径）
function streamProvider(provider, prompt, resumeId, onChunk) {
  return new Promise((resolve) => {
    (async () => {
      const bin = provider.resolveBin();
      const stream = await provider.probeStream();
      const validResume = resumeId && provider.isValidSessionId(resumeId) ? resumeId : null;
      const args = provider.buildArgs({ resumeId: validResume, model: provider.resolveModel(), stream });

      let child;
      try {
        child = spawn(bin, args, { env: { ...process.env }, shell: true });
      } catch (err) {
        resolve({ text: "", sessionId: validResume, code: -1, gotText: false, error: err.message, spawnError: true });
        return;
      }
      currentChild = child;
      child.stdin.write(prompt);
      child.stdin.end();

      let lineBuf = "";
      let full = "";
      let gotText = false;
      let lastSessionId = validResume || null;
      let errMsg = null;
      let settled = false;

      function consume(r) {
        if (!r) return;
        if (r.sessionId) lastSessionId = r.sessionId;
        if (r.error) errMsg = r.error;
        if (r.text != null) {
          if (r.final) {
            if (!gotText) { onChunk(r.text); full += r.text; gotText = true; }
          } else {
            onChunk(r.text); full += r.text; gotText = true;
          }
        }
      }

      function feed(chunk) {
        lineBuf += chunk;
        const lines = lineBuf.split("\n");
        lineBuf = lines.pop(); // 末尾可能是被分块劈开的半行 JSON，留到下次拼
        for (const line of lines) {
          if (!line.trim()) continue;
          try { consume(provider.parseLine(line)); } catch { /* 非 JSON 行（启动告警等）忽略 */ }
        }
      }

      child.stdout.on("data", (data) => feed(data.toString()));
      child.stderr.on("data", (d) => logErr(`[${provider.id} stderr]`, d.toString()));

      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        currentChild = null;
        // flush 末尾残行（无换行收尾时）
        if (lineBuf.trim()) { try { consume(provider.parseLine(lineBuf)); } catch { /* 忽略 */ } }
        resolve({ text: full, sessionId: lastSessionId, code, gotText, error: errMsg });
      });

      child.on("error", (err) => {
        if (settled) return;
        settled = true;
        currentChild = null;
        resolve({ text: full, sessionId: lastSessionId, code: -1, gotText, error: err.message, spawnError: true });
      });
    })();
  });
}

// ---------- 提问 ----------
async function runAsk(provider, context, question, scenario, resumeId) {
  // 分段拼 prompt：场景指令置于最前。scenario 为空时与历史逐字节一致——
  // 等价性依赖「context 段末尾是 `---`（不带换行），由 join("\n\n") 补出旧版的 `---\n\n`」，改动拼接时务必保持
  const sections = [];
  if (scenario) sections.push(`【场景要求】\n${scenario}`);
  if (context) sections.push(`以下是页面选中的内容：\n\n---\n${context}\n---`);
  const fallback = scenario ? "请按上述场景要求处理" : context ? "请根据以上内容给我一个总结或分析" : "你好";
  sections.push(question || fallback);
  const prompt = sections.join("\n\n");

  const startedAt = Date.now();
  logFile(`[ask] provider=${provider.id} resume=${resumeId || "无"} ctx=${(context || "").length}字 scenario=${(scenario || "").length}字 q=${question || "（空）"}`);
  logFile(`[prompt] ----------\n${prompt}\n----------`);

  const res = await streamProvider(provider, prompt, resumeId, (text) => send({ type: "chunk", text }));

  if (res.spawnError) {
    logFile(`[error] 无法启动 ${provider.id}：${res.error}`);
    send({ type: "error", error: `无法启动 ${provider.label}：${res.error}` });
    return;
  }
  // 无任何输出时给出可读的失败原因（后端报错 / 非零退出）
  if (!res.gotText && res.error) {
    send({ type: "chunk", text: `[错误] ${res.error}` });
  } else if (!res.gotText && res.code !== 0) {
    send({ type: "chunk", text: `[错误] ${provider.label} 退出码 ${res.code}` });
  }
  logFile(`[done] provider=${provider.id} code=${res.code} session=${res.sessionId || "无"} 耗时=${((Date.now() - startedAt) / 1000).toFixed(1)}s 输出=${res.text.length}字`);
  send({ type: "done", code: res.code, sessionId: res.sessionId });
}

// ---------- 保存研究笔记到本地 ----------
function pad2(n) { return String(n).padStart(2, "0"); }

// 文件名时间戳（本地 YYYYMMDD-HHMMSS）+ 正文可读时间
function stamp(d) {
  const date = `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`;
  const time = `${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
  const human = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  return { date, time, human };
}

// 拆分总结为 {title, body}：首个非空行若是 Markdown 标题，用作标题并从正文剔除，
// 避免文档 H1 与总结自带标题重复；否则标题取首行、正文保留全文。
function splitSummary(summary) {
  const lines = summary.split("\n");
  let i = 0;
  while (i < lines.length && !lines[i].trim()) i++; // 跳过前导空行
  const first = (lines[i] || "").trim();
  const m = first.match(/^#+\s*(.+)$/);
  if (m) {
    const body = lines.slice(i + 1).join("\n").trim();
    return { title: m[1].trim().slice(0, 40), body };
  }
  return { title: first.slice(0, 40) || "研究笔记", body: summary.trim() };
}

// 文件名安全化：非字母/数字（含中日韩）替换为 -，截断 40 字
function slugify(s) {
  const out = (s || "")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return out || "研究笔记";
}

async function runSave(provider, transcript, resumeId) {
  const startedAt = Date.now();
  logFile(`[save] provider=${provider.id} resume=${resumeId || "无"} transcript=${(transcript || "").length}字`);

  const instruction = "把我们刚才整场讨论总结成一篇结构化研究笔记。要求：第一行用 `# ` 输出一个概括本次讨论【主题】的简短标题（不超过 20 字，必须反映实际讨论内容，禁止使用「你好」「奥北，你好」之类的问候语或开场白）；其后依次写背景、关键要点、结论。只输出笔记正文的 Markdown，不要复述原始对话原文。";
  // 能 resume 就靠会话上下文（省 token）；否则把 transcript 内联进 prompt（不支持续聊时降级）
  const canResume = resumeId && provider.isValidSessionId(resumeId);
  const prompt = canResume
    ? instruction
    : `${instruction}\n\n以下是原始对话：\n\n---\n${transcript}\n---`;

  const res = await streamProvider(provider, prompt, canResume ? resumeId : null, (text) => send({ type: "chunk", text }));

  if (res.spawnError) {
    logFile(`[error] 无法启动 ${provider.id}：${res.error}`);
    send({ type: "error", error: `无法启动 ${provider.label}：${res.error}` });
    return;
  }

  // 总结失败也落盘：保证点击不白费，原始对话照常写入
  const summary = res.text;
  const ok = summary.trim().length > 0;
  const { title, body } = ok ? splitSummary(summary) : { title: "研究笔记", body: "" };
  const summarySection = ok ? (body || title) : "（总结生成失败，仅保留原始对话）";

  const { date, time, human } = stamp(new Date());
  const fileName = `${date}-${time}-${slugify(title)}.md`;
  const content =
    `# ${title}\n\n_${human}_\n\n## 总结\n\n${summarySection}\n\n---\n\n## 原始对话\n\n${transcript || "（无）"}\n`;

  try {
    fs.mkdirSync(NOTES_DIR, { recursive: true });
    fs.writeFileSync(path.join(NOTES_DIR, fileName), content, "utf8");
    const rel = path.join("notes", fileName);
    logFile(`[saved] provider=${provider.id} file=${rel} 总结=${ok ? "成功" : "失败"} 耗时=${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
    send({ type: "saved", path: rel });
    send({ type: "done", sessionId: res.sessionId });
  } catch (e) {
    logFile(`[error] 写盘失败：${e.message}`);
    send({ type: "error", error: "写盘失败：" + e.message });
  }
}
