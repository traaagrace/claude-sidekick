# 多段选中上下文 — 设计文档

日期：2026-06-12
状态：待评审

## 背景与问题

现有"选中"链路只有一个字符串槽位：

- `content.js` 浮动按钮发送 `SELECTED_TEXT` 消息
- `background.js` 写入 `chrome.storage.session.selectedText`（覆盖式）
- `panel.js` 用单个字符串 `currentContext` 保存，context-bar 只显示一条
- `host.js` 把 context 拼进 prompt

因此新选中总是顶掉旧选中，无法同时携带多段页面内容提问。

## 目标

1. **多段共存**：多次选中（可跨页面/跨标签页）累积为列表，一起作为上下文发送
2. **一键清除**：一个按钮清空全部选段
3. **单条替换**：点击某条选段进入"待替换"状态，下一次页面选中替换该条而非追加
4. 保留单条删除能力（现有 × 行为的自然延伸）

## 非目标

- 页面内多段持久高亮（CSS Highlight API）——工程量大，且无法覆盖跨标签页场景
- 选段数量/总字数硬上限——仅在头部显示总字数供用户自行判断（YAGNI）
- 跨会话持久化——沿用 `chrome.storage.session` 的会话级生命周期

## 总体方案

以 `chrome.storage.session` 为**单一数据源**：background 和 panel 都只读写
storage，panel 通过 `storage.onChanged` 被动重渲染，不存在第二份权威状态。

`content.js` 与 `host.js` **零改动**。

## 数据模型

`chrome.storage.session` 中：

```js
selections: [            // 选段数组，顺序即添加顺序
  { id: "uuid", text: "选中的原文", addedAt: 1760000000000 }
]
replaceTargetId: "uuid" | 不存在   // 待替换条目的 id
```

- `id` 用 `crypto.randomUUID()` 生成
- 旧 key `selectedText` 废弃（见「迁移」）

## 组件职责与数据流

### content.js（不变）

仍然只发 `{ type: "SELECTED_TEXT", text }`。

### background.js（新增 ≈15 行）

收到新选中（浮动按钮消息或右键菜单）时，统一走一个 `addSelection(text, tabId)`：

1. 读取 `selections` 与 `replaceTargetId`
2. 若 `text` 与已有某条**完全相同** → 忽略（防误触重复），仍打开面板
3. 若 `replaceTargetId` 存在且数组中能找到该条 → 原位替换该条文本（id 沿用、`addedAt` 更新），并删除 `replaceTargetId`
4. 若 `replaceTargetId` 指向的条目已被删除 → 视为追加，同时清掉失效标记
5. 否则 → 追加到数组末尾
6. 写回 storage，打开 side panel

### panel.js（改造 ≈80 行）

- 启动时读 `selections` + `replaceTargetId` 渲染；监听 `storage.onChanged` 重渲染
- context-bar 改为纵向列表（见 UI 一节），所有操作直接写 storage：
  - **× 删除单条**：从数组移除该条；若它恰是 `replaceTargetId`，一并清除标记
  - **⇄ 设置/取消替换目标**：写入/删除 `replaceTargetId`（同一时刻最多一条处于待替换）
  - **清空全部**：清空 `selections`、删除 `replaceTargetId`
- 发送时把多段拼成单字符串交给现有 `context` 字段：

```
【选段 1】
<text1>

【选段 2】
<text2>
```

- 只有 1 段时不加编号头，保持与现状一致的 prompt 形态
- user 气泡显示 `📎 N 段上下文 + <问题>`（1 段时沿用现有 `📎 上下文 + …`）
- 发送后选段**保留**（与现有行为一致），由用户手动清除

### host.js（不变）

仍接收单个 `context` 字符串。

## UI 设计（panel.html）

