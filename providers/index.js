/**
 * Provider 注册表。
 * 新增一个后端 = 新增一个文件 + 在此注册一行。
 * host.js 只通过 get(id) 拿 provider，与具体后端解耦。
 */

const claude = require("./claude");
const codex = require("./codex");

const registry = { claude, codex };

// 默认 claude：未指定或未知 provider 时回退，保证向后兼容
function get(id) {
  return registry[id] || claude;
}

module.exports = { get, registry, DEFAULT: "claude" };
