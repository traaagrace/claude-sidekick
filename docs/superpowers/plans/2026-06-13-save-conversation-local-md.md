# 研究会话保存到本地 Markdown Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** header 增加「↗ 存本地」按钮，把当前会话整理成 Markdown（Claude 总结 + 原始对话附录）写入 `notes/` 目录，路径回显面板。

**Architecture:** 复用现有 `claude-stream` 流式通道。panel 发 `{type:"save"}` → background 按 type 透传（含 transcript）→ host `runSave()` 用 `claude -p --resume` 生成总结（纯文本，不需工具权限），host 拼好文件写盘并回帧 `{type:"saved",path}`。总结失败仍写盘，绝不丢数据。

**Tech Stack:** Node 内置 `fs`/`path`，Chrome MV3 扩展，零新依赖

**Spec:** `docs/superpowers/specs/2026-06-13-save-conversation-local-md-design.md`

---

### Task 1: host.js — save 分支与 runSave()

**Files:**
- Modify: `host.js:14`（新增 NOTES_DIR 常量）、`host.js:110-120`（handleMessage 加 save 分支）、`host.js:201`（文件末尾追加 runSave 及辅助函数）

- [ ] **Step 1: 新增 NOTES_DIR 常量**

在 `host.js` 的 `const CLAUDE = process.env.CLAUDE_CLI || "claude";`（第 14 行）之后插入一行：

```js

// 保存研究笔记的目录（host.js 同目录下 notes/，已加入 .gitignore）
const NOTES_DIR = path.join(__dirname, "notes");
```

- [ ] **Step 2: handleMessage 增加 save 分支**

将 `handleMessage`（第 110-120 行）：

```js
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
```

替换为：

```js
function handleMessage(msg) {
  if (msg.type === "ping") {
    send({ type: "pong" });
    return;
  }
  if (msg.type === "ask") {
    runClaude(msg.context, msg.question, msg.scenario, msg.sessionId);
    return;
  }
  if (msg.type === "save") {
    runSave(msg.transcript, msg.sessionId);
    return;
  }
  send({ type: "error", error: "未知消息类型：" + msg.type });
}
```

- [ ] **Step 3: 文件末尾追加 runSave 及辅助函数**

在 `host.js` 末尾（`runClaude` 的最后一个 `}` 之后，第 201 行后）追加：

```js

// ---------- 保存研究笔记到本地 ----------
function pad2(n) { return String(n).padStart(2, "0"); }

// 文件名时间戳（本地 YYYYMMDD-HHMMSS）+ 正文可读时间
function stamp(d) {
  const date = `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`;
  const time = `${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
  const human = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  return { date, time, human };
}

