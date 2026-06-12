const HOST_NAME = "com.claude.sidekick";

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "ask-claude",
    title: "用 Claude 分析选中内容",
    contexts: ["selection"],
  });
});

// 把新选中写入 selections 数组：与已有段完全相同 → 忽略（去重优先，待替换状态保留）；
// 有待替换标记且目标仍存在 → 原位替换；否则 → 追加。完成后清除替换标记并打开面板。
// chrome.storage 无事务原语：用 Promise 链串行化读-改-写，防止连续选中互相覆盖。
let writeQueue = Promise.resolve();

function addSelection(text, tabId) {
  writeQueue = writeQueue.then(() => new Promise((done) => {
    chrome.storage.session.get(["selections", "replaceTargetId"], (res) => {
      const selections = res.selections || [];
      const replaceTargetId = res.replaceTargetId ?? null;

      if (selections.some((s) => s.text === text)) {
        chrome.sidePanel.open({ tabId });
        done();
        return;
      }

      const hasTarget = replaceTargetId && selections.some((s) => s.id === replaceTargetId);
      const next = hasTarget
        ? selections.map((s) => (s.id === replaceTargetId ? { ...s, text, addedAt: Date.now() } : s))
        : [...selections, { id: crypto.randomUUID(), text, addedAt: Date.now() }];

      // 替换完成（或标记指向已删除条目而失效）后，统一清除标记
      chrome.storage.session.set({ selections: next, replaceTargetId: null }, () => {
        chrome.sidePanel.open({ tabId });
        done();
      });
    });
  }));
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "ask-claude") addSelection(info.selectionText, tab.id);
});

chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ tabId: tab.id });
});

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg.type === "SELECTED_TEXT") addSelection(msg.text, sender.tab.id);
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
