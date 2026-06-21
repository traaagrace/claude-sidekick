/**
 * Claude provider —— 封装本机 Claude Code CLI。
 * 行为与历史版本逐字节等价：args / prompt 拼装由 host 负责，本文件只声明
 * 「参数怎么拼、输出怎么解析、是否支持逐字流式、session id 怎么校验」。
 */

const { spawn } = require("child_process");

// install.js 在包装器里写入 claude 绝对路径（Chrome 启动的进程拿不到 shell 的 PATH）
function resolveBin() {
  return process.env.CLAUDE_CLI || "claude";
}

// 可选：包装器里设 CLAUDE_MODEL=haiku 用更快的模型
function resolveModel() {
  return process.env.CLAUDE_MODEL || null;
}

// 旧版 CLI 不支持逐字流式（--include-partial-messages），探测一次并缓存
let partialPromise = null;
function probeStream() {
  if (!partialPromise) {
    partialPromise = new Promise((resolve) => {
      const probe = spawn(resolveBin(), ["--help"], { shell: true });
      let helpText = "";
      probe.stdout.on("data", (d) => (helpText += d.toString()));
      probe.on("close", () => resolve(helpText.includes("--include-partial-messages")));
      probe.on("error", () => resolve(false));
    });
  }
  return partialPromise;
}

// claude -p 的参数；resumeId 已由 host 用 isValidSessionId 校验过，这里非空即附加
function buildArgs({ resumeId, model, stream }) {
  const args = ["-p", "--output-format", "stream-json", "--verbose"];
  if (resumeId) args.push("--resume", resumeId);
  if (stream) args.push("--include-partial-messages");
  if (model) args.push("--model", model);
  return args;
}

// session id 来自插件消息，严格校验格式再上命令行（host 用 shell:true 启动）
function isValidSessionId(id) {
  return /^[0-9a-zA-Z-]{8,64}$/.test(id);
}

// 解析一行 NDJSON → 归一化事件 { sessionId?, text?, final? }
// - init / result 事件带 session_id，记下来供下一轮 --resume
// - 增量文字：{"type":"stream_event","event":{"delta":{"type":"text_delta","text":"..."}}}
// - 兜底：CLI 不支持增量时，用最终 result 一次性返回（host 仅在未出过文本时采用）
function parseLine(line) {
  let ev;
  try { ev = JSON.parse(line); } catch { return null; }

  const out = {};
  if (ev.session_id) out.sessionId = ev.session_id;

  const delta = ev && ev.event && ev.event.delta;
  if (ev.type === "stream_event" && delta && delta.type === "text_delta" && delta.text) {
    out.text = delta.text;
    out.final = false;
    return out;
  }
  if (ev.type === "result" && typeof ev.result === "string") {
    out.text = ev.result;
    out.final = true;
    return out;
  }
  return out.sessionId ? out : null;
}

module.exports = {
  id: "claude",
  label: "Claude",
  resolveBin,
  resolveModel,
  probeStream,
  buildArgs,
  isValidSessionId,
  parseLine,
};
