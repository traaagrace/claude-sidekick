# 自定义场景 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用户自定义场景（名称 + 指令文本），激活后作为上下文注入会话；会话级只注入一次、可中途切换；侧边栏内完成选择与增删改；预置 4 个场景。

**Architecture:** 场景库持久存 `chrome.storage.local`；激活/已注入状态放 panel 内存（与「面板关闭=会话结束」语义对齐）。panel 发送时按「id+prompt 快照比较」决定是否携带 `scenario` 字段；background 透传；host 把场景指令拼在 prompt 最前。`scenario` 为空时 host 行为与现状逐字节一致。

**Tech Stack:** Chrome Extension MV3（原生 JS，零依赖，无测试框架——按 spec 采用手动验收清单）

**Spec:** `docs/superpowers/specs/2026-06-12-custom-scenarios-design.md`

---

### Task 0: 创建功能分支

- [ ] **Step 1: 从 main 切出分支**

```bash
git checkout -b feat/custom-scenarios
```

---

### Task 1: 协议链路 — host.js 分段拼 prompt + background.js 透传

**Files:**
- Modify: `host.js:70-80`（`handleMessage` 的 ask 分支与 `runClaude` 签名/prompt 拼接）
- Modify: `extension/background.js:121` 附近（`native.postMessage` 透传）

- [ ] **Step 1: host.js 透传 scenario 参数**

将 `host.js` 中：

```js
  if (msg.type === "ask") {
    runClaude(msg.context, msg.question, msg.sessionId);
    return;
  }
```

替换为：

```js
  if (msg.type === "ask") {
    runClaude(msg.context, msg.question, msg.scenario, msg.sessionId);
    return;
  }
```

- [ ] **Step 2: runClaude 分段拼 prompt**

将 `host.js` 中：

```js
async function runClaude(context, question, resumeId) {
  const prompt = context
    ? `以下是页面选中的内容：\n\n---\n${context}\n---\n\n${question || "请根据以上内容给我一个总结或分析"}`
    : question || "你好";
```

替换为：

```js
async function runClaude(context, question, scenario, resumeId) {
  // 分段拼 prompt：场景指令置于最前。scenario 为空时各分支输出与旧版逐字节一致
  const sections = [];
  if (scenario) sections.push(`【场景要求】\n${scenario}`);
  if (context) sections.push(`以下是页面选中的内容：\n\n---\n${context}\n---`);
  const fallback = scenario ? "请按上述场景要求处理" : context ? "请根据以上内容给我一个总结或分析" : "你好";
  sections.push(question || fallback);
  const prompt = sections.join("\n\n");
```

- [ ] **Step 3: background.js 透传**

将 `extension/background.js` 中：

```js
    native.postMessage({ type: "ask", context: msg.context, question: msg.question, sessionId: msg.sessionId });
```

替换为：

```js
    native.postMessage({ type: "ask", context: msg.context, question: msg.question, scenario: msg.scenario, sessionId: msg.sessionId });
```

- [ ] **Step 4: 语法检查与旧行为等价性自查**

Run: `node --check host.js && node --check extension/background.js`
Expected: 无输出（exit 0）

人工核对四种 scenario 为空的分支（context±、question±）拼出的 prompt 与旧版逐字节一致。

- [ ] **Step 5: Commit**

```bash
git add host.js extension/background.js
git commit -m "feat: prompt 协议支持 scenario 字段（场景指令置于最前）"
```

---

### Task 2: panel.html — 场景胶囊条与管理视图

**Files:**
- Modify: `extension/panel.html`（`</style>` 前追加 CSS；`#toolbar` 后插入管理视图；`#input-area` 前插入胶囊条）

- [ ] **Step 1: 追加 CSS（放在 `#send:disabled` 规则之后、`</style>` 之前）**

