let currentContext = "";
let isStreaming = false;
let sessionId = null; // claude 会话 ID：同一对话框内续聊，点「新对话」清空

const dot = document.getElementById("dot");
const statusText = document.getElementById("status-text");
const contextBar = document.getElementById("context-bar");
const contextTextEl = document.getElementById("context-text");
const messagesEl = document.getElementById("messages");
const questionEl = document.getElementById("question");
const sendBtn = document.getElementById("send");
const hint = document.getElementById("hint");
const copyAllBtn = document.getElementById("copy-all");
const newChatBtn = document.getElementById("new-chat");

// 通过 background 对 native host 做健康检查（每次会临时拉起 host，频率不宜太高）
function checkBridge() {
  chrome.runtime.sendMessage({ type: "PING" }, (res) => {
    if (chrome.runtime.lastError || !res || !res.ok) {
      dot.className = "dot err";
      statusText.textContent = "未就绪（先运行 node install.js）";
    } else {
      dot.className = "dot ok";
      statusText.textContent = "已就绪";
    }
  });
}

checkBridge();
setInterval(checkBridge, 30000);

// ---------- 复制 ----------
function copyText(text, btn) {
  const showOk = () => {
    if (!btn) return;
    const old = btn.textContent;
    btn.textContent = "✓ 已复制";
    setTimeout(() => (btn.textContent = old), 1200);
  };
  navigator.clipboard.writeText(text).then(showOk).catch(() => {
    // 剪贴板 API 不可用时降级
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
    showOk();
  });
}

function getTranscript() {
  // 取原始 Markdown（dataset.raw），渲染后的 textContent 已丢失格式标记
  return [...messagesEl.querySelectorAll(".msg")]
    .map((m) => `${m.classList.contains("user") ? "我" : "Claude"}:\n${m.querySelector(".msg-text").dataset.raw || ""}`)
    .join("\n\n");
}

copyAllBtn.addEventListener("click", () => {
  const transcript = getTranscript();
  if (transcript) copyText(transcript, copyAllBtn);
});

newChatBtn.addEventListener("click", () => {
  if (isStreaming) return; // 回答生成中不允许重开
  const transcript = getTranscript();
  if (transcript) copyText(transcript, newChatBtn);
  sessionId = null;
  messagesEl.querySelectorAll(".msg").forEach((m) => m.remove());
  hint.style.display = "";
  statusText.textContent = transcript ? "已复制对话，新会话已开启" : "新会话已开启";
  setTimeout(checkBridge, 2000); // 稍后恢复正常状态显示
});

// ---------- 选中文字上下文 ----------
chrome.storage.session.onChanged.addListener((changes) => {
  if (changes.selectedText) setContext(changes.selectedText.newValue);
});
chrome.storage.session.get("selectedText", (res) => {
  if (res.selectedText) setContext(res.selectedText);
});

function setContext(text) {
  currentContext = text;
  contextTextEl.textContent = `📎 ${text.slice(0, 80)}${text.length > 80 ? "…" : ""}`;
  contextBar.classList.add("visible");
  questionEl.focus();
}

document.getElementById("clear-ctx").addEventListener("click", () => {
  currentContext = "";
  contextBar.classList.remove("visible");
  chrome.storage.session.remove("selectedText");
});

// ---------- 输入区 ----------
questionEl.addEventListener("input", () => {
  questionEl.style.height = "auto";
  questionEl.style.height = Math.min(questionEl.scrollHeight, 120) + "px";
});
questionEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); doSend(); }
});
sendBtn.addEventListener("click", doSend);

// ---------- 消息气泡 ----------
// 返回 .msg-text（div）：assistant 按 Markdown 渲染，user 保持纯文本
// 原文存 dataset.raw，复制时取原文（渲染后的 textContent 已丢失 Markdown 标记）
function addMsg(role, text) {
  hint.style.display = "none";
  const wrap = document.createElement("div");
  wrap.className = `msg ${role}`;

  const textEl = document.createElement("div");
  textEl.className = "msg-text";
  textEl.dataset.raw = text;
  if (role === "assistant") textEl.innerHTML = renderMarkdown(text);
  else textEl.textContent = text;

  const copyBtn = document.createElement("button");
  copyBtn.className = "copy-btn";
  copyBtn.title = "复制这条内容";
  copyBtn.textContent = "复制";
  copyBtn.addEventListener("click", () => copyText(textEl.dataset.raw, copyBtn));

  wrap.appendChild(textEl);
  wrap.appendChild(copyBtn);
  messagesEl.appendChild(wrap);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return textEl;
}

function doSend() {
  if (isStreaming) return;
  const question = questionEl.value.trim();
  if (!question && !currentContext) return;

  addMsg("user", currentContext ? `📎 上下文 + ${question || "（分析选中内容）"}` : question);
  questionEl.value = "";
  questionEl.style.height = "auto";

  const replyEl = addMsg("assistant", "");
  replyEl.classList.add("streaming");
  isStreaming = true;
  sendBtn.disabled = true;

  // 长连接：background 逐块转发 host 的流式响应
  const port = chrome.runtime.connect({ name: "claude-stream" });

  // 流式 Markdown：累积原文全量重渲（语法可能跨 chunk），rAF 节流避免高频 innerHTML
  let rawReply = "";
  let renderPending = false;
  function renderReply() {
    replyEl.dataset.raw = rawReply;
    replyEl.innerHTML = renderMarkdown(rawReply);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }
  function scheduleRender() {
    if (renderPending) return;
    renderPending = true;
    requestAnimationFrame(() => { renderPending = false; renderReply(); });
  }

  function finish() {
    renderReply(); // rAF 可能尚未触发，确保最后一块已渲染
    replyEl.classList.remove("streaming");
    isStreaming = false;
    sendBtn.disabled = false;
    port.disconnect();
  }

  port.onMessage.addListener((msg) => {
    if (msg.type === "chunk") {
      rawReply += msg.text;
      scheduleRender();
    } else if (msg.type === "done") {
      if (msg.sessionId) sessionId = msg.sessionId; // 记住会话，下一轮续聊
      finish();
    } else if (msg.type === "error") {
      rawReply = `[连接失败] ${msg.error}\n\n请确认已运行安装脚本：node install.js <插件ID>`;
      dot.className = "dot err";
      statusText.textContent = "未就绪";
      finish();
    }
  });

  // background 异常断开（如 service worker 被回收）时兜底恢复 UI
  port.onDisconnect.addListener(() => {
    if (isStreaming) {
      rawReply += "\n\n[连接中断]";
      finish();
    }
  });

  port.postMessage({ context: currentContext, question, sessionId });
}