```
┌─────────────────────────────────────┐
│ 📎 已选 3 段 · 共 412 字     清空全部 │  ← 头部行
├─────────────────────────────────────┤
│ ① 第一段选中内容的预览文字……    ⇄ × │
│ ② 第二段选中内容……             ⇄ × │
│ ③ 第三段（待替换，黄色高亮边框） ⇄ × │
└─────────────────────────────────────┘
```

- 每条：序号 + 单行截断预览（≈80 字符）+ ⇄（替换）+ ×（删除）
- 待替换条目：黄色高亮边框 + 头部提示文案变为「去页面选中新内容以替换第 N 段」
- 超过 3 条时列表区域内部滚动（`max-height` + `overflow-y: auto`），不挤压消息区
- 0 条时整个 context-bar 隐藏（沿用现有 `.visible` 切换）

## 迁移与兼容

- panel 启动时若发现旧 key `selectedText`：转换为一条 selection 写入 `selections`，
  随后删除旧 key。storage.session 是会话级的，一个版本后可移除这段迁移代码。
- background 中两处写 `selectedText` 的代码（右键菜单、SELECTED_TEXT 消息）全部改为
  调用 `addSelection()`。

## 边界与错误处理

| 场景 | 行为 |
|------|------|
| 新选中与已有某段完全相同 | 忽略追加，仅打开面板 |
| 待替换状态下选中的文本与另一条已有选段完全相同 | 同样忽略（去重优先），待替换状态保留，等待下一次选中 |
| `replaceTargetId` 指向已删除条目 | 按追加处理，并清除失效标记 |
| 待替换状态下 panel 被关闭 | 标记保留在 session storage，下次选中仍执行替换；panel 重开时恢复高亮显示 |
| 回答流式生成中操作选段 | 允许（发送时已快照拼接，后续修改不影响进行中的请求） |

### 增补（2026-06-12）：上下文会话级一次注入

原设计每次发送都携带全部选段，多轮追问时重复消耗 token。增补为与场景注入对称的快照模式：

- panel 维护 `injectedContext`（本会话已注入的拼接字符串快照）
- 仅当 `buildContext()` 结果 ≠ 快照时才携带 context，回答成功（done）后更新快照
- 选段增/删/替换导致拼接结果变化 → 下一条消息自动重新注入全部选段
- 「新对话」重置快照；选段保留行为不变
- user 气泡仅在实际携带时显示 `📎`；空问题且上下文未变化时拦截发送（没有新内容可发）
- 发送条件仍为「问题或（需注入的）上下文至少其一」，仅激活场景不构成发送条件
| storage 读写失败 | 沿用项目现状：操作静默失败，面板状态以下一次 onChanged 为准 |

## 测试策略

本项目是零依赖 Chrome 扩展，无测试框架。采用**手动验收清单**：

1. 选中 A → 选中 B：面板显示 2 段，顺序为 A、B
2. 跨标签页选中 C：面板显示 3 段
3. 重复选中 A：仍为 3 段（去重生效）
4. 点 ② 的 ⇄ → 页面选中 D：② 变为 D，待替换高亮消失
5. ⇄ 点两次：待替换状态取消，下次选中为追加
6. 设 ② 为待替换 → 删除 ② → 页面选中 E：E 追加为新条目
7. 点「清空全部」：列表清空，context-bar 隐藏
8. 2 段上下文 + 问题发送：host 收到的 prompt 含「【选段 1】…【选段 2】…」
9. 仅 1 段时发送：prompt 不含编号头（与旧版一致）
10. 关闭并重开 panel：选段与待替换状态均恢复

如后续需要自动化，可用 Playwright 加载解压扩展做 E2E，但不在本次范围内。

## 改动文件清单

| 文件 | 改动 |
|------|------|
| `extension/background.js` | 新增 `addSelection()`，两处写入点改为调用它 |
| `extension/panel.js` | 选段列表渲染与操作、prompt 拼接、迁移逻辑 |
| `extension/panel.html` | context-bar 列表化样式 |
| `extension/content.js` | 无 |
| `host.js` | 无 |
