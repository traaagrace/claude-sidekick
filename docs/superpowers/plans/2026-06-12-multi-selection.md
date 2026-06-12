# 多段选中上下文 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把选中上下文从单字符串槽位升级为多段数组，支持多段共存、一键清空、单条替换。

**Architecture:** 以 `chrome.storage.session` 为单一数据源（`selections` 数组 + `replaceTargetId` 标记）。background 负责写入新选中（追加/替换/去重），panel 通过 `storage.onChanged` 被动渲染列表并处理删除/清空/设置替换目标。`content.js` 与 `host.js` 零改动。

**Tech Stack:** Chrome Extension MV3（原生 JS，零依赖，无测试框架——按 spec 采用手动验收清单）

**Spec:** `docs/superpowers/specs/2026-06-12-multi-selection-design.md`

---

### Task 1: background.js — 统一写入入口 `addSelection()`

**Files:**
- Modify: `extension/background.js:11-29`（右键菜单与 SELECTED_TEXT 两处写入点）

- [ ] **Step 1: 替换两处 `selectedText` 写入为 `addSelection()`**

将 `extension/background.js` 第 11-29 行的这段旧代码：

```js
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "ask-claude") {
    chrome.storage.session.set({ selectedText: info.selectionText }, () => {
      chrome.sidePanel.open({ tabId: tab.id });
    });
  }
});

chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ tabId: tab.id });
});

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg.type === "SELECTED_TEXT") {
    chrome.storage.session.set({ selectedText: msg.text }, () => {
      chrome.sidePanel.open({ tabId: sender.tab.id });
    });
  }
});
```

替换为：

```js
// 把新选中写入 selections 数组：与已有段完全相同 → 忽略（去重优先，待替换状态保留）；
// 有待替换标记且目标仍存在 → 原位替换；否则 → 追加。完成后清除替换标记并打开面板。
function addSelection(text, tabId) {
  chrome.storage.session.get(["selections", "replaceTargetId"], (res) => {
    const selections = res.selections || [];
    const replaceTargetId = res.replaceTargetId || null;

    if (selections.some((s) => s.text === text)) {
      chrome.sidePanel.open({ tabId });
      return;
    }

    const hasTarget = replaceTargetId && selections.some((s) => s.id === replaceTargetId);
    const next = hasTarget
      ? selections.map((s) => (s.id === replaceTargetId ? { ...s, text, addedAt: Date.now() } : s))
      : [...selections, { id: crypto.randomUUID(), text, addedAt: Date.now() }];

    // 替换完成（或标记指向已删除条目而失效）后，统一清除标记
    chrome.storage.session.set({ selections: next, replaceTargetId: null }, () => {
      chrome.sidePanel.open({ tabId });
    });
  });
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "ask-claude") addSelection(info.selectionText, tab.id);
});

chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ tabId: tab.id });
});

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg.type === "SELECTED_TEXT") addSelection(msg.text, sender.tab.id);
});
```

- [ ] **Step 2: 语法检查**

Run: `node --check extension/background.js`
Expected: 无输出（exit 0）

- [ ] **Step 3: Commit**

```bash
git add extension/background.js
git commit -m "feat: background 多段选中写入（追加/替换/去重）"
```

---

### Task 2: panel.html — context-bar 列表化

**Files:**
- Modify: `extension/panel.html:48-56`（CSS）与 `extension/panel.html:154-158`（HTML 结构）

- [ ] **Step 1: 替换 context-bar 的 CSS**

将 `extension/panel.html` 第 48-56 行的这段旧样式：

```css
  #context-bar {
    background: #fffbf0; border-bottom: 1px solid #f0e8cc;
    padding: 8px 14px; font-size: 12px; color: #7a6a3a;
    display: none; align-items: flex-start; gap: 8px;
  }
  #context-bar.visible { display: flex; }
  #context-text { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; line-height: 1.4; }
  #clear-ctx { cursor: pointer; color: #b09050; font-size: 16px; line-height: 1; flex-shrink: 0; background: none; border: none; padding: 0; }
```

替换为：

```css
  #context-bar {
    background: #fffbf0; border-bottom: 1px solid #f0e8cc;
    padding: 8px 14px; font-size: 12px; color: #7a6a3a;
    display: none; flex-direction: column; gap: 6px;
  }
  #context-bar.visible { display: flex; }
  #context-head { display: flex; align-items: center; gap: 8px; }
  #context-summary { flex: 1; line-height: 1.4; }
  #clear-ctx {
    cursor: pointer; color: #b09050; font-size: 12px; flex-shrink: 0;
    background: none; border: 1px solid #e0d4a8; border-radius: 5px; padding: 1px 8px;
    transition: color 0.15s, border-color 0.15s;
  }
  #clear-ctx:hover { color: #7a6a3a; border-color: #b09050; }
  /* 选段列表：超过约 3 条内部滚动，不挤压消息区 */
  #context-list { display: flex; flex-direction: column; gap: 4px; max-height: 96px; overflow-y: auto; }
  .ctx-item {
    display: flex; align-items: center; gap: 6px;
    background: #fff; border: 1px solid #f0e8cc; border-radius: 6px; padding: 4px 8px;
  }
  /* 待替换条目：黄色高亮边框 */
  .ctx-item.replacing { border-color: #d4a017; box-shadow: 0 0 0 1px #d4a017 inset; }
  .ctx-item .ctx-text { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; line-height: 1.4; }
  .ctx-item button {
    cursor: pointer; color: #b09050; background: none; border: none; padding: 0 2px;
    font-size: 13px; line-height: 1; flex-shrink: 0;
  }
  .ctx-item button:hover { color: #7a6a3a; }
```

