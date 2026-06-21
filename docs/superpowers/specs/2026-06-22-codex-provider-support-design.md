# 多后端支持（Codex Provider 抽象）— 设计文档

日期：2026-06-22
状态：已确认（用户同意架构方向，方案 B）

## 背景与目标

Sidekick 目前只能调用本机 Claude CLI 回答。目标是在**保持现有 Claude 行为逐字节不变**的前提下，
增加对 OpenAI **Codex CLI** 的支持，并把「后端」抽象成**可扩展、模块化**的 provider：
新增一个后端 = 新增一个文件 + 注册一行，host.js 主体与具体后端解耦。

用户在**面板内可切换** Claude ↔ Codex，选择持久化、运行时即时生效。
Native host 注册 ID `com.claude.sidekick` **保持不变**（现有安装零迁移）。

## 非目标

- 重命名 host ID / 改插件目录结构（保持 `com.claude.sidekick`）
- Codex 逐字流式（exec --json 不提供 token delta，见下文「关键约束」；app-server 长连接通道留待后续）
- 跨后端续聊（Claude 与 Codex 的 session 存储互不相通，物理上不可能）
- 安装时固定后端 / 第三个后端（接口预留，但本期只落 claude + codex）
- 后端各自的高级配置 UI（模型、sandbox 等通过环境变量，不做面板配置）

## 关键约束（来自 Codex CLI 实测接口）

| 维度 | Claude CLI | Codex CLI |
|------|-----------|-----------|
| 非交互命令 | `claude -p` | `codex exec` |
| 机器可读输出 | `--output-format stream-json --verbose`（NDJSON） | `--json`（JSONL） |
| 逐字增量 | `--include-partial-messages` → `stream_event.delta.text_delta` | **无**。整条回复作为单个 `item.completed`（`item.type==="agent_message"`，字段 `text`）在 turn 结束时发出 |
| 续聊 | `--resume <id>` 标志 | `exec resume <id>` **子命令** |
| session id 来源 | 事件 `session_id` | `thread.started` 事件的 `thread_id` |
| 模型 | `--model <m>`（env `CLAUDE_MODEL`） | `--model <m>`（env `CODEX_MODEL`） |
| 额外 | — | `--skip-git-repo-check`（跳过 git 仓库门禁）、`--sandbox read-only`（只读，纯问答不需写盘） |
| prompt 投喂 | stdin（防注入） | stdin（`codex exec -`，同样防注入） |
| 鉴权 | 复用本机 Claude 登录 | 复用本机 ChatGPT 登录 / `OPENAI_API_KEY` |

**核心结论**：Claude 与 Codex 的全部差异收敛为三件事——`buildArgs`（标志 vs 子命令）、
`parseLine`（`text_delta` 增量 vs `item.completed` 整段）、`probeStream`（true vs false）。
把这三件事锁进各自的 provider 文件，host.js 即与后端无关。

> ⚠️ 待实现阶段对实际 codex 版本核对两点（已隔离在 `providers/codex.js`，改动是局部的）：
> ① `codex exec -` 是否从 stdin 读取 prompt；② `exec resume <id>` 与 `--json` 等标志的精确拼接顺序。

## 设计

### Provider 接口（统一契约）

每个后端导出一个对象，实现下列契约。host.js 只面向该契约编程：

```
interface Provider {
  id: string                 // 'claude' | 'codex'，与消息里的 provider 字段对应
  label: string              // UI 显示名（'Claude' / 'Codex'）
  resolveBin(): string       // 读各自环境变量（CLAUDE_CLI / CODEX_CLI），缺省回退命令名
  resolveModel(): string|null// 读各自模型 env（CLAUDE_MODEL / CODEX_MODEL）
  probeStream(spawnHelper): Promise<boolean>   // 是否支持逐字流式（claude 探测 --help；codex 恒 false）
  buildArgs({ resumeId, model, stream }): string[]  // 生成 spawn 参数（含 resume 结构差异）
  isValidSessionId(id): boolean                // 各家 session id 校验（防 shell 注入，shell:true）
  parseLine(line): { sessionId?, text?, final?, error? } | null  // 解析一行 → 归一化事件
}
```

归一化事件语义：
- `sessionId`：记录供下一轮续聊
- `text` + `final:false`：逐字增量，立即转发并标记「已出文本」
- `text` + `final:true`：整条完整回复，**仅当本轮尚未出过文本时**才采用（兜底/Codex 路径）
- `error`：后端报告的失败（如 `turn.failed`）

### 文件结构