```css
  /* ---- 场景胶囊条（输入区上方） ---- */
  #scenario-bar {
    background: #fff; border-top: 1px solid #e5e5e3;
    padding: 6px 12px 0; display: flex; gap: 6px; overflow-x: auto;
  }
  .scenario-chip {
    flex-shrink: 0; background: #fafaf9; border: 1px solid #e0e0de; border-radius: 12px;
    cursor: pointer; font-size: 12px; color: #555; padding: 3px 10px; line-height: 1.4;
    max-width: 96px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    transition: background 0.15s, color 0.15s, border-color 0.15s;
  }
  .scenario-chip:hover { background: #f0f0ee; color: #1a1a1a; border-color: #ccc; }
  .scenario-chip.active { background: #1a1a1a; color: #fff; border-color: #1a1a1a; }
  .scenario-chip.manage { font-size: 13px; padding: 3px 8px; }

  /* ---- 场景管理视图（消息区上方，默认隐藏） ---- */
  #scenario-manager {
    display: none; background: #fff; border-bottom: 1px solid #e5e5e3;
    padding: 10px 14px; max-height: 50vh; overflow-y: auto;
  }
  #scenario-manager.visible { display: block; }
  .scenario-row { display: flex; align-items: center; gap: 6px; padding: 4px 0; font-size: 13px; }
  .scenario-row-name { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .scenario-row button {
    cursor: pointer; color: #888; background: none; border: none; padding: 0 4px;
    font-size: 13px; line-height: 1;
  }
  .scenario-row button:hover { color: #1a1a1a; }
  #scenario-add {
    margin-top: 6px; background: #fafaf9; border: 1px dashed #ccc; border-radius: 6px;
    cursor: pointer; font-size: 12px; color: #555; padding: 4px 10px; width: 100%;
  }
  #scenario-add:hover { background: #f0f0ee; color: #1a1a1a; }
  #scenario-form { display: none; margin-top: 8px; border-top: 1px solid #eee; padding-top: 8px; }
  #scenario-form.visible { display: block; }
  #scenario-form input, #scenario-form textarea {
    width: 100%; border: 1px solid #e0e0de; border-radius: 6px; padding: 6px 8px;
    font-size: 12px; font-family: inherit; margin-bottom: 6px; background: #fafaf9; outline: none;
  }
  #scenario-form input:focus, #scenario-form textarea:focus { border-color: #aaa; background: #fff; }
  #scenario-form textarea { resize: vertical; min-height: 64px; }
  #scenario-form-err { color: #e05252; font-size: 11px; margin-right: auto; }
  .scenario-form-actions { display: flex; align-items: center; gap: 8px; }
  .scenario-form-actions button {
    cursor: pointer; font-size: 12px; border-radius: 6px; padding: 4px 12px;
    border: 1px solid #e0e0de; background: #fafaf9; color: #555;
  }
  #scenario-save { background: #1a1a1a; color: #fff; border-color: #1a1a1a; }
```

- [ ] **Step 2: 在 `#toolbar` 的 `</div>` 之后插入管理视图**

```html
<div id="scenario-manager">
  <div id="scenario-list"></div>
  <div id="scenario-form">
    <input id="scenario-name" placeholder="场景名称（如：翻译）" maxlength="20" />
    <textarea id="scenario-prompt" placeholder="提示词指令（如：你是专业译者，把内容准确翻译成中文……）"></textarea>
    <div class="scenario-form-actions">
      <span id="scenario-form-err"></span>
      <button id="scenario-cancel">取消</button>
      <button id="scenario-save">保存</button>
    </div>
  </div>
</div>
```

- [ ] **Step 3: 在 `<div id="input-area">` 之前插入胶囊条**

```html
<div id="scenario-bar"></div>
```

- [ ] **Step 4: Commit**

```bash
git add extension/panel.html
git commit -m "feat: 场景胶囊条与管理视图 UI"
```

---

### Task 3: panel.js — 场景库播种、渲染、增删改

**Files:**
- Modify: `extension/panel.js`（顶部状态变量后追加「自定义场景」整节）

- [ ] **Step 1: 在「选段上下文」节之后追加「自定义场景」节**