- [ ] **Step 2: 替换 context-bar 的 HTML 结构**

将 `extension/panel.html` 第 154-158 行（CSS 替换后行号会偏移，按内容定位）的这段旧结构：

```html
<div id="context-bar">
  <span id="context-text"></span>
  <button id="clear-ctx" title="清除上下文">×</button>
</div>
```

替换为：

```html
<div id="context-bar">
  <div id="context-head">
    <span id="context-summary"></span>
    <button id="clear-ctx" title="清空全部选段">清空全部</button>
  </div>
  <div id="context-list"></div>
</div>
```

- [ ] **Step 3: Commit**

```bash
git add extension/panel.html
git commit -m "feat: context-bar 选段列表 UI"
```

---

### Task 3: panel.js — 选段状态渲染、操作与 prompt 拼接

**Files:**
- Modify: `extension/panel.js:1`（移除 `currentContext`）
- Modify: `extension/panel.js:75-94`（「选中文字上下文」整节）
- Modify: `extension/panel.js:133-138`（`doSend` 开头）与 `extension/panel.js:195`（`port.postMessage`）

- [ ] **Step 1: 替换顶部状态变量**

将 `extension/panel.js` 第 1 行：

```js
let currentContext = "";
```

替换为：

```js
let selections = []; // 选段数组 [{id, text, addedAt}]，单一数据源在 chrome.storage.session
let replaceTargetId = null; // 待替换条目 id；非空时下一次页面选中替换该条
```

- [ ] **Step 2: 替换「选中文字上下文」整节**

将 `extension/panel.js` 第 75-94 行的旧代码：

```js
// ---------- 选中文字上下文 ----------
chrome.storage.session.onChanged.addListener((changes) => {
  if (changes.selectedText) setContext(changes.selectedText.newValue);
});
chrome.storage.session.get("selectedText", (res) => {
  if (res.selectedText) setContext(res.selectedText);
});

function setContext(text) {
  currentContext = text;
  contextTextEl.textContent = `📎 ${text.slice(0, 80)}${text.length > 80 ? "…" : ""}`;
  contextBar.classList.add("visible");
  questionEl.focus();
}

document.getElementById("clear-ctx").addEventListener("click", () => {
  currentContext = "";
  contextBar.classList.remove("visible");
  chrome.storage.session.remove("selectedText");
});
```

替换为：

