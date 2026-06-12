# host 文件日志与自动清理 — 设计文档

日期：2026-06-12
状态：已确认（用户同意）

## 背景与目标

host 的调试输出只走 stderr，进 Chrome 日志后难以查看；发给 Claude 的最终 prompt
没有任何记录，无法验证「上下文/场景一次注入」等行为。本功能给 host 增加**默认开启**
的文件日志，并内置自动清理规则，磁盘占用恒定有界。

## 非目标

- 扩展侧（panel/background/content）日志——浏览器 DevTools 已覆盖
- 日志查看 UI、远程上报、按级别过滤

## 设计

### 位置与开关

- 日志目录：`<host.js 同目录>/logs/`，文件 `host.log`；`logs/` 加入 `.gitignore`
- 默认开启；包装器（host.sh / host.bat）里设 `CLAUDE_LOG=0` 可整体关闭
- 注意：日志含 prompt 全文（即选中的页面原文），介意者用开关关闭

### 记录内容（每行 ISO 时间戳前缀）

| 事件 | 内容 |
|------|------|
| `[ask]` | resume id、context/scenario 字数、question 原文 |
| `[prompt]` | 发给 claude 的完整 prompt（`----------` 分隔多行） |
| `[claude stderr]` | CLI 的 stderr 转发（复用现有 logErr 调用点） |
| `[done]` | 退出码、session id、耗时、输出字数 |
| `[error]` | claude 启动失败等异常 |

`ping` 健康检查不记录（噪音）。`logErr()` 改造为同时写 stderr（行为不变）+ 文件。

### 清除规则

host 是按提问拉起的短命进程，**启动时**是唯一可靠的清理时机：

- 启动时 `host.log` 超过 **2MB** → 改名为 `host.log.old`（先删旧 .old 再改名，
  兼容 Windows rename 不覆盖的语义），重开新文件
- 磁盘占用上限 ≈ 4MB（当前 + 一份历史），无定时任务、无需手动清理

### 错误处理

- 日志目录创建失败 / 写入失败 → 静默降级为仅 stderr，**绝不影响问答主流程**
- 轮转失败（rename 异常）→ 忽略，继续追加写原文件

## 改动文件

| 文件 | 改动 |
|------|------|
| `host.js` | 日志初始化/轮转/写入（≈40 行），runClaude 增加 4 个记录点 |
| `.gitignore` | 增加 `logs/` |
| `README.md` | 补「日志」一节：位置、开关、清理规则 |

## 手动验收

1. 提问一次 → `logs/host.log` 出现 `[ask]`/`[prompt]`/`[done]` 三行（组）
2. 追问（上下文已注入）→ `[ask]` 行 ctx=0字，`[prompt]` 不含选段 —— 顺带验证一次注入
3. 包装器加 `CLAUDE_LOG=0` → 不再写文件，stderr 行为不变
4. 把 host.log 人工填到 >2MB → 下次提问后出现 host.log.old，新 host.log 从头开始
5. `chmod -w logs/` 后提问 → 问答正常，无文件写入（静默降级）
