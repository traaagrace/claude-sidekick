# host 文件日志 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** host 增加默认开启的文件日志（ask/prompt/stderr/done/error 五类事件），启动时按 2MB 轮转，磁盘占用上限 ≈4MB。

**Architecture:** `host.js` 启动时初始化日志（建目录 → 超限轮转 → 追加写流）；`logErr()` 改为 stderr+文件双写；`runClaude` 增加 4 个记录点。任何日志失败静默降级为仅 stderr。

**Tech Stack:** Node 内置 `fs`/`path`，零新依赖

**Spec:** `docs/superpowers/specs/2026-06-12-host-file-logging-design.md`

---

### Task 1: host.js 日志设施与记录点

**Files:**
- Modify: `host.js:9-24`（require 与 logErr）、`host.js:77-99`（runClaude 记录点）、`host.js:136-149`（close/error 记录点）
- Modify: `.gitignore`（新增 `logs/`，文件不存在则创建）

- [ ] **Step 1: 日志初始化与双写**

将 `host.js` 的：

```js
const { spawn } = require("child_process");

// install.js 会在包装器里写入 claude 的绝对路径（Chrome 启动的进程拿不到 shell 的 PATH）
const CLAUDE = process.env.CLAUDE_CLI || "claude";
```

替换为：

```js
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

// install.js 会在包装器里写入 claude 的绝对路径（Chrome 启动的进程拿不到 shell 的 PATH）
const CLAUDE = process.env.CLAUDE_CLI || "claude";

// ---------- 文件日志 ----------
// 默认开启，包装器里设 CLAUDE_LOG=0 可关闭；日志含 prompt 全文（选中的页面原文）
// 清除规则：host 每次启动检查 host.log 超过 2MB 即轮转为 host.log.old（覆盖旧的），
// 磁盘占用上限 ≈ 4MB。任何日志失败静默降级为仅 stderr，不影响问答主流程。
const LOG_MAX_BYTES = 2 * 1024 * 1024;
const LOG_FILE = path.join(__dirname, "logs", "host.log");

let logStream = null;
if (process.env.CLAUDE_LOG !== "0") {
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    let size = 0;
    try { size = fs.statSync(LOG_FILE).size; } catch { /* 文件尚不存在 */ }
    if (size > LOG_MAX_BYTES) {
      // Windows 的 rename 不覆盖已存在目标，先删旧 .old
      fs.rmSync(LOG_FILE + ".old", { force: true });
      fs.renameSync(LOG_FILE, LOG_FILE + ".old");
    }
    logStream = fs.createWriteStream(LOG_FILE, { flags: "a" });
    logStream.on("error", () => (logStream = null));
  } catch {
    logStream = null;
  }
}

function logFile(text) {
  if (!logStream) return;
  try {
    logStream.write(`${new Date().toISOString()} ${text}\n`);
  } catch {
    logStream = null;
  }
}
```

并把 `logErr` 改为双写（stderr 行为不变）：

```js
function logErr(...parts) {
  const line = parts.join(" ");
  process.stderr.write(line + "\n");
  logFile(line);
}
```

- [ ] **Step 2: runClaude 记录 ask 与 prompt**

在 `const prompt = sections.join("\n\n");` 之后插入：

```js
  const startedAt = Date.now();
  logFile(`[ask] resume=${resumeId || "无"} ctx=${(context || "").length}字 scenario=${(scenario || "").length}字 q=${question || "（空）"}`);
  logFile(`[prompt] ----------\n${prompt}\n----------`);
```

- [ ] **Step 3: close/error 记录点**

`child.on("close", ...)` 中 `send({ type: "done", ... })` 之前插入：

```js
    logFile(`[done] code=${code} session=${lastSessionId || "无"} 耗时=${((Date.now() - startedAt) / 1000).toFixed(1)}s 输出=${sentChars}字`);
```

`child.on("error", ...)` 中 `send({ type: "error", ... })` 之前插入：

```js
    logFile(`[error] 无法启动 claude：${err.message}`);
```

- [ ] **Step 4: .gitignore 增加 logs/**

仓库根 `.gitignore`（不存在则创建）追加一行：

```
logs/
```

- [ ] **Step 5: 语法检查 + 本地冒烟**

Run: `node --check host.js`
Expected: exit 0

Run: `node -e "const cp=require('child_process');const h=cp.spawn('node',['host.js']);const b=Buffer.from(JSON.stringify({type:'ping'}));const l=Buffer.alloc(4);l.writeUInt32LE(b.length,0);h.stdin.write(Buffer.concat([l,b]));setTimeout(()=>h.kill(),500);"`（在仓库根执行）
Expected: 退出后 `logs/` 目录存在（ping 不写日志行，仅验证初始化不抛错）

- [ ] **Step 6: Commit**

```bash
git add host.js .gitignore
git commit -m "feat: host 文件日志（默认开启、2MB 轮转、失败静默降级）"
```

---

### Task 2: README 补「日志」一节

**Files:**
- Modify: `README.md`（「可选配置」一节之后）

- [ ] **Step 1: 插入日志说明**

在「## 可选配置」小节末尾（「## 卸载」之前）插入：

```markdown
## 日志

host 默认把执行日志写到仓库的 `logs/host.log`（含发给 Claude 的完整 prompt、
耗时、退出码与 CLI 报错），用于排查与验证注入行为：

- 超过 2MB 自动轮转为 `host.log.old`（仅保留一份历史，磁盘占用上限 ≈ 4MB）
- 不想记录：编辑包装器（`host.bat` / `host.sh`）加 `CLAUDE_LOG=0` 环境变量
- 日志包含选中的页面原文，注意隐私
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: README 日志说明"
```

---

### Task 3: 手动验收（spec 5 条）

1. 提问一次 → `logs/host.log` 出现 `[ask]`/`[prompt]`/`[done]`
2. 追问 → `[ask]` 行 ctx=0字、`[prompt]` 不含选段（顺带验证一次注入）
3. `CLAUDE_LOG=0` → 不写文件，stderr 不变
4. host.log 填到 >2MB → 下次提问出现 host.log.old
5. `chmod -w logs/` → 问答正常（静默降级）
