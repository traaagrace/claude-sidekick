#!/usr/bin/env node
/**
 * Claude Sidekick - 卸载脚本（Windows / macOS / Linux）
 * 用法：node uninstall.js（Windows 也可直接双击 uninstall.cmd）
 * 删除 native host 注册（含旧版 Claude Helper 残留）及 install.js 生成的本地文件。
 * Chrome 插件本身请到 chrome://extensions 手动移除。
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

// 同时清理旧版名字，避免历史残留
const HOST_NAMES = ["com.claude.sidekick", "com.claude.helper"];
const here = __dirname;
const isWin = process.platform === "win32";
const isMac = process.platform === "darwin";

let removedCount = 0;

if (isWin) {
  // Windows：删除 HKCU 注册表项（用户级，无需管理员）
  for (const name of HOST_NAMES) {
    const key = `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${name}`;
    const query = spawnSync("reg", ["query", key], { encoding: "utf8" });
    if (query.status !== 0) continue; // 不存在，跳过

    const del = spawnSync("reg", ["delete", key, "/f"], { encoding: "utf8" });
    if (del.status === 0) {
      console.log("已删除注册表项：" + key);
      removedCount++;
    } else {
      console.error("删除失败：" + key, del.stderr || del.stdout);
    }
  }
} else {
  // macOS / Linux：删除 Chrome 目录里的 host 清单文件
  const dir = isMac
    ? path.join(os.homedir(), "Library", "Application Support", "Google", "Chrome", "NativeMessagingHosts")
    : path.join(os.homedir(), ".config", "google-chrome", "NativeMessagingHosts");
  for (const name of HOST_NAMES) {
    const manifestPath = path.join(dir, `${name}.json`);
    if (fs.existsSync(manifestPath)) {
      fs.unlinkSync(manifestPath);
      console.log("已删除清单：" + manifestPath);
      removedCount++;
    }
  }
}

// 清理 install.js 在本目录生成的包装器和清单
const generatedFiles = ["host.bat", "host.sh", ...HOST_NAMES.map((n) => `${n}.json`)];
for (const file of generatedFiles) {
  const p = path.join(here, file);
  if (fs.existsSync(p)) {
    fs.unlinkSync(p);
    console.log("已删除文件：" + p);
  }
}

if (removedCount > 0) {
  console.log("\n✅ 卸载完成。");
} else {
  console.log("\n未发现已注册的 host（可能已卸载过）。");
}
console.log("Chrome 插件请到 chrome://extensions 手动移除。");
