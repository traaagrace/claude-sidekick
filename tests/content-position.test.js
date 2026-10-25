const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../extension/content.js"), "utf8");

// 运行真实 content 脚本，使用固定按钮尺寸验证四角的优先顺序和边界。
function showButton(rect, scrollY = 0) {
  const listeners = {};
  let button;
  vm.runInNewContext(source, {
    console,
    setTimeout(fn) { fn(); },
    window: {
      innerHeight: 600, scrollY,
      getSelection() {
        return {
          toString: () => "选中的页面文本",
          rangeCount: 1,
          getRangeAt: () => ({ getBoundingClientRect: () => rect }),
        };
      },
      addEventListener() {},
    },
    document: {
      documentElement: { clientWidth: 800 },
      addEventListener(name, fn) { listeners[name] = fn; },
      createElement() {
        return {
          style: {},
          addEventListener() {},
          getBoundingClientRect: () => ({ width: 80, height: 28 }),
        };
      },
      body: { appendChild(element) { button = element; } },
    },
  });
  listeners.mouseup({});
  return button.style;
}

test("划词按钮优先位于选区右下角", () => {
  const style = showButton({ left: 200, right: 250, top: 200, bottom: 220 });
  assert.equal(style.left, "258px");
  assert.equal(style.top, "228px");
  assert.equal(style.visibility, "visible");
});

test("右下角超出右边界时，优先使用左下角", () => {
  const style = showButton({ left: 730, right: 770, top: 200, bottom: 220 });
  assert.equal(style.left, "642px");
  assert.equal(style.top, "228px");
});

test("下方超出屏幕时，优先使用右上角", () => {
  const style = showButton({ left: 200, right: 250, top: 550, bottom: 570 });
  assert.equal(style.left, "258px");
  assert.equal(style.top, "514px");
});

test("右下、左下、右上均超出屏幕时，使用左上角", () => {
  const style = showButton({ left: 730, right: 770, top: 550, bottom: 570 });
  assert.equal(style.left, "642px");
  assert.equal(style.top, "514px");
});

test("四角均放不下时，按钮仍限制在屏幕内", () => {
  const style = showButton({ left: 0, right: 800, top: 260, bottom: 300 });
  assert.equal(style.left, "8px");
  assert.equal(style.top, "224px");
});

test("滚动页面后仍使用选区视口坐标", () => {
  const style = showButton({ left: 200, right: 250, top: 200, bottom: 220 }, 1000);
  assert.equal(style.left, "258px");
  assert.equal(style.top, "228px");
});
