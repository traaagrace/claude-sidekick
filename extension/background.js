const HOST_NAME = "com.claude.sidekick";

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "ask-claude",
    title: "用 Claude 分析选中内容",
    contexts: ["selection"],
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "ask-claude") {
    chrome.storage.session.set({ selectedText: info.selectionText }, () => {
      chrome.sidePanel.open({ tabId: tab.id });
    });
  }
});

chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ tabId: tab.id });
});

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg.type === "SELECTED_TEXT") {
    chrome.storage.session.set({ selectedText: msg.text }, () => {
      chrome.sidePanel.open({ tabId: sender.tab.id });
    });
  }
});

// 健康检查：临时拉起 host 发 ping，收到 pong 即就绪（host 随即被销毁）
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type !== "PING") return;

  let answered = false;
  let probe;
  try {
    probe = chrome.runtime.connectNative(HOST_NAME);
  } catch (e) {
    sendResponse({ ok: false, error: e.message });
    return;
  }

  probe.onMessage.addListener((m) => {
    if (m.type === "pong") {
      answered = true;
      sendResponse({ ok: true });
      probe.disconnect();
    }
  });
  probe.onDisconnect.addListener(() => {
    // host 未安装时 connectNative 不报错，而是立即断开并设置 lastError
    if (!answered) sendResponse({ ok: false, error: chrome.runtime.lastError?.message });
  });
  probe.postMessage({ type: "ping" });
  return true; // 保持 sendResponse 异步有效
});

// panel 长连接：每次提问按需拉起 host，输出逐条透传；面板断开即销毁 host
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "claude-stream") return;

  let native = null;

  port.onMessage.addListener((msg) => {
    try {
      native = chrome.runtime.connectNative(HOST_NAME);
    } catch (e) {
      port.postMessage({ type: "error", error: e.message });
      return;
    }

    // host 的 chunk / done / error 原样透传给面板
    native.onMessage.addListener((m) => {
      try {
        port.postMessage(m);
      } catch {
        // 面板已关闭，停止 host
        native?.disconnect();
        native = null;
      }
    });

    // 异常断开（如未安装 host、host 崩溃）；正常结束时面板已先收到 done
    native.onDisconnect.addListener(() => {
      const err = chrome.runtime.lastError?.message;
      native = null;
      try {
        port.postMessage({ type: "error", error: err || "host 进程已退出" });
      } catch {
        // 面板已关闭，忽略
      }
    });

    native.postMessage({ type: "ask", context: msg.context, question: msg.question, sessionId: msg.sessionId });
  });

  port.onDisconnect.addListener(() => {
    if (native) native.disconnect(); // 面板关闭 → Chrome 杀掉 host 进程
  });
});