```js
// ---------- 选段上下文（多段共存） ----------
const contextSummaryEl = document.getElementById("context-summary");
const contextListEl = document.getElementById("context-list");

// 启动加载；旧版单条 key（selectedText）迁移为一条选段后删除，渲染交给 onChanged
chrome.storage.session.get(["selections", "replaceTargetId", "selectedText"], (res) => {
  if (res.selectedText) {
    const migrated = [...(res.selections || []), { id: crypto.randomUUID(), text: res.selectedText, addedAt: Date.now() }];
    chrome.storage.session.set({ selections: migrated });
    chrome.storage.session.remove("selectedText");
    return;
  }
  applyState(res.selections, res.replaceTargetId);
});

chrome.storage.session.onChanged.addListener((changes) => {
  if (!changes.selections && !changes.replaceTargetId) return;
  chrome.storage.session.get(["selections", "replaceTargetId"], (res) => {
    applyState(res.selections, res.replaceTargetId);
  });
});

function applyState(nextSelections, nextReplaceTargetId) {
  selections = nextSelections || [];
  replaceTargetId = nextReplaceTargetId || null;
  renderContextBar();
}

function renderContextBar() {
  if (!selections.length) {
    contextBar.classList.remove("visible");
    return;
  }

  const totalChars = selections.reduce((n, s) => n + s.text.length, 0);
  const replacingIndex = selections.findIndex((s) => s.id === replaceTargetId);
  contextSummaryEl.textContent = replacingIndex >= 0
    ? `📎 去页面选中新内容以替换第 ${replacingIndex + 1} 段`
    : `📎 已选 ${selections.length} 段 · 共 ${totalChars} 字`;

  contextListEl.replaceChildren(...selections.map((s, i) => buildCtxItem(s, i)));
  contextBar.classList.add("visible");
  questionEl.focus();
}

function buildCtxItem(sel, index) {
  const item = document.createElement("div");
  item.className = "ctx-item" + (sel.id === replaceTargetId ? " replacing" : "");

  const textEl = document.createElement("span");
  textEl.className = "ctx-text";
  textEl.textContent = `${index + 1}. ${sel.text.slice(0, 80)}${sel.text.length > 80 ? "…" : ""}`;

  const replaceBtn = document.createElement("button");
  replaceBtn.textContent = "⇄";
  replaceBtn.title = sel.id === replaceTargetId ? "取消替换" : "用下一次页面选中替换这段";
  replaceBtn.addEventListener("click", () => {
    chrome.storage.session.set({ replaceTargetId: sel.id === replaceTargetId ? null : sel.id });
  });

  const delBtn = document.createElement("button");
  delBtn.textContent = "×";
  delBtn.title = "删除这段";
  delBtn.addEventListener("click", () => {
    chrome.storage.session.set({
      selections: selections.filter((s) => s.id !== sel.id),
      ...(sel.id === replaceTargetId ? { replaceTargetId: null } : {}),
    });
  });

  item.append(textEl, replaceBtn, delBtn);
  return item;
}

// 多段拼接为单字符串交给 host（host 零改动）；仅 1 段时不加编号头，保持旧版 prompt 形态
function buildContext() {
  if (!selections.length) return "";
  if (selections.length === 1) return selections[0].text;
  return selections.map((s, i) => `【选段 ${i + 1}】\n${s.text}`).join("\n\n");
}

document.getElementById("clear-ctx").addEventListener("click", () => {
  chrome.storage.session.set({ selections: [], replaceTargetId: null });
});
```

注意：`panel.js` 第 8 行的 `const contextTextEl = document.getElementById("context-text");` 已无引用对象（`#context-text` 在 Task 2 中被移除），删除该行。

- [ ] **Step 3: 改造 `doSend` 的 context 来源与 user 气泡文案**

将 `doSend` 开头（原第 133-138 行）：

```js
function doSend() {
  if (isStreaming) return;
  const question = questionEl.value.trim();
  if (!question && !currentContext) return;

  addMsg("user", currentContext ? `📎 上下文 + ${question || "（分析选中内容）"}` : question);
```

替换为：

```js
function doSend() {
  if (isStreaming) return;
  const question = questionEl.value.trim();
  const context = buildContext();
  if (!question && !context) return;

  const ctxLabel = selections.length > 1 ? `${selections.length} 段上下文` : "上下文";
  addMsg("user", context ? `📎 ${ctxLabel} + ${question || "（分析选中内容）"}` : question);
```

将 `doSend` 末尾（原第 195 行）：

```js
  port.postMessage({ context: currentContext, question, sessionId });
```

替换为：

```js
  port.postMessage({ context, question, sessionId });
```

- [ ] **Step 4: 语法检查**

Run: `node --check extension/panel.js`
Expected: 无输出（exit 0）

Run: `grep -n "currentContext\|contextTextEl\|selectedText" extension/panel.js`
Expected: 仅迁移代码中出现 `selectedText`（2 处），`currentContext` / `contextTextEl` 无残留

- [ ] **Step 5: Commit**

```bash
git add extension/panel.js
git commit -m "feat: panel 多段选中渲染、单条替换/删除、一键清空"
```

---

### Task 4: 手动验收（spec 验收清单）

**Files:** 无代码改动

- [ ] **Step 1: 重载扩展**

`chrome://extensions` → Claude Sidekick → 刷新 ↻（manifest 无改动，无需重新注册 host）

- [ ] **Step 2: 逐项执行 spec 验收清单**

1. 选中 A → 选中 B：面板显示 2 段，顺序为 A、B
2. 跨标签页选中 C：面板显示 3 段
3. 重复选中 A：仍为 3 段（去重生效）
4. 点 ② 的 ⇄ → 页面选中 D：② 变为 D，待替换高亮消失
5. ⇄ 点两次：待替换状态取消，下次选中为追加
6. 设 ② 为待替换 → 删除 ② → 页面选中 E：E 追加为新条目
7. 点「清空全部」：列表清空，context-bar 隐藏
8. 2 段上下文 + 问题发送：回答内容可见 Claude 同时引用了两段（prompt 含【选段 N】头）
9. 仅 1 段时发送：行为与旧版一致
10. 关闭并重开 panel：选段与待替换状态均恢复

- [ ] **Step 3: 验收通过后更新 CHANGELOG 并提交**

在 `CHANGELOG.md` 顶部新增条目（按现有格式），内容概括：多段选中共存、单条替换（⇄）、单条删除（×）、一键清空全部。

```bash
git add CHANGELOG.md
git commit -m "docs: changelog 多段选中上下文"
```
