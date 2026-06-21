# 多后端支持（Codex Provider）— 实施记录

日期：2026-06-22
对应设计：[specs/2026-06-22-codex-provider-support-design.md](../specs/2026-06-22-codex-provider-support-design.md)
状态：已实现并测试（端到端集成测试通过）；Codex 真实 CLI 行为待人工核对

## 落地清单

1. **provider 抽象层（新增）**
   - `providers/index.js`：注册表 `{claude, codex}`，`get(id)` 缺省回退 claude
   - `providers/claude.js`：封装现有 Claude 行为，args/parse 与历史逐字节等价
   - `providers/codex.js`：`codex exec --json` 适配器（resume 子命令、整段返回、thread_id 取 session）

2. **host.js 重构为 provider-无关引擎**
   - 抽出 `streamProvider(provider, prompt, resumeId, onChunk)` 统一流式循环
   - `runAsk` / `runSave` 仅负责拼 prompt 与后处理（落盘）
   - 归一化事件 `{sessionId?, text?, final?, error?}`；`final` 整段回复仅在未出过文本时采用
   - 删除 Claude 专属的 `CLAUDE` 常量与 `supportsPartial`（迁入 claude provider）

3. **extension**
   - `background.js`：透传 `provider` 字段
   - `panel.html`：header 加 `#provider-select` 下拉 + 样式；标题改中性「✦ Sidekick」
   - `panel.js`：`currentProvider` 持久化、切换处理、`sessionProvider` 归属、作废旧会话、两条 postMessage 带 provider

4. **install.js**
   - `findClaude` → 泛化 `findBin(name, extraNix, extraWin)`；同时探测 claude/codex
   - 包装器写 `CLAUDE_CLI` + `CODEX_CLI`，PATH 追加两者目录；缺一个只告警

5. **文档与版本**
   - manifest `1.6.0 → 1.7.0`，name `Sidekick`
   - README / CHANGELOG 更新

## 验证

- `node --test`：19 用例全绿
  - provider 单测：registry / claude args+parse 等价性 / codex args+parse+resume（17）
  - host 集成：假 codex CLI 喂 JSONL，验证 chunk="FAKE_REPLY" 且 done.sessionId="th-test-123"；ping→pong（2）
- `node --check`：host.js / providers/* / install.js / extension/* 全过

## 待人工核对（隔离在 providers/codex.js，改动局部）

1. `codex exec -` 是否从 stdin 读取 prompt（若该版本需省略位置参数从 stdin 读，去掉末尾 `-`）
2. `codex exec resume <id>` 与 `--json --skip-git-repo-check --sandbox` 的精确拼接顺序
3. 实跑一次 `codex exec --json "PING"` 比对 `item.completed.item.type==="agent_message"` 字段名

## 后续（本期不做）

- Codex app-server JSON-RPC 长连接 → 逐字流式
- 安装时 `--provider` 固定默认后端
- 第三个后端（接口已就绪，加一个 provider 文件即可）
