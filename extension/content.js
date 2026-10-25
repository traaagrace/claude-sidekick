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
      if (sel.rangeCount === 0) return;

      const rect = sel.getRangeAt(0).getBoundingClientRect();

      btn = document.createElement("button");
      btn.textContent = "✦ Claude";
      btn.title = "将选中内容添加到 Sidekick 上下文";
      btn.style.cssText = `
        position: fixed;
        z-index: 2147483647;
        top: 0;
        left: 0;
        right: auto;
        bottom: auto;
        visibility: hidden;
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

      // 选区和 fixed 按钮都使用视口坐标，不叠加页面滚动偏移。
      const gap = 8;
      const margin = 8;
      const { width, height } = btn.getBoundingClientRect();
      const viewportWidth = document.documentElement.clientWidth;
      const viewportHeight = window.innerHeight;
      const positions = [
        { left: rect.right + gap, top: rect.bottom + gap }, // 右下
        { left: rect.left - width - gap, top: rect.bottom + gap }, // 左下
        { left: rect.right + gap, top: rect.top - height - gap }, // 右上
        { left: rect.left - width - gap, top: rect.top - height - gap }, // 左上
      ];
      const position = positions.find(({ left, top }) =>
        left >= margin && top >= margin
        && left + width <= viewportWidth - margin
        && top + height <= viewportHeight - margin
      ) || positions[3];

      // 选区过大、四个角均放不下时，把按钮限制在可见范围内。
      btn.style.left = `${Math.max(margin, Math.min(position.left, viewportWidth - width - margin))}px`;
      btn.style.top = `${Math.max(margin, Math.min(position.top, viewportHeight - height - margin))}px`;
      btn.style.visibility = "visible";
    }, 10);
  });

  document.addEventListener("mousedown", (e) => {
    if (btn && !btn.contains(e.target)) removeBtn();
  });

  // 页面位置变化后收起，避免按钮继续引用已经离开视野的选段。
  document.addEventListener("scroll", removeBtn, true);
  window.addEventListener("resize", removeBtn);
})();
