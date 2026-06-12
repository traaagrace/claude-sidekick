# Claude Sidekick 功能清单与变更记录

## 当前功能清单（v1.4.0）

### 内容获取
- [x] 选中页面文字后出现 `✦ Claude` 浮动按钮，点击发送到侧边栏
- [x] 右键菜单「用 Claude 分析选中内容」
- [x] 侧边栏直接输入提问（可不带页面上下文）
- [x] **多段选中共存**：多次选中（可跨页面/标签页）累积为选段列表，重复内容自动去重
- [x] 📎 上下文条展示选段列表（数量 + 总字数），每段可 ⇄ 替换、× 删除，支持一键清空全部

### 对话能力
- [x] 调用本地 Claude CLI 回答（无需 API Key，复用本机登录态）
- [x] 逐字流式显示回答（需 CLI 支持 `--include-partial-messages`，旧版自动降级为整段返回）
- [x] **多轮会话**：同一聊天框内连续提问自动续接同一会话（`--resume <session_id>`），支持追问
- [x] **＋ 新对话**：重置会话，开启前自动将当前对话复制到剪贴板
- [x] 关闭侧边栏 = 自然结束会话（会话 ID 不跨面板保留）
- [x] **Markdown 渲染**：回复支持标题、粗/斜体、行内代码、代码块、列表、引用、链接、分隔线（零依赖渲染器，渲染前全文 HTML 转义防注入）

### 复制能力
- [x] **📋 复制全部**（工具栏按钮）：按「我: / Claude:」格式复制整个对话
- [x] **单条复制**：悬停任意消息气泡显示「复制」按钮，复制该条内容（提问与回复均支持）
- [x] 复制成功按钮短暂变「✓ 已复制」反馈

### 运行架构
- [x] Chrome Native Messaging：提问时自动拉起 host 进程（无窗口），结束自动销毁
- [x] 无常驻服务、无端口监听、无 npm 依赖
- [x] 一键安装脚本 `install.js`，支持 Windows / macOS / Linux
- [x] 一键卸载：`uninstall.js`（Windows 双击 `uninstall.cmd`），自动清理注册表/清单及生成文件
- [x] 健康检查：侧边栏状态点（已就绪 / 未就绪）
- [x] 可选 `CLAUDE_MODEL` 环境变量切换更快模型

---

## 变更记录

### v1.4.0 - 2026-06-12

**新增**
- **多段选中共存**：多次选中（可跨页面/跨标签页）累积为选段列表，一起作为上下文提问；与已有段完全相同的选中自动忽略（去重）
- **单条替换**：点选段的 ⇄ 进入「待替换」状态（黄色高亮边框），下一次页面选中**原位替换**该段而非追加；再点一次取消
- **单条删除 / 一键清空**：每段可 × 删除；上下文条头部「清空全部」按钮一键清空所有选段
- 上下文条显示选段数与总字数；多段发送时 prompt 按「【选段 N】」编号拼接（仅 1 段时保持旧版格式）

**修复**
- `sidePanel.open()` 改为在事件监听器内同步调用——此前排进 Promise 队列会丢失用户手势上下文，导致点击浮动按钮/右键菜单后面板不打开
- 连续快速选中的写入竞态：storage 读-改-写经 Promise 链串行化，不再互相覆盖

**调整**
- 数据模型：`storage.session.selectedText`（单字符串）→ `selections` 数组 + `replaceTargetId`，以 storage 为单一数据源，面板经 `onChanged` 被动渲染；旧 key 自动迁移
- manifest 声明 `minimum_chrome_version: 102`（所用 `storage.session` API 本就要求 Chrome 102+）
- 仅新选段到达时聚焦输入框，删除选段/切换替换目标不再抢焦点

### v1.3.0 - 2026-06-12

**新增**
- **Markdown 渲染**：Claude 回复支持标题、粗体/斜体、行内代码、围栏代码块、有序/无序列表、引用、链接、分隔线（新增零依赖渲染器 `extension/markdown.js`，延续无 npm 依赖原则）
- 流式回答全量重渲 + rAF 节流；中途未闭合的代码围栏自动按代码块处理，避免闪烁