```
providers/
├── index.js     # 注册表：{ claude, codex }，get(id) 缺省回退 claude
├── claude.js    # 现有 Claude 行为，逐字节等价封装
└── codex.js     # Codex 适配器
host.js          # 通用引擎：prompt 拼装、流式循环、日志、存笔记、按 provider 分发
```

### host.js 通用引擎

抽出与后端无关的 `streamProvider(provider, prompt, resumeId, onChunk) → Promise<{text, sessionId, code}>`：

```
streamProvider(provider, prompt, resumeId, onChunk):
  bin   = provider.resolveBin()
  stream= await provider.probeStream(spawn)
  args  = provider.buildArgs({ resumeId: 有效则带, model: provider.resolveModel(), stream })
  child = spawn(bin, args, { shell:true });  child.stdin.write(prompt); end()
  逐行 NDJSON → provider.parseLine(line):
     r.sessionId → lastSessionId = r.sessionId
     r.text:
        final  → if(!gotText){ onChunk(text); full+=text; gotText=true }
        !final → onChunk(text); full+=text; gotText=true
     r.error → 记录
  close(code) → resolve({ text:full, sessionId:lastSessionId, code })
```

`runAsk` / `runSave` 变成薄封装：负责**拼 prompt**（场景/上下文逻辑不变）和**后处理**
（save 落盘 `notes/*.md`），中间统一调 `streamProvider`。日志、stdin 防注入、面板断开杀子进程等机制全部不动。

### 数据流（含后端选择）

```
panel header [后端选择器 Claude▾/Codex]
  → 选择持久化到 chrome.storage.local.provider（默认 'claude'）
  → 每条 ask/save 消息带 provider 字段
background → native.postMessage 透传 provider
host.handleMessage → providers.get(msg.provider || 'claude') → runAsk/runSave(provider, ...)
```

### 会话连续性（按 provider 归属）

panel 维护 `sessionId` 与其归属 `sessionProvider`。`doSend` 时若当前所选 provider ≠ `sessionProvider`
且已有 sessionId → 清空 sessionId 与已注入快照（场景/上下文重新注入到新后端），状态栏提示「已切换到 X，开启新会话」。
同后端内多轮续聊不受影响。host 侧 `isValidSessionId` 按 provider 各自校验，杜绝把 A 家 id 喂给 B 家。

### install.js

`findClaude()` 旁加 `findCodex()`（PATH + 常见安装位置：`~/.codex/bin`、npm 全局、homebrew 等）。
包装器（host.bat / host.sh）**同时写** `CLAUDE_CLI`、`CODEX_CLI`（找到谁写谁），mac/linux 的 PATH 追加 codex 目录。
host 注册/卸载逻辑、清单、HKCU/NativeMessagingHosts 全不动。codex 未找到只告警不阻断（用户可能只用 claude）。

### 向后兼容铁律（等价性测试）

`provider='claude'` 且消息无新增字段时，`providers/claude.js` 生成的命令行参数、prompt 拼装、
NDJSON 解析必须与现版**逐字节一致**：
- args 仍为 `["-p","--output-format","stream-json","--verbose"]` (+ `--resume`/`--include-partial-messages`/`--model`)
- prompt 段拼接保持 `场景 / 上下文(以 `---` 收尾) / 问题`，`join("\n\n")`
- 解析仍认 `stream_event.delta.text_delta` 与 `result` 兜底，`session_id` 续聊

## 错误处理

- bin 启动失败（spawn error）→ `{type:"error"}` 回面板，文案含后端名
- 后端非零退出且无输出 → `[错误] <后端> 退出码 N`
- Codex `turn.failed`/`error` 事件 → 转 `error` 帧
- 解析失败的非 JSON 行（启动告警）→ 忽略（沿用现状）
- 日志失败、写盘失败 → 静默降级 / 回 error，沿用现状

## 测试要点

- 等价性：claude 路径 args/prompt 与改造前快照对比（人工 diff 或单测断言 buildArgs 输出）
- codex parseLine：喂样例 JSONL（thread.started / item.completed / turn.failed）断言归一化结果
- 面板切换：Claude→Codex 后 sessionId 清空、上下文重新注入
- 安装：install.js 在只装 claude、只装 codex、两者都装三种情况下生成正确包装器
- 端到端：两后端各跑一次 ask + save（实现阶段对真实 codex 版本核对 stdin/resume 拼接）

## 后续（本期不做）

- Codex app-server JSON-RPC 长连接以获得逐字流式
- 安装时 `--provider` 固定默认后端
- 第三个后端（如 Gemini CLI）：接口已就绪，加一个 provider 文件即可