```js
// ---------- 自定义场景 ----------
let scenarios = []; // 场景库 [{id, name, prompt}]，持久存 chrome.storage.local
let activeScenarioId = null; // 当前激活场景 id；面板关闭即重置（与会话生命周期一致）
let injectedScenario = null; // 本会话已注入的 {id, prompt} 快照；按 id+prompt 比较决定是否重新注入
let editingScenarioId = null; // 管理表单当前编辑的场景 id；null = 新建

const scenarioBarEl = document.getElementById("scenario-bar");
const scenarioManagerEl = document.getElementById("scenario-manager");
const scenarioListEl = document.getElementById("scenario-list");
const scenarioFormEl = document.getElementById("scenario-form");
const scenarioNameEl = document.getElementById("scenario-name");
const scenarioPromptEl = document.getElementById("scenario-prompt");
const scenarioFormErrEl = document.getElementById("scenario-form-err");

const PRESET_SCENARIOS = [
  { name: "翻译", prompt: "你是专业译者。把内容准确翻译成中文；专业术语保留原文并加简短注释；最后用一两句话说明整体语境或关键难点。" },
  { name: "总结要点", prompt: "用条目式列出内容的核心要点，按重要性排序，每条一句话；最后给出一句话的整体结论。" },
  { name: "代码解读", prompt: "你是资深工程师。解释这段代码的功能、关键逻辑与执行流程，指出潜在问题或坑，必要时给出改进建议。" },
  { name: "润色改写", prompt: "在保持原意的前提下润色这段文字，使其更通顺、专业；输出润色后的全文，并简要列出主要修改点。" },
];

// 启动加载；预置场景只播种一次（scenariosSeeded 标记），用户删除后不复活
chrome.storage.local.get(["scenarios", "scenariosSeeded"], (res) => {
  if (!res.scenariosSeeded) {
    const seeded = PRESET_SCENARIOS.map((p) => ({ id: crypto.randomUUID(), ...p }));
    chrome.storage.local.set({ scenarios: seeded, scenariosSeeded: true });
    return; // onChanged 触发渲染
  }
  scenarios = res.scenarios || [];
  renderScenarioBar();
});

chrome.storage.local.onChanged.addListener((changes) => {
  if (!changes.scenarios) return;
  scenarios = changes.scenarios.newValue || [];
  // 激活中的场景被删除 → 自动取消激活
  if (activeScenarioId && !scenarios.some((s) => s.id === activeScenarioId)) activeScenarioId = null;
  renderScenarioBar();
  renderScenarioManager();
});

function renderScenarioBar() {
  const chips = scenarios.map((s) => {
    const chip = document.createElement("button");
    chip.className = "scenario-chip" + (s.id === activeScenarioId ? " active" : "");
    chip.textContent = s.name;
    chip.title = s.prompt;
    chip.addEventListener("click", () => {
      activeScenarioId = s.id === activeScenarioId ? null : s.id; // 再点一次取消激活
      renderScenarioBar();
    });
    return chip;
  });

  const manageBtn = document.createElement("button");
  manageBtn.className = "scenario-chip manage";
  manageBtn.textContent = "⚙";
  manageBtn.title = "管理场景";
  manageBtn.addEventListener("click", toggleScenarioManager);

  scenarioBarEl.replaceChildren(...chips, manageBtn);
}

function toggleScenarioManager() {
  const visible = scenarioManagerEl.classList.toggle("visible");
  if (visible) renderScenarioManager();
}

function renderScenarioManager() {
  if (!scenarioManagerEl.classList.contains("visible")) return;

  const rows = scenarios.map((s) => {
    const row = document.createElement("div");
    row.className = "scenario-row";

    const nameEl = document.createElement("span");
    nameEl.className = "scenario-row-name";
    nameEl.textContent = s.name;
    nameEl.title = s.prompt;

    const editBtn = document.createElement("button");
    editBtn.textContent = "✎";
    editBtn.title = "编辑";
    editBtn.addEventListener("click", () => openScenarioForm(s));

    const delBtn = document.createElement("button");
    delBtn.textContent = "×";
    delBtn.title = "删除";
    delBtn.addEventListener("click", () => {
      chrome.storage.local.set({ scenarios: scenarios.filter((x) => x.id !== s.id) });
    });

    row.append(nameEl, editBtn, delBtn);
    return row;
  });

  const addBtn = document.createElement("button");
  addBtn.id = "scenario-add";
  addBtn.textContent = "＋ 新建场景";
  addBtn.addEventListener("click", () => openScenarioForm(null));

  scenarioListEl.replaceChildren(...rows, addBtn);
}

function openScenarioForm(scenario) {
  editingScenarioId = scenario ? scenario.id : null;
  scenarioNameEl.value = scenario ? scenario.name : "";
  scenarioPromptEl.value = scenario ? scenario.prompt : "";
  scenarioFormErrEl.textContent = "";
  scenarioFormEl.classList.add("visible");
  scenarioNameEl.focus();
}

document.getElementById("scenario-save").addEventListener("click", () => {
  const name = scenarioNameEl.value.trim();
  const prompt = scenarioPromptEl.value.trim();
  if (!name || !prompt) {
    scenarioFormErrEl.textContent = "名称和提示词都不能为空";
    return;
  }
  // 编辑目标已被删除时按新建处理
  const exists = editingScenarioId && scenarios.some((s) => s.id === editingScenarioId);
  const next = exists
    ? scenarios.map((s) => (s.id === editingScenarioId ? { ...s, name, prompt } : s))
    : [...scenarios, { id: crypto.randomUUID(), name, prompt }];
  chrome.storage.local.set({ scenarios: next });
  scenarioFormEl.classList.remove("visible");
});

document.getElementById("scenario-cancel").addEventListener("click", () => {
  scenarioFormEl.classList.remove("visible");
});
```

- [ ] **Step 2: 语法检查**

Run: `node --check extension/panel.js`
Expected: 无输出（exit 0）

- [ ] **Step 3: Commit**

