#!/usr/bin/env node
/**
 * Claude Sidekick - Native Messaging Host
 * 由 Chrome 按需自动启动/销毁，无需手动运行。
 * stdio 协议：4 字节小端长度 + UTF-8 JSON
 * 注意：stdout 只能写协议帧，调试日志一律走 stderr
 */

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

// install.js 会在包装器里写入 claude 的绝对路径（Chrome 启动的进程拿不到 shell 的 PATH）
const CLAUDE = process.env.CLAUDE_CLI || "claude";

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

// Chrome 断开（面板关闭）→ 杀掉 claude 子进程并退出
let currentChild = null;
process.stdin.on("end", () => {
  if (currentChild) currentChild.kill();
  if (!logStream) process.exit(0);
  // 退出前 flush 日志，避免最后几行（如 [done]）丢失；300ms 兜底保证必然退出
  setTimeout(() => process.exit(0), 300);
  logStream.end(() => process.exit(0));
});

// ---------- 旧版 CLI 不支持逐字流式（--include-partial-messages），探测一次 ----------
let partialPromise = null;
function supportsPartial() {
  if (!partialPromise) {
    partialPromise = new Promise((resolve) => {
      const probe = spawn(CLAUDE, ["--help"], { shell: true });
      let helpText = "";
      probe.stdout.on("data", (d) => (helpText += d.toString()));
      probe.on("close", () => resolve(helpText.includes("--include-partial-messages")));
      probe.on("error", () => resolve(false));
    });
  }
  return partialPromise;
}

function handleMessage(msg) {
  if (msg.type === "ping") {
    send({ type: "pong" });
    return;
  }
  if (msg.type === "ask") {
    runClaude(msg.context, msg.question, msg.scenario, msg.sessionId);
    return;
  }
  send({ type: "error", error: "未知消息类型：" + msg.type });
}

async function runClaude(context, question, scenario, resumeId) {
  // 分段拼 prompt：场景指令置于最前。scenario 为空时各分支输出与旧版逐字节一致——
  // 等价性依赖「context 段末尾是 `---`（不带换行），由 join("\n\n") 补出旧版的 `---\n\n`」，改动拼接时务必保持
  const sections = [];
  if (scenario) sections.push(`【场景要求】\n${scenario}`);
  if (context) sections.push(`以下是页面选中的内容：\n\n---\n${context}\n---`);
  const fallback = scenario ? "请按上述场景要求处理" : context ? "请根据以上内容给我一个总结或分析" : "你好";
  sections.push(question || fallback);
  const prompt = sections.join("\n\n");

  const startedAt = Date.now();
  logFile(`[ask] resume=${resumeId || "无"} ctx=${(context || "").length}字 scenario=${(scenario || "").length}字 q=${question || "（空）"}`);
  logFile(`[prompt] ----------\n${prompt}\n----------`);

  // stream-json：claude 输出 NDJSON 事件流；逐字增量标志仅在 CLI 支持时附加
  const args = ["-p", "--output-format", "stream-json", "--verbose"];
  // 续接同一会话；ID 来自插件消息，严格校验格式再上命令行（shell:true）
  if (resumeId && /^[0-9a-zA-Z-]{8,64}$/.test(resumeId)) args.push("--resume", resumeId);
  if (await supportsPartial()) args.push("--include-partial-messages");
  // 可选：包装器里设 CLAUDE_MODEL=haiku 用更快的模型
  if (process.env.CLAUDE_MODEL) args.push("--model", process.env.CLAUDE_MODEL);

  // prompt 走 stdin，不拼进命令行：避免 shell 转义问题和命令注入
  const child = spawn(CLAUDE, args, { env: { ...process.env }, shell: true });
  currentChild = child;
  child.stdin.write(prompt);
  child.stdin.end();

  let lineBuf = "";
  let sentChars = 0;
  let lastSessionId = resumeId || null;

  function handleEvent(ev) {
    // init / result 事件都带 session_id，记下来供下一轮 --resume 续聊
    if (ev.session_id) lastSessionId = ev.session_id;
    // 增量文字：{"type":"stream_event","event":{"delta":{"type":"text_delta","text":"..."}}}
    const delta = ev?.event?.delta;
    if (ev.type === "stream_event" && delta?.type === "text_delta" && delta.text) {
      sentChars += delta.text.length;
      send({ type: "chunk", text: delta.text });
      return;
    }
    // 兜底：CLI 不支持增量事件时，用最终 result 一次性返回
    if (ev.type === "result" && sentChars === 0 && typeof ev.result === "string") {
      sentChars += ev.result.length;
      send({ type: "chunk", text: ev.result });
    }
  }

  child.stdout.on("data", (data) => {
    lineBuf += data.toString();
    const lines = lineBuf.split("\n");
    lineBuf = lines.pop(); // 末尾可能是被分块劈开的半行 JSON，留到下次拼
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        handleEvent(JSON.parse(line));
      } catch {
        // 非 JSON 行（启动警告等）忽略
      }
    }
  });

  child.stderr.on("data", (d) => logErr("[claude stderr]", d.toString()));

  child.on("close", (code) => {
    currentChild = null;
    if (sentChars === 0 && code !== 0) {
      send({ type: "chunk", text: `[错误] claude 退出码 ${code}` });
    }
    logFile(`[done] code=${code} session=${lastSessionId || "无"} 耗时=${((Date.now() - startedAt) / 1000).toFixed(1)}s 输出=${sentChars}字`);
    send({ type: "done", code, sessionId: lastSessionId });
  });

  child.on("error", (err) => {
    currentChild = null;
    logFile(`[error] 无法启动 claude：${err.message}`);
    send({ type: "error", error: `无法启动 claude：${err.message}` });
  });
}