**安全**
- 渲染前对全文 HTML 转义再做语法转换，模型输出中的任何原始 HTML（`<script>`、`onerror` 等）均不会执行；链接仅放行 http(s) 协议并加 `rel="noopener noreferrer"`

**调整**
- 复制（单条 / 复制全部 / 新对话自动复制）改为取 `dataset.raw` 中的原始 Markdown 文本，而非渲染后丢失格式的纯文本
- 用户消息保持纯文本展示并支持多行换行（`white-space: pre-wrap` 移至 user 气泡）
- 项目目录更名：`claude-sidekick-newsession` → `claude-sidekick-md`

### v1.2.1 - 2026-06-12

**优化**
- 按钮样式重做：工具栏独立成行，按钮改为「图标 + 文字」（🆕 新对话 / 📋 复制全部），不再是含义不明的符号
- 单条复制按钮改为文字「复制」，悬停消息气泡右上角浮出，点击后显示「✓ 已复制」

**新增**
- 卸载脚本 `uninstall.js`：自动删除 host 注册（Windows 注册表项 / Mac、Linux 清单文件，含旧版 `com.claude.helper` 残留）及 install.js 生成的包装器文件
- `uninstall.cmd`：Windows 用户双击即可卸载

### v1.2.0 - 2026-06-11

**改名**
- 项目更名：Claude Helper → **Claude Sidekick**
- host 注册名：`com.claude.helper` → `com.claude.sidekick`（改名后需重跑 install.js，并清理旧注册项）

**新增**
- 多轮会话：host 从 claude 输出捕获 `session_id` 随 `done` 回传，面板暂存并在下一问携带，host 以 `--resume` 续聊；ID 上命令行前做格式白名单校验（防注入）
- 「＋ 新对话」按钮：清空聊天框并重置会话，开启前自动复制当前对话到剪贴板
- 「⧉ 复制全部」按钮：复制整个对话内容
- 单条消息悬停复制按钮（用户提问与 Claude 回复均支持）

**重构**
- 消息气泡结构改为 `span.msg-text + button.copy-btn`，流式追加只写文本节点，避免覆盖按钮

### v1.1.0 - 2026-06-11

**架构重构：HTTP bridge → Native Messaging**
- 新增 `host.js`：stdio 帧协议（4 字节小端长度 + JSON）host，由 Chrome 按需自动启动/销毁
- 新增 `install.js`：跨平台一次性安装（Win 写 HKCU 注册表；Mac/Linux 复制清单文件）
- `background.js`：HTTP fetch 改为 `connectNative` + Port 长连接逐块转发
- 彻底去掉手动启动 `node bridge.js` 的流程，`bridge.js` 退役保留
- manifest 增加 `nativeMessaging` 权限，移除 `host_permissions`

**新增**
- 逐字流式显示：`claude -p --output-format stream-json --include-partial-messages`，NDJSON 按行解析转发文字增量
- 旧版 CLI 自动降级：启动时探测 `--help`，不支持增量参数时回退整段返回（修复 `unknown option` 报错）

### v1.0.x 修复 - 2026-06-11

- **修复 CSP 拦截**：panel.html 内联脚本抽离为外部 panel.js（MV3 扩展页面禁止内联脚本，导致面板卡在「检查连接...」）
- **修复命令注入/Windows 转义**：prompt 从命令行参数改为 stdin 管道传入（选中文字含换行/引号/`&` 会破坏命令甚至执行任意命令）
- bridge 增加心跳日志、耗时统计、claude 异常退出兜底提示

### v1.0.0 - 初版

- Chrome 插件（MV3）+ 本地 HTTP 桥接服务 `bridge.js`（监听 127.0.0.1:3737）
- 选中文字浮动按钮 / 右键菜单 / 侧边栏提问
- 调用本地 `claude -p` 回答（非流式）
