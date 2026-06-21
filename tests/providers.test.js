/**
 * Provider 抽象的单元测试（零依赖，用 node 内置 node:test）。
 * 运行：node --test
 * 重点：① Claude 向后兼容铁律（args/parse 与历史一致）；② Codex 适配器解析与 resume 结构。
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const providers = require("../providers");
const claude = require("../providers/claude");
const codex = require("../providers/codex");

// ---------- 注册表 ----------
test("registry: get 已知 id 与未知回退", () => {
  assert.equal(providers.get("claude").id, "claude");
  assert.equal(providers.get("codex").id, "codex");
  assert.equal(providers.get(undefined).id, "claude"); // 缺省回退，向后兼容
  assert.equal(providers.get("不存在").id, "claude");
});

// ---------- Claude 向后兼容铁律 ----------
test("claude.buildArgs: 基础参数与历史逐字节一致", () => {
  assert.deepEqual(
    claude.buildArgs({ resumeId: null, model: null, stream: false }),
    ["-p", "--output-format", "stream-json", "--verbose"]
  );
});

test("claude.buildArgs: resume + 流式 + 模型 的附加顺序", () => {
  assert.deepEqual(
    claude.buildArgs({ resumeId: "abcd1234", model: "haiku", stream: true }),
    ["-p", "--output-format", "stream-json", "--verbose", "--resume", "abcd1234", "--include-partial-messages", "--model", "haiku"]
  );
});

test("claude.parseLine: 增量 text_delta", () => {
  const line = JSON.stringify({ type: "stream_event", event: { delta: { type: "text_delta", text: "你" } } });
  assert.deepEqual(claude.parseLine(line), { text: "你", final: false });
});

test("claude.parseLine: result 兜底为 final", () => {
  const line = JSON.stringify({ type: "result", result: "完整回答" });
  assert.deepEqual(claude.parseLine(line), { text: "完整回答", final: true });
});

test("claude.parseLine: 仅 session_id 的事件", () => {
  const line = JSON.stringify({ type: "system", session_id: "sess-123" });
  assert.deepEqual(claude.parseLine(line), { sessionId: "sess-123" });
});

test("claude.parseLine: 非 JSON / 无关行返回 null", () => {
  assert.equal(claude.parseLine("启动告警：xxx"), null);
  assert.equal(claude.parseLine(JSON.stringify({ type: "stream_event", event: {} })), null);
});

test("claude.isValidSessionId", () => {
  assert.equal(claude.isValidSessionId("a1b2c3d4"), true);
  assert.equal(claude.isValidSessionId("short"), false);
  assert.equal(claude.isValidSessionId("has space xxxx"), false);
});

// ---------- Codex 适配器 ----------
test("codex.buildArgs: 非续聊 = exec，prompt 走 stdin", () => {
  assert.deepEqual(
    codex.buildArgs({ resumeId: null, model: null }),
    ["exec", "--json", "--skip-git-repo-check", "--sandbox", "read-only", "-"]
  );
});

test("codex.buildArgs: 续聊用 exec resume <id> 子命令", () => {
  assert.deepEqual(
    codex.buildArgs({ resumeId: "thread_abc12345", model: "gpt-5-codex" }),
    ["exec", "resume", "thread_abc12345", "--json", "--skip-git-repo-check", "--sandbox", "read-only", "--model", "gpt-5-codex", "-"]
  );
});

test("codex.probeStream: 恒 false（exec --json 无逐字增量）", async () => {
  assert.equal(await codex.probeStream(), false);
});

test("codex.parseLine: thread.started → sessionId", () => {
  const line = JSON.stringify({ type: "thread.started", thread_id: "th-xyz" });
  assert.deepEqual(codex.parseLine(line), { sessionId: "th-xyz" });
});

test("codex.parseLine: item.completed/agent_message → 整段 final", () => {
  const line = JSON.stringify({ type: "item.completed", item: { id: "item_0", type: "agent_message", text: "PING" } });
  assert.deepEqual(codex.parseLine(line), { text: "PING", final: true });
});

test("codex.parseLine: 非 agent_message 的 item 忽略", () => {
  const line = JSON.stringify({ type: "item.completed", item: { id: "i1", type: "reasoning", text: "想..." } });
  assert.equal(codex.parseLine(line), null);
});

test("codex.parseLine: turn.failed / error → error", () => {
  assert.deepEqual(
    codex.parseLine(JSON.stringify({ type: "turn.failed", error: { message: "额度不足" } })),
    { error: "额度不足" }
  );
  assert.deepEqual(
    codex.parseLine(JSON.stringify({ type: "error", message: "崩了" })),
    { error: "崩了" }
  );
});

test("codex.parseLine: turn.completed / 非 JSON 返回 null", () => {
  assert.equal(codex.parseLine(JSON.stringify({ type: "turn.completed", usage: {} })), null);
  assert.equal(codex.parseLine("not json"), null);
});

test("codex.isValidSessionId 接受 UUID 形态", () => {
  assert.equal(codex.isValidSessionId("550e8400-e29b-41d4-a716-446655440000"), true);
  assert.equal(codex.isValidSessionId("bad id!"), false);
});
