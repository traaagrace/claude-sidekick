# ✦ Claude Sidekick

**划词即问，网页伴读。** 选中页面上的任何文字，一键发给 Claude 分析——翻译、解读、总结、追问，答案逐字流式呈现在浏览器侧边栏。

## 为什么选它

- 🔑 **零成本接入** — 复用本机 Claude Code CLI 登录态，不需要 API Key，不产生额外账单
- 🪶 **零依赖、零常驻** — 没有 npm 包、没有后台服务、不监听端口；基于 Chrome Native Messaging，提问时自动拉起进程，答完即销毁
- ⚡ **流式回答** — 逐字打字机效果，告别干等
- 💬 **多轮会话** — 同一对话框内自动续接上下文，可连续追问
- 📝 **Markdown 渲染** — 标题、代码块、列表、引用原生呈现；渲染前全文 HTML 转义，天然防 XSS
- 🖥️ **跨平台** — Windows / macOS / Linux，一条命令安装，一条命令卸载

功能清单与变更记录见 [CHANGELOG.md](CHANGELOG.md)。

## 目录结构

```
claude-sidekick/
├── host.js            # Native Messaging host（Chrome 按需自动启动）
├── install.js         # 一次性安装脚本（注册 host 到 Chrome）
├── uninstall.js       # 卸载脚本（删除注册表/清单及生成文件）
├── uninstall.cmd      # Windows 双击卸载
├── bridge.js          # [已退役] 旧版 HTTP 桥接服务，仅作备用
├── CHANGELOG.md       # 功能清单与变更记录
└── extension/         # Chrome 插件目录
    ├── manifest.json
    ├── background.js
    ├── content.js
    ├── panel.html
    └── panel.js
```

## 安装步骤（每台机器一次）

### 1. 安装插件

1. Chrome 地址栏打开 `chrome://extensions`
2. 右上角开启「开发者模式」
3. 点击「加载已解压的扩展程序」，选择 `extension/` 目录
4. **复制插件卡片上的 ID**（32 位小写字母）

### 2. 注册 native host

```bash
node install.js <插件ID>
```

脚本自动完成：

- 探测 node 与 claude CLI 的绝对路径，生成启动包装器（Win: `host.bat` / Mac: `host.sh`）
- Windows：写一条 `HKCU` 用户级注册表（无需管理员）
- macOS / Linux：复制清单文件到 Chrome 的 `NativeMessagingHosts` 目录

### 3. 重载插件

回到 `chrome://extensions` 点 Claude Sidekick 的「刷新 ↻」。
侧边栏状态显示「已就绪」即成功。

## 使用方式

- **浮动按钮**：在任意页面选中文字，出现 `✦ Claude` 按钮，点击后侧边栏打开
- **右键菜单**：选中文字后右键 → 「用 Claude 分析选中内容」
- **直接提问**：点击插件图标打开侧边栏，直接输入问题
- **多轮会话**：同一聊天框内连续提问自动续接同一会话，可以追问；
  点 header 的 **＋** 开启新对话（开启前会自动复制当前对话到剪贴板）
- **复制**：header 的 **⧉** 复制全部对话；悬停单条消息出现 ⧉ 复制该条

新版 claude CLI（支持 `--include-partial-messages`）下回答**逐字流式显示**；
旧版自动降级为整段返回。升级 CLI：`claude update`。

## 前提条件

- 已安装 Claude Code CLI（`claude` 命令可用）
- Node.js（运行 install.js / host.js）
- 无任何 npm 依赖，只用 Node.js 内置模块

## 可选配置

想用更快的模型，编辑生成的包装器（`host.bat` / `host.sh`），加一行环境变量：

```
set "CLAUDE_MODEL=haiku"     (Windows, host.bat)
export CLAUDE_MODEL=haiku    (Mac/Linux, host.sh)
```

## 日志

host 默认把执行日志写到仓库的 `logs/host.log`（含发给 Claude 的完整 prompt、
耗时、退出码与 CLI 报错），用于排查问题与验证上下文/场景注入行为：

- 超过 2MB 自动轮转为 `host.log.old`（仅保留一份历史，磁盘占用上限 ≈ 4MB）
- 不想记录：编辑包装器（`host.bat` / `host.sh`）加 `CLAUDE_LOG=0` 环境变量
- 日志包含选中的页面原文，注意隐私

## 卸载

- **Windows**：双击 `uninstall.cmd`（或运行 `node uninstall.js`）
- **macOS / Linux**：运行 `node uninstall.js`

脚本会自动删除 host 注册（Windows 注册表项 / Mac、Linux 清单文件，**含旧版
Claude Helper 残留**）以及 install.js 生成的包装器文件。
Chrome 插件本身到 `chrome://extensions` 手动移除即可。

## 常见问题

- **插件 ID 变了**（重新加载到了不同目录）→ 重跑 `node install.js <新ID>`
- **Mac 上提示找不到 claude** → Chrome 启动的进程没有 shell 的 PATH，确认 `host.sh`
  里写入了 claude 绝对路径；没有就重跑 install.js
- **排查 host 报错** → host 的 stderr 会进 Chrome 日志，也可在
  `chrome://extensions` → Claude Sidekick → 「Service Worker」控制台看报错
