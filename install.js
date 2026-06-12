#!/usr/bin/env node
/**
 * Claude Sidekick - Native Messaging Host 安装脚本（Windows / macOS / Linux）
 * 用法：node install.js <Chrome插件ID>
 * 插件 ID：chrome://extensions 开启「开发者模式」后，在插件卡片上可见（32 位小写字母）
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execSync, spawnSync } = require("child_process");

const HOST_NAME = "com.claude.sidekick";
const extId = (process.argv[2] || "").trim();

if (!/^[a-p]{32}$/.test(extId)) {
  console.error("用法：node install.js <Chrome插件ID>");
  console.error("插件 ID 是 32 位小写字母，在 chrome://extensions 开启开发者模式后可见");
  process.exit(1);
}

const here = __dirname;
const isWin = process.platform === "win32";
const isMac = process.platform === "darwin";
const nodePath = process.execPath;

// 找 claude CLI 的绝对路径（Chrome 启动的进程拿不到 shell 的 PATH，必须写死）
function findClaude() {
  try {
    const cmd = isWin ? "where claude" : "which claude";
    const found = execSync(cmd, { encoding: "utf8" }).split(/\r?\n/).filter(Boolean)[0];
    if (found && fs.existsSync(found)) return found;
  } catch {
    // 不在 PATH 里，继续查常见安装位置
  }
  const candidates = isWin
    ? [path.join(os.homedir(), "AppData", "Roaming", "npm", "claude.cmd")]
    : [
        "/opt/homebrew/bin/claude",
        "/usr/local/bin/claude",
        path.join(os.homedir(), ".local", "bin", "claude"),
        path.join(os.homedir(), ".claude", "local", "claude"),
      ];
  return candidates.find((p) => fs.existsSync(p)) || null;
}

const claudePath = findClaude();
if (!claudePath) {
  console.warn("⚠️  未找到 claude CLI，host 将依赖系统 PATH（Mac 上大概率失败，建议先装好再重跑）");
}

// 1. 生成启动包装器（node/claude 绝对路径写死，避免 PATH 问题）
let wrapperPath;
if (isWin) {
  wrapperPath = path.join(here, "host.bat");
  const lines = ["@echo off"];
  if (claudePath) lines.push(`set "CLAUDE_CLI=${claudePath}"`);
  lines.push(`"${nodePath}" "${path.join(here, "host.js")}" %*`);
  fs.writeFileSync(wrapperPath, lines.join("\r\n") + "\r\n");
} else {
  wrapperPath = path.join(here, "host.sh");
  const lines = ["#!/bin/sh"];
  if (claudePath) {
    lines.push(`export CLAUDE_CLI="${claudePath}"`);
    lines.push(`export PATH="${path.dirname(claudePath)}:${path.dirname(nodePath)}:$PATH"`);
  }
  lines.push(`exec "${nodePath}" "${path.join(here, "host.js")}" "$@"`);
  fs.writeFileSync(wrapperPath, lines.join("\n") + "\n", { mode: 0o755 });
}

// 2. 生成 host 清单
const manifest = {
  name: HOST_NAME,
  description: "Claude Sidekick bridge (native messaging)",
  path: wrapperPath,
  type: "stdio",
  allowed_origins: [`chrome-extension://${extId}/`],
};

// 3. 注册到 Chrome
if (isWin) {
  // Windows：清单放在项目目录，注册表 HKCU 指向它（用户级，无需管理员）
  const manifestPath = path.join(here, `${HOST_NAME}.json`);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  const r = spawnSync(
    "reg",
    ["add", `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`, "/ve", "/t", "REG_SZ", "/d", manifestPath, "/f"],
    { encoding: "utf8" }
  );
  if (r.status !== 0) {
    console.error("写注册表失败：", r.stderr || r.stdout);
    process.exit(1);
  }
  console.log(`已注册：HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`);
} else {
  // macOS / Linux：清单直接放进 Chrome 的 NativeMessagingHosts 目录，无注册表
  const dir = isMac
    ? path.join(os.homedir(), "Library", "Application Support", "Google", "Chrome", "NativeMessagingHosts")
    : path.join(os.homedir(), ".config", "google-chrome", "NativeMessagingHosts");
  fs.mkdirSync(dir, { recursive: true });
  const manifestPath = path.join(dir, `${HOST_NAME}.json`);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  console.log("已写入清单：" + manifestPath);
}

console.log(`
✅ 安装完成
   node:    ${nodePath}
   claude:  ${claudePath || "（未找到，依赖 PATH）"}
   wrapper: ${wrapperPath}

下一步：
1. chrome://extensions → Claude Sidekick → 点「刷新 ↻」重载插件
2. 打开侧边栏，状态显示「已就绪」即成功
（以后不再需要手动启动任何服务，Chrome 会按需自动拉起/销毁 host）

提示：插件重新加载到不同目录后 ID 会变，届时重跑一次本脚本即可。
卸载：Windows 删除上述注册表项；Mac/Linux 删除上述清单文件。
`);
