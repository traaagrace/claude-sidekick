const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { randomUUID } = require("node:crypto");

// 执行真实 background，模拟异步 storage，覆盖模式切换与连续划词的写入顺序。
function createBackground(session = {}, local = {}) {
  const state = { session: structuredClone(session), local: structuredClone(local) };
  const listeners = [];
  const menuListeners = [];
  const opened = [];
  const storage = (area) => ({
    async get(keys) {
      await Promise.resolve();
      return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((key) => [key, state[area][key]]));
    },
    async set(values) {
      await Promise.resolve();
      Object.assign(state[area], structuredClone(values));
    },
  });
  const context = vm.createContext({
    console, crypto: { randomUUID },
    chrome: {
      storage: { session: storage("session"), local: storage("local") },
      runtime: {
        onInstalled: { addListener() {} },
        onConnect: { addListener() {} },
        onMessage: { addListener(fn) { listeners.push(fn); } },
      },
      contextMenus: { onClicked: { addListener(fn) { menuListeners.push(fn); } } },
      action: { onClicked: { addListener() {} } },
      sidePanel: { open(options) { opened.push(options); } },
    },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../extension/background.js"), "utf8"), context);
  return {
    state, opened,
    select(text, viaMenu = false) {
      if (viaMenu) menuListeners[0]({ menuItemId: "ask-claude", selectionText: text }, { id: 7 });
      else listeners.forEach((fn) => fn({ type: "SELECTED_TEXT", text }, { tab: { id: 7 } }, () => {}));
      return vm.runInContext("writeQueue", context);
    },
    mode(mode) {
      return new Promise((resolve) => {
        listeners.forEach((fn) => fn({ type: "SET_SELECTION_MODE", mode }, {}, resolve));
      });
    },
  };
}

const first = { id: "first", text: "第一段上下文", addedAt: 1 };
const second = { id: "second", text: "第二段上下文", addedAt: 2 };

test("默认多选：连续划词累积，重复内容去重，同步打开侧栏", async () => {
  const app = createBackground();
  const pending = app.select(first.text);
  assert.equal(app.opened.length, 1, "打开侧栏必须保留用户手势，不能排进写入队列");
  await Promise.all([pending, app.select(second.text), app.select(first.text)]);
  assert.deepEqual(app.state.session.selections.map((s) => s.text), [first.text, second.text]);
});

test("单选：浮动按钮和右键入口均直接替换，无需清空", async () => {
  const app = createBackground({ selections: [first], replaceTargetId: first.id }, { selectionMode: "single" });
  await app.select(second.text);
  assert.deepEqual(app.state.session.selections.map((s) => s.text), [second.text]);
  assert.equal(app.state.session.replaceTargetId, null);
  await app.select(first.text, true);
  assert.deepEqual(app.state.session.selections.map((s) => s.text), [first.text]);
  await app.select(first.text);
  assert.equal(app.state.session.selections.length, 1);
});

test("多选切单选：按时间保留最近新增或替换的选段，清除待替换标记", async () => {
  const recent = { ...first, addedAt: 3 };
  const app = createBackground({ selections: [recent, second], replaceTargetId: second.id });
  assert.equal((await app.mode("single")).ok, true);
  assert.deepEqual(app.state.session.selections, [recent]);
  assert.equal(app.state.session.replaceTargetId, null);
  assert.equal(app.state.local.selectionMode, "single");
});

test("快速切换模式并连续划词：按操作顺序应用单选和多选", async () => {
  const app = createBackground({ selections: [first, second] });
  await Promise.all([app.mode("single"), app.select("新的单选内容"), app.select("最后的单选内容")]);
  assert.deepEqual(app.state.session.selections.map((s) => s.text), ["最后的单选内容"]);
  await Promise.all([app.mode("multi"), app.select("新增多选内容")]);
  assert.deepEqual(app.state.session.selections.map((s) => s.text), ["最后的单选内容", "新增多选内容"]);
});

test("空上下文可以切单选，持久化模式在 background 重启后仍生效", async () => {
  const app = createBackground();
  await app.mode("single");
  assert.deepEqual(app.state.session.selections, []);
  const restarted = createBackground(app.state.session, app.state.local);
  await Promise.all([restarted.select(first.text), restarted.select(second.text)]);
  assert.deepEqual(restarted.state.session.selections.map((s) => s.text), [second.text]);
});

test("多选保留单段替换与去重行为", async () => {
  const app = createBackground({ selections: [first, second], replaceTargetId: first.id });
  await app.select(second.text);
  assert.equal(app.state.session.replaceTargetId, first.id, "去重不应取消待替换状态");
  await app.select("替换后的内容");
  assert.deepEqual(app.state.session.selections.map((s) => s.text), ["替换后的内容", second.text]);
  assert.equal(app.state.session.selections[0].id, first.id);
  assert.equal(app.state.session.replaceTargetId, null);
});

test("无效模式不修改存储", async () => {
  const app = createBackground({ selections: [first, second] });
  assert.equal((await app.mode("unknown")).ok, false);
  assert.deepEqual(app.state.session.selections, [first, second]);
  assert.equal(app.state.local.selectionMode, undefined);
});
