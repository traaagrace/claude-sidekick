#!/usr/bin/env node
/**
 * Claude Sidekick - Native Messaging Host
 * 由 Chrome 按需自动启动/销毁，无需手动运行。
 * stdio 协议：4 字节小端长度 + UTF-8 JSON
 * 注意：stdout 只能写协议帧，调试日志一律走 stderr
 */

const { spawn } = require("child_process");

// install.js 会在包装器里写入 claude 的绝对路径（Chrome 启动的进程拿不到 shell 的 PATH）
const CLAUDE = process.env.CLAUDE_CLI || "claude";

// ---------- 发送帧 ----------
function send(msg) {
  const body = Buffer.from(JSON.stringify(msg), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  process.stdout.write(Buffer.concat([header, body]));
}

function logErr(...parts) {
  process.stderr.write(parts.join(" ") + "\n");
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
  process.exit(0);
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
  // 分段拼 prompt：场景指令置于最前。scenario 为空时各分支输出与旧版逐字节一致
  const sections = [];
  if (scenario) sections.push(`【场景要求】\n${scenario}`);
  if (context) sections.push(`以下是页面选中的内容：\n\n---\n${context}\n---`);
  const fallback = scenario ? "请按上述场景要求处理" : context ? "请根据以上内容给我一个总结或分析" : "你好";
  sections.push(question || fallback);
  const prompt = sections.join("\n\n");

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
    send({ type: "done", code, sessionId: lastSessionId });
  });

  child.on("error", (err) => {
    currentChild = null;
    send({ type: "error", error: `无法启动 claude：${err.message}` });
  });
}
