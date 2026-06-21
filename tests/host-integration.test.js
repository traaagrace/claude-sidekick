/**
 * host.js 端到端集成测试：用一个「假 codex CLI」喂真实形态的 JSONL，
 * 验证整条链路——native messaging 帧编解码 → streamProvider → provider.parseLine → 回帧。
 * 不需要真的装 codex/claude。运行：node --test
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const HOST = path.join(__dirname, "..", "host.js");

// 4 字节小端长度 + UTF-8 JSON
function encodeFrame(obj) {
  const body = Buffer.from(JSON.stringify(obj), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

// 从 host stdout 解析回帧
function makeFrameReader(onMsg) {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 4) {
      const len = buf.readUInt32LE(0);
      if (buf.length < 4 + len) break;
      const body = buf.subarray(4, 4 + len).toString("utf8");
      buf = buf.subarray(4 + len);
      onMsg(JSON.parse(body));
    }
  };
}

// 写一个假的 codex：消费 stdin 的 prompt，然后吐 codex exec --json 形态的 JSONL
function writeFakeCodex() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sidekick-fake-"));
  const p = path.join(dir, "codex");
  const script = [
    "#!/bin/sh",
    "cat > /dev/null", // 消费 stdin（prompt），避免 EPIPE
    `printf '%s\\n' '{"type":"thread.started","thread_id":"th-test-123"}'`,
    `printf '%s\\n' '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"FAKE_REPLY"}}'`,
    `printf '%s\\n' '{"type":"turn.completed","usage":{}}'`,
    "exit 0",
  ].join("\n");
  fs.writeFileSync(p, script + "\n", { mode: 0o755 });
  return p;
}

test("host.js: codex 后端 ask 全链路（chunk + done.sessionId）", { timeout: 15000 }, async () => {
  const fakeCodex = writeFakeCodex();
  const child = spawn(process.execPath, [HOST], {
    env: { ...process.env, CODEX_CLI: fakeCodex, CLAUDE_LOG: "0" },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const frames = [];
  const done = new Promise((resolve) => {
    child.stdout.on("data", makeFrameReader((msg) => {
      frames.push(msg);
      if (msg.type === "done") resolve();
    }));
  });

  child.stdin.write(encodeFrame({ type: "ask", question: "你好", provider: "codex" }));

  await done;
  child.stdin.end(); // host 收到 stdin end 后自行退出

  const chunks = frames.filter((f) => f.type === "chunk").map((f) => f.text).join("");
  const doneFrame = frames.find((f) => f.type === "done");

  assert.equal(chunks, "FAKE_REPLY", "整段回复应作为单个 chunk 转发");
  assert.equal(doneFrame.sessionId, "th-test-123", "thread_id 应作为 session id 回传");
});

test("host.js: ping → pong", { timeout: 10000 }, async () => {
  const child = spawn(process.execPath, [HOST], {
    env: { ...process.env, CLAUDE_LOG: "0" },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const pong = new Promise((resolve) => {
    child.stdout.on("data", makeFrameReader((msg) => {
      if (msg.type === "pong") resolve(true);
    }));
  });

  child.stdin.write(encodeFrame({ type: "ping" }));
  const ok = await pong;
  child.stdin.end();
  assert.equal(ok, true);
});
