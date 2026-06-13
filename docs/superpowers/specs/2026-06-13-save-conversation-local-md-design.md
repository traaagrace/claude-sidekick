# 研究会话保存到本地 Markdown — 设计文档

日期：2026-06-13
状态：已确认（用户同意）

## 背景与目标

完成一个话题研究后，会话目前只活在面板 DOM 里（`.msg` 的 `dataset.raw`），关面板或点
「新对话」即丢失。本功能在 header 增加一个手动「↗ 存本地」按钮：把当前会话整理成一篇
研究笔记（Claude 生成的总结 + 原始对话附录），写成本地 Markdown 文件，路径回显到面板。

原计划同步到飞书（lark-cli），因 cli 安装/授权/`claude -p` 工具权限三道坎受阻，改为
**本地落盘**——host 本就有文件写权限（已用于日志），无需任何外部服务、授权或工具权限。

## 非目标

- 同步到飞书 / 云端（已放弃，本地优先）
- 自动保存（仅手动按钮触发；「新对话时自动存」留待后续）
- 保存目录可配置（v1 固定 `notes/`；环境变量配置留待后续）
- 文件管理 UI、历史列表、去重

## 设计

### 触发与数据流

```
panel [↗ 存本地 按钮]
  → 校验：非生成中、有对话（getTranscript() 非空）
  → connect("claude-stream")，post {type:"save", transcript, sessionId}
background  → 按 msg.type 透传给 host（不再写死 "ask"）
host.js runSave(transcript, sessionId):
  ① claude -p --resume <sessionId> 生成总结（纯文本，不加 --allowedTools）
     ├ text_delta 流式转发面板（实时看到总结生成）
     └ host 同步累积总结全文
  ② 拼 Markdown：标题 + ## 总结 + ## 原始对话
  ③ fs.writeFileSync 写 notes/YYYYMMDD-HHMMSS-<slug>.md（mkdir -p）
  ④ 回帧 {type:"saved", path} → {type:"done"}
panel：流式气泡显示总结，结尾追加「✅ 已保存到 notes/xxx.md」
```

### 各组件改动

**panel.html / panel.js**
- header 加 `↗ 存本地` 按钮（id `save-local`），与 copy-all / new-chat 同排。
- 点击：`isStreaming` 时忽略；`getTranscript()` 为空 → 状态提示「还没有可保存的对话」，
  不开 port；否则开流式 port，post `{type:"save", transcript, sessionId}`。
- 复用现有流式渲染：总结作为 `chunk` 流入一个新 assistant 气泡；收到 `saved` 时在气泡
  尾部追加文件路径行；`done` 收尾。
- session 推进：保存复用 `--resume` 会给 session 加一轮，`done` 带回的 sessionId 回写
  面板 `sessionId`（与 ask 一致，保持会话线性）。

**background.js**
- `claude-stream` 的 onConnect 当前写死 `native.postMessage({type:"ask", ...})`，
  改为按收到的 `msg.type` 透传（`ask` / `save` 共用同一条流式通道）。

**host.js**
- `handleMessage` 增加 `if (msg.type === "save") { runSave(msg.transcript, msg.sessionId); return; }`
- `runSave(transcript, resumeId)`：
  - 总结 prompt：「把我们刚才整场讨论总结成一篇结构化研究笔记（标题/背景/要点/结论），
    只输出笔记正文的 Markdown，不要复述原始对话。」；`resumeId` 无效时把 transcript
    内联进 prompt。
  - args：`-p --output-format stream-json --verbose` + 支持时 `--include-partial-messages`
    + 有效时 `--resume`。**不加 `--allowedTools`**（纯文本生成，不需工具权限）。
  - 流式：`text_delta` 转发 `chunk` 并累积到 `summary`。
  - 收尾（claude close）：
    - 标题：取 `summary` 首个非空行去掉 `#`，截断 ~40 字；取不到用 `研究笔记`。
    - slug：标题中非字母数字/中日韩字符替换为 `-`，截断 ~40 字。
    - 文件内容：`# <标题>\n\n_<本地时间戳>_\n\n## 总结\n\n<summary>\n\n---\n\n## 原始对话\n\n<transcript>\n`
    - 文件名：`<YYYYMMDD>-<HHMMSS>-<slug>.md`，目录 `path.join(__dirname,"notes")`，
      `fs.mkdirSync(dir,{recursive:true})`。
    - 回帧 `{type:"saved", path: 相对路径}`，再 `{type:"done", sessionId}`。
  - host.js 是普通 Node 进程，可直接用 `new Date()` 生成时间戳/文件名。
- 日志：复用现有文件日志，增加 `[save]`（resume、字数）与 `[saved]`（路径、耗时）记录点。

### 文件格式

```markdown
# <话题标题>

_2026-06-13 15:04:02_

## 总结
<Claude 生成的研究笔记>

---

## 原始对话
我:
...
Claude:
...
```

### 错误处理（绝不让点击白费）

- **无对话** → 按钮校验拦截，状态提示，不开 port。
- **总结生成失败**（claude 非零退出 / `summary` 为空）→ **降级仍写盘**：文件 `## 总结`
  段写「（总结生成失败，仅保留原始对话）」，原始对话照常写入。数据不丢。
- **写盘失败**（权限 / 磁盘）→ 回帧 `{type:"error"}`，面板显示原因。
- **面板中途关闭** → 现有 onDisconnect 杀 host；已写入的文件保留。

### .gitignore

`notes/` 加入 `.gitignore`（与 `logs/` 同理，用户数据不入库）。

## 改动文件

| 文件 | 改动 |
|------|------|
| `extension/panel.html` | header 加「↗ 存本地」按钮 |
| `extension/panel.js` | 按钮校验、发 save、流式总结气泡 + 路径回显、sessionId 回写 |
| `extension/background.js` | onConnect 按 type 透传（ask/save 共用通道） |
| `host.js` | `save` 分支 + `runSave()`（总结 → 拼文件 → 写盘 → 回帧），2 个日志点 |
| `.gitignore` | 增加 `notes/` |
| `README.md` / `CHANGELOG.md` | 补「保存到本地」一节与版本记录 |

## 手动验收

1. 跑一段研究 → 点「↗ 存本地」→ 面板流式显示总结，结尾出现「✅ 已保存到 notes/xxx.md」。
2. 打开该 `.md` → 含 `# 标题`、`## 总结`、`## 原始对话`，原文与面板一致。
3. 无对话时点按钮 → 按钮禁用 / 提示「还没有可保存的对话」，不生成文件。
4. 断网或令 claude 失败 → 文件仍生成，`## 总结` 段标注失败，原始对话完整。
5. `chmod -w notes/` 后保存 → 面板显示写盘失败原因，问答主流程不受影响。
6. 旧版 CLI（无 `--resume`）→ 降级把 transcript 内联进总结 prompt，仍能保存。
