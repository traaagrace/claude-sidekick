(() => {
  let btn = null;

  function removeBtn() {
    if (btn) { btn.remove(); btn = null; }
  }

  document.addEventListener("mouseup", (e) => {
    setTimeout(() => {
      const sel = window.getSelection();
      const text = sel ? sel.toString().trim() : "";

      removeBtn();
      if (!text || text.length < 5) return;

      const range = sel.getRangeAt(0);
      const rect = range.getBoundingClientRect();

      btn = document.createElement("button");
      btn.textContent = "✦ Claude";
      btn.style.cssText = `
        position: fixed;
        z-index: 2147483647;
        top: ${rect.top + window.scrollY - 38}px;
        left: ${rect.left + rect.width / 2 - 44}px;
        background: #1a1a1a;
        color: #fff;
        border: none;
        border-radius: 6px;
        padding: 5px 12px;
        font-size: 13px;
        font-family: -apple-system, sans-serif;
        cursor: pointer;
        box-shadow: 0 2px 8px rgba(0,0,0,0.25);
        transition: opacity 0.15s;
      `;

      btn.addEventListener("mousedown", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const captured = text;
        removeBtn();
        chrome.runtime.sendMessage({ type: "SELECTED_TEXT", text: captured });
      });

      document.body.appendChild(btn);
    }, 10);
  });

  document.addEventListener("mousedown", (e) => {
    if (btn && !btn.contains(e.target)) removeBtn();
  });
})();