// 标题取总结首个非空行（去掉 Markdown 标题井号），截断 40 字
function deriveTitle(summary) {
  for (const line of summary.split("\n")) {
    const t = line.replace(/^#+\s*/, "").trim();
    if (t) return t.slice(0, 40);
  }
  return "研究笔记";
}

// 文件名安全化：非字母/数字（含中日韩）替换为 -，截断 40 字
function slugify(s) {
  const out = (s || "")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return out || "研究笔记";
}

async function runSave(transcript, resumeId) {
  const startedAt = Date.now();
  logFile(`[save] resume=${resumeId || "无"} transcript=${(transcript || "").length}字`);

  const instruction = "把我们刚才整场讨论总结成一篇结构化研究笔记（含标题、背景、关键要点、结论），只输出笔记正文的 Markdown，不要复述原始对话原文。";
  // 能 resume 就靠会话上下文（省 token）；否则把 transcript 内联进 prompt（旧版 CLI 降级）
  const canResume = resumeId && /^[0-9a-zA-Z-]{8,64}$/.test(resumeId);
  const prompt = canResume
    ? instruction
    : `${instruction}\n\n以下是原始对话：\n\n---\n${transcript}\n---`;

  // 纯文本总结：不加 --allowedTools，无需任何工具权限
  const args = ["-p", "--output-format", "stream-json", "--verbose"];
  if (canResume) args.push("--resume", resumeId);
  if (await supportsPartial()) args.push("--include-partial-messages");
  if (process.env.CLAUDE_MODEL) args.push("--model", process.env.CLAUDE_MODEL);

  const child = spawn(CLAUDE, args, { env: { ...process.env }, shell: true });
  currentChild = child;
  child.stdin.write(prompt);
  child.stdin.end();

  let lineBuf = "";
  let summary = "";
  let lastSessionId = canResume ? resumeId : null;

  function handleEvent(ev) {
    if (ev.session_id) lastSessionId = ev.session_id;
    const delta = ev?.event?.delta;
    if (ev.type === "stream_event" && delta?.type === "text_delta" && delta.text) {
      summary += delta.text;
      send({ type: "chunk", text: delta.text });
      return;
    }
    // 旧版 CLI 无增量事件时，用最终 result 一次性返回
    if (ev.type === "result" && summary.length === 0 && typeof ev.result === "string") {
      summary += ev.result;
      send({ type: "chunk", text: ev.result });
    }
  }

  child.stdout.on("data", (data) => {
    lineBuf += data.toString();
    const lines = lineBuf.split("\n");
    lineBuf = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      try { handleEvent(JSON.parse(line)); } catch { /* 非 JSON 行忽略 */ }
    }
  });

  child.stderr.on("data", (d) => logErr("[claude stderr]", d.toString()));

  child.on("close", () => {
    currentChild = null;
    // 总结失败也落盘：保证点击不白费，原始对话照常写入
    const ok = summary.trim().length > 0;
    const summarySection = ok ? summary.trim() : "（总结生成失败，仅保留原始对话）";
    const title = ok ? deriveTitle(summary) : "研究笔记";

    const { date, time, human } = stamp(new Date());
    const fileName = `${date}-${time}-${slugify(title)}.md`;
    const content =
      `# ${title}\n\n_${human}_\n\n## 总结\n\n${summarySection}\n\n---\n\n## 原始对话\n\n${transcript || "（无）"}\n`;

    try {
      fs.mkdirSync(NOTES_DIR, { recursive: true });
      fs.writeFileSync(path.join(NOTES_DIR, fileName), content, "utf8");
      const rel = path.join("notes", fileName);
      logFile(`[saved] file=${rel} 总结=${ok ? "成功" : "失败"} 耗时=${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
      send({ type: "saved", path: rel });
      send({ type: "done", sessionId: lastSessionId });
    } catch (e) {
      logFile(`[error] 写盘失败：${e.message}`);
      send({ type: "error", error: "写盘失败：" + e.message });
    }
  });

  child.on("error", (err) => {
    currentChild = null;
    logFile(`[error] 无法启动 claude：${err.message}`);
    send({ type: "error", error: `无法启动 claude：${err.message}` });
  });
}
```

- [ ] **Step 4: 语法检查**

Run: `node --check host.js`（在仓库根执行）
Expected: exit 0，无输出

- [ ] **Step 5: Commit**

```bash
git add host.js
git commit -m "feat: host 新增 save 分支，会话总结+原文写入本地 Markdown"
```

---

### Task 2: background.js — 按 type 透传（含 transcript）

**Files:**
- Modify: `background.js:120`

- [ ] **Step 1: 透传消息 type 与 transcript**

将 `background.js` 第 120 行：

```js
    native.postMessage({ type: "ask", context: msg.context, question: msg.question, scenario: msg.scenario, sessionId: msg.sessionId });
```

替换为：

```js
    // ask 路径不带 type（默认 ask）；save 路径带 type:"save" 与 transcript。多余字段为 undefined，无副作用。
    native.postMessage({ type: msg.type || "ask", context: msg.context, question: msg.question, scenario: msg.scenario, sessionId: msg.sessionId, transcript: msg.transcript });
```

> host 回帧的 `saved` 类型由现有 `native.onMessage → port.postMessage(m)` 透明转发，background 无需额外改动。

- [ ] **Step 2: 语法检查**

Run: `node --check extension/background.js`
Expected: exit 0，无输出

- [ ] **Step 3: Commit**

```bash
git add extension/background.js
git commit -m "feat: background 按 type 透传 save 消息与 transcript"
```

---

### Task 3: panel.html / panel.js — 按钮与保存处理

**Files:**
- Modify: `extension/panel.html:218-221`（toolbar 加按钮）
- Modify: `extension/panel.js:14-15`（按钮引用）、`extension/panel.js:76`（new-chat 处理后追加 doSaveLocal）

- [ ] **Step 1: toolbar 增加「↗ 存本地」按钮**

将 `extension/panel.html` 第 218-221 行：

```html
<div id="toolbar">
  <button id="new-chat" title="结束当前会话并开启新对话，原对话自动复制到剪贴板">🆕 新对话</button>
  <button id="copy-all" title="把整个对话内容复制到剪贴板">📋 复制全部</button>
</div>
```

替换为：

```html
<div id="toolbar">
  <button id="new-chat" title="结束当前会话并开启新对话，原对话自动复制到剪贴板">🆕 新对话</button>
  <button id="copy-all" title="把整个对话内容复制到剪贴板">📋 复制全部</button>
  <button id="save-local" title="把当前会话整理成研究笔记，保存到本地 notes/ 目录">↗ 存本地</button>
</div>
```

- [ ] **Step 2: 新增按钮元素引用**

在 `extension/panel.js` 第 15 行 `const newChatBtn = document.getElementById("new-chat");` 之后追加一行：

```js
const saveLocalBtn = document.getElementById("save-local");
```

- [ ] **Step 3: 追加 doSaveLocal 处理**

在 `extension/panel.js` 的 newChatBtn 处理块（以 `});` 结尾的第 76 行）之后追加：

```js

// ---------- 保存到本地 ----------
// 自包含的流式处理：刻意不复用 doSend 的内部逻辑，避免改动已稳定的提问路径
saveLocalBtn.addEventListener("click", () => {
  if (isStreaming) return;
  const transcript = getTranscript();
  if (!transcript) {
    statusText.textContent = "还没有可保存的对话";
    setTimeout(checkBridge, 2000);
    return;
  }

  statusText.textContent = "正在整理并保存到本地…";
  const replyEl = addMsg("assistant", "");
  replyEl.classList.add("streaming");
  isStreaming = true;
  sendBtn.disabled = true;

  const port = chrome.runtime.connect({ name: "claude-stream" });

  let rawReply = "";
  let renderPending = false;
  function renderReply() {
    replyEl.dataset.raw = rawReply;
    replyEl.innerHTML = renderMarkdown(rawReply);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }
  function scheduleRender() {
    if (renderPending) return;
    renderPending = true;
    requestAnimationFrame(() => { renderPending = false; renderReply(); });
  }
  function finish() {
    renderReply();
    replyEl.classList.remove("streaming");
    isStreaming = false;
    sendBtn.disabled = false;
    port.disconnect();
    setTimeout(checkBridge, 2000);
  }

  port.onMessage.addListener((msg) => {
    if (msg.type === "chunk") {
      rawReply += msg.text;
      scheduleRender();
    } else if (msg.type === "saved") {
      rawReply += `\n\n---\n\n✅ 已保存到 \`${msg.path}\``;
      scheduleRender();
    } else if (msg.type === "done") {
      if (msg.sessionId) sessionId = msg.sessionId; // 保存复用并推进会话，保持线性
      finish();
    } else if (msg.type === "error") {
      rawReply += `\n\n[保存失败] ${msg.error}`;
      finish();
    }
  });

  port.onDisconnect.addListener(() => {
    if (isStreaming) {
      rawReply += "\n\n[连接中断]";
      finish();
    }
  });

  port.postMessage({ type: "save", transcript, sessionId });
});
```

- [ ] **Step 4: 语法检查**

Run: `node --check extension/panel.js`
Expected: exit 0，无输出

- [ ] **Step 5: Commit**

```bash
git add extension/panel.html extension/panel.js
git commit -m "feat: panel 增加「↗ 存本地」按钮与流式保存处理"
```

---

### Task 4: .gitignore / 文档 / 版本号

**Files:**
- Modify: `.gitignore`
- Modify: `extension/manifest.json:4`（版本号 1.5.1 → 1.6.0）
- Modify: `README.md`、`CHANGELOG.md`

- [ ] **Step 1: .gitignore 增加 notes/**

在 `.gitignore` 的 `logs/` 块之后插入：

```
# 保存的研究笔记（用户数据，不入库）
notes/
```

- [ ] **Step 2: manifest 版本号 1.5.1 → 1.6.0**

将 `extension/manifest.json` 第 4 行：

```json
  "version": "1.5.1",
