/**
 * Codex provider —— 封装本机 OpenAI Codex CLI（codex exec --json）。
 *
 * 与 Claude 的结构性差异，全部收敛在本文件：
 *  - 续聊是子命令 `exec resume <id>`，不是 `--resume` 标志
 *  - 输出无逐字 token delta：整条回复作为单个 `item.completed`(agent_message) 在 turn 末尾返回
 *    （逐字 delta 只存在于 codex app-server JSON-RPC 长连接通道，违背本插件「按需拉起即销毁」架构，
 *     留待后续；本期 Codex 回复整段返回，复用 host 的「未出过文本则采用 final」兜底路径）
 *  - session id = `thread.started` 事件的 thread_id
 *  - 鉴权复用本机 ChatGPT 登录 / OPENAI_API_KEY，由 codex 自行处理
 *
 * exec 选项（--json/--sandbox/--skip-git-repo-check/--model）属于 `codex exec`，
 * resume 只认 SESSION_ID/--last/--all/PROMPT —— 故 exec 选项必须排在 `resume` 之前（见 buildArgs）。
 * prompt 走 stdin（末尾 "-"），base exec 与 resume 的 PROMPT 均支持 stdin。
 */

// install.js 在包装器里写入 codex 绝对路径
function resolveBin() {
  return process.env.CODEX_CLI || "codex";
}

function resolveModel() {
  return process.env.CODEX_MODEL || null;
}

// codex exec --json 不发逐字增量；恒返回 false，host 走整段返回路径
function probeStream() {
  return Promise.resolve(false);
}

// codex exec <EXEC选项> [resume <id>] -
// 关键：--json / --sandbox / --skip-git-repo-check / --model 都是 `codex exec` 的选项，
// 必须放在 `resume` 子命令【之前】；resume 只认 SESSION_ID / --last / --all / PROMPT。
// 放反会被 clap 当成 resume 的未知参数而退出码 2。
// 末尾 "-" 表示 prompt 从 stdin 读（resume 的 PROMPT 同样支持 stdin），与 Claude 一致地避免注入/转义。
function buildArgs({ resumeId, model }) {
  const execFlags = ["--json", "--skip-git-repo-check", "--sandbox", "read-only"];
  if (model) execFlags.push("--model", model);
  if (resumeId) return ["exec", ...execFlags, "resume", resumeId, "-"];
  return ["exec", ...execFlags, "-"];
}

// codex 的 thread_id 多为 UUID；放宽到字母数字/下划线/连字符，校验后才上命令行（shell:true）
function isValidSessionId(id) {
  return /^[0-9a-zA-Z_-]{8,128}$/.test(id);
}

// 解析一行 JSONL → 归一化事件
// - thread.started → thread_id 作为 session id（resume 时同 id，证明会话延续）
// - item.completed 且 item.type==="agent_message" → 整条回复（final:true）
// - turn.failed / error → 错误
function parseLine(line) {
  let ev;
  try { ev = JSON.parse(line); } catch { return null; }

  if (ev.type === "thread.started" && ev.thread_id) {
    return { sessionId: ev.thread_id };
  }
  if (ev.type === "item.completed" && ev.item && ev.item.type === "agent_message" && typeof ev.item.text === "string") {
    return { text: ev.item.text, final: true };
  }
  if (ev.type === "turn.failed") {
    return { error: (ev.error && ev.error.message) || "codex turn 失败" };
  }
  if (ev.type === "error") {
    return { error: ev.message || "codex 错误" };
  }
  return null;
}

module.exports = {
  id: "codex",
  label: "Codex",
  resolveBin,
  resolveModel,
  probeStream,
  buildArgs,
  isValidSessionId,
  parseLine,
};
