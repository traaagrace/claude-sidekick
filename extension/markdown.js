// 极简 Markdown 渲染器（零依赖，与项目"无 npm 依赖"原则一致）
// 安全策略：先对全文 HTML 转义，再做语法转换 —— 模型输出中的任何原始 HTML 都不会被执行
// 支持：标题、粗体/斜体、行内代码、围栏代码块、有序/无序列表、引用、链接、分隔线
// 不支持：表格、嵌套列表等复杂语法（对话场景够用；需要时再换 marked + DOMPurify）

function escapeHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// 行内语法。先把行内代码抽成占位符（NUL 哨兵，正常文本不会出现），避免代码里的 * [ ] 被误转换
function renderInline(text) {
  const codeSpans = [];
  let s = text.replace(/`([^`]+)`/g, (_, code) => {
    codeSpans.push(`<code>${code}</code>`);
    return `\u0000${codeSpans.length - 1}\u0000`;
  });

  s = s
    .replace(/\*\*\*([^*]+)\*\*\*/g, "<strong><em>$1</em></strong>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*\n]+)\*/g, "<em>$1</em>")
    // 仅放行 http(s) 链接，新窗口打开且不带 opener
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');

  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => codeSpans[+i]);
}

// 块级语法：按行扫描。注意全文已转义，> 已变成 &gt;
function renderMarkdown(src) {
  const lines = escapeHtml(src).split("\n");
  const html = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // 围栏代码块。流式中途未闭合时，余下内容整体按代码处理（避免闪烁）
    if (/^```/.test(line)) {
      const code = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) code.push(lines[i++]);
      i++; // 跳过闭合围栏
      html.push(`<pre><code>${code.join("\n")}</code></pre>`);
      continue;
    }

    // 标题（# ~ ####）
    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      const level = heading[1].length;
      html.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
      i++;
      continue;
    }

    // 分隔线
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      html.push("<hr>");
      i++;
      continue;
    }

    // 引用块（连续 > 行合并）
    if (/^&gt;\s?/.test(line)) {
      const quote = [];
      while (i < lines.length && /^&gt;\s?/.test(lines[i]))
        quote.push(renderInline(lines[i++].replace(/^&gt;\s?/, "")));
      html.push(`<blockquote>${quote.join("<br>")}</blockquote>`);
      continue;
    }

    // 列表（连续同类行合并，不支持嵌套）
    const isOrdered = /^\s*\d+[.)]\s+/.test(line);
    if (isOrdered || /^\s*[-*+]\s+/.test(line)) {
      const re = isOrdered ? /^\s*\d+[.)]\s+/ : /^\s*[-*+]\s+/;
      const items = [];
      while (i < lines.length && re.test(lines[i]))
        items.push(`<li>${renderInline(lines[i++].replace(re, ""))}</li>`);
      const tag = isOrdered ? "ol" : "ul";
      html.push(`<${tag}>${items.join("")}</${tag}>`);
      continue;
    }

    // 空行
    if (!line.trim()) {
      i++;
      continue;
    }

    // 普通段落：连续非空、非特殊行合并，行内换行保留为 <br>
    const para = [];
    while (
      i < lines.length && lines[i].trim() &&
      !/^(```|#{1,4}\s|&gt;|\s*[-*+]\s+|\s*\d+[.)]\s+)/.test(lines[i]) &&
      !/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(lines[i])
    )
      para.push(renderInline(lines[i++]));
    html.push(`<p>${para.join("<br>")}</p>`);
  }

  return html.join("");
}