```

替换为：

```json
  "version": "1.6.0",
```

- [ ] **Step 3: README 补「保存到本地」一节**

在 `README.md` 的「## 使用方式」一节中，`- **复制**：...` 那条之后追加一条：

```markdown
- **存本地**：点 header 的 **↗ 存本地**，Claude 把当前会话整理成研究笔记（总结 + 原始对话附录），
  写入 host 同目录的 `notes/YYYYMMDD-HHMMSS-标题.md`，面板回显文件路径。总结失败时仍会保存原始对话。
```

- [ ] **Step 4: CHANGELOG 更新功能清单与变更记录**

将 `CHANGELOG.md` 第 3 行 `## 当前功能清单（v1.5.1）` 改为：

```markdown
## 当前功能清单（v1.6.0）
```

在「### 复制能力」小节末尾（`- [x] 复制成功按钮短暂变...` 之后）追加：

```markdown

### 保存能力
- [x] **↗ 存本地**：把当前会话整理成研究笔记（Claude 总结 + 原始对话附录）写入 `notes/` 目录，文件名含日期时间与标题；总结失败仍保留原始对话
```

并在「## 变更记录」下、`### v1.5.1 - 2026-06-12` 之前插入：

```markdown
### v1.6.0 - 2026-06-13
- 新增「↗ 存本地」：会话总结 + 原始对话写入本地 `notes/*.md`
- host 新增 `save` 消息分支与 `runSave()`（`claude -p --resume` 生成总结，host 落盘）
- background 改为按 type 透传，`ask` / `save` 共用流式通道
- 总结失败降级：仍写盘并标注，保证点击不丢数据

```

- [ ] **Step 5: Commit**

```bash
git add .gitignore extension/manifest.json README.md CHANGELOG.md
git commit -m "docs: v1.6.0 保存到本地功能记录与版本号"
```

---

### Task 5: 手动验收（spec 6 条）

> 需在装好插件的 Chrome 中实测；改完后回 `chrome://extensions` 刷新插件。

1. 跑一段研究对话 → 点「↗ 存本地」→ 面板流式显示总结，结尾出现「✅ 已保存到 `notes/xxx.md`」。
2. 打开该 `.md` → 含 `# 标题`、`## 总结`、`## 原始对话`，原文与面板一致。
3. 无对话时点按钮 → 状态显示「还没有可保存的对话」，不生成文件、不开 port。
4. 断网或令 claude 失败 → 文件仍生成，`## 总结` 段标注「（总结生成失败，仅保留原始对话）」，原始对话完整。
5. `chmod -w notes/` 后保存 → 面板气泡出现「[保存失败] 写盘失败：…」，问答主流程不受影响。
6. 旧版 CLI（无 `--resume`）→ host 降级把 transcript 内联进总结 prompt，仍能保存。