```bash
git add extension/panel.js
git commit -m "feat: 场景库播种、胶囊渲染与管理视图增删改"
```

---

### Task 4: panel.js — doSend 注入与新对话重置

**Files:**
- Modify: `extension/panel.js`（`doSend` 开头、`done` 分支、`port.postMessage`、`newChatBtn` 回调）

- [ ] **Step 1: doSend 开头计算注入并改 user 气泡文案**

将：

```js
function doSend() {
  if (isStreaming) return;
  const question = questionEl.value.trim();
  const context = buildContext();
  if (!question && !context) return;

  const ctxLabel = selections.length > 1 ? `${selections.length} 段上下文` : "上下文";
  addMsg("user", context ? `📎 ${ctxLabel} + ${question || "（分析选中内容）"}` : question);
```

替换为：

```js
function doSend() {
  if (isStreaming) return;
  const question = questionEl.value.trim();
  const context = buildContext();
  if (!question && !context) return; // 仅激活场景不构成发送条件

  // 场景注入：会话级只注入一次；按 id+prompt 快照比较，切换场景/编辑提示词后下一条消息重新注入
  const activeScenario = scenarios.find((s) => s.id === activeScenarioId) || null;
  const needInject = !!activeScenario && (!injectedScenario ||
    injectedScenario.id !== activeScenario.id || injectedScenario.prompt !== activeScenario.prompt);
  const scenario = needInject ? activeScenario.prompt : "";

  const ctxLabel = selections.length > 1 ? `${selections.length} 段上下文` : "上下文";
  const baseMsg = context ? `📎 ${ctxLabel} + ${question || "（分析选中内容）"}` : question;
  addMsg("user", needInject ? `🎭 ${activeScenario.name} + ${baseMsg}` : baseMsg);
```

- [ ] **Step 2: done 分支确认注入快照（发送失败时不标记，重试会重新注入）**

将 `port.onMessage` 监听器中：

```js
    } else if (msg.type === "done") {
      if (msg.sessionId) sessionId = msg.sessionId; // 记住会话，下一轮续聊
      finish();
```

替换为：

```js
    } else if (msg.type === "done") {
      if (msg.sessionId) sessionId = msg.sessionId; // 记住会话，下一轮续聊
      if (needInject) injectedScenario = { id: activeScenario.id, prompt: activeScenario.prompt };
      finish();
```

- [ ] **Step 3: 发送消息携带 scenario**

将：

```js
  port.postMessage({ context, question, sessionId });
```

替换为：

```js
  port.postMessage({ context, question, scenario, sessionId });
```

- [ ] **Step 4: 新对话重置注入快照（激活状态保留）**

在 `newChatBtn` 回调中 `sessionId = null;` 之后插入一行：

```js
  injectedScenario = null; // 新会话需重新注入场景；激活状态保留，继续用同场景不必重选
```

- [ ] **Step 5: 语法检查**

Run: `node --check extension/panel.js`
Expected: 无输出（exit 0）

Run: `grep -n "scenario" extension/panel.js | head -40`
Expected: 变量与函数命名一致（`scenarios` / `activeScenarioId` / `injectedScenario` / `activeScenario` / `needInject`），无未定义引用

- [ ] **Step 6: Commit**

```bash
git add extension/panel.js
git commit -m "feat: 会话级场景注入（一次注入、切换/编辑重注入、新对话重置）"
```

---

### Task 5: 手动验收 + CHANGELOG/版本号 + 合并

**Files:**
- Modify: `CHANGELOG.md`、`extension/manifest.json`（version → 1.5.0）

- [ ] **Step 1: 重载扩展**

`chrome://extensions` → Claude Sidekick → 刷新 ↻，并刷新测试网页（淘汰孤儿 content script）。
host.js 无需重新注册（wrapper 每次拉起读取最新文件）。

- [ ] **Step 2: 逐项执行 spec 12 条验收清单**

见 `docs/superpowers/specs/2026-06-12-custom-scenarios-design.md` 测试策略一节。

- [ ] **Step 3: 验收通过后更新 CHANGELOG 与版本号**

`extension/manifest.json` 的 `"version"` 改为 `"1.5.0"`；CHANGELOG.md 按现有格式新增 v1.5.0 条目
（新增：自定义场景——会话级注入/中途切换/侧边栏管理/预置 4 个；调整：host prompt 分段拼接）。

```bash
git add CHANGELOG.md extension/manifest.json
git commit -m "docs: v1.5.0 变更记录与版本号（自定义场景）"
```

- [ ] **Step 4: 合并回 main**

```bash
git checkout main
git merge --ff-only feat/custom-scenarios
```
