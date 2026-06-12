#!/usr/bin/env node
/**
 * Claude Bridge Server
 * 启动方式：node bridge.js
 * 默认监听 http://localhost:3737
 */

const http = require("http");
const { spawn } = require("child_process");

const PORT = 3737;

// 旧版 CLI 不支持 --include-partial-messages（逐字流式），启动时探测一次
const supportsPartial = new Promise((resolve) => {
  const probe = spawn("claude", ["--help"], { shell: true });
  let helpText = "";
  probe.stdout.on("data", (d) => (helpText += d.toString()));
  probe.on("close", () => resolve(helpText.includes("--include-partial-messages")));
  probe.on("error", () => resolve(false));
});
supportsPartial.then((ok) => {
  if (ok) {
    console.log("   逐字流式：已启用");
  } else {
    console.log("⚠️  当前 claude CLI 不支持逐字流式，回答将整段返回");
    console.log("   升级可启用：claude update（或 npm i -g @anthropic-ai/claude-code）");
  }
});

const server = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method !== "POST" || req.url !== "/ask") {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", async () => {
    let context, question;
    try {
      ({ context, question } = JSON.parse(body));
    } catch {
      res.writeHead(400);
      res.end("Invalid JSON");
      return;
    }

    // 健康检查 ping，直接返回
    if (question === "__ping__") {
      res.writeHead(200);
      res.end("pong");
      return;
    }

    const prompt = context
      ? `以下是页面选中的内容：\n\n---\n${context}\n---\n\n${question || "请根据以上内容给我一个总结或分析"}`
      : question || "你好";

    res.writeHead(200, {
      "Content-Type": "text/plain; charset=utf-8",
      "Transfer-Encoding": "chunked",
      "X-Content-Type-Options": "nosniff",
    });

    console.log(`[${new Date().toLocaleTimeString()}] 收到请求（prompt ${prompt.length} 字），调用 claude...`);

    const startedAt = Date.now();
    const elapsed = () => Math.round((Date.now() - startedAt) / 1000);

    // 心跳日志：让终端能看出 claude 还活着，而不是卡死
    const heartbeat = setInterval(() => {
      console.log(`  ... claude 运行中 (已 ${elapsed()}s)`);
    }, 5000);

    // stream-json：claude 输出 NDJSON 事件流；逐字增量标志仅在 CLI 支持时附加
    const args = ["-p", "--output-format", "stream-json", "--verbose"];
    if (await supportsPartial) args.push("--include-partial-messages");
    // 可选：设置环境变量 CLAUDE_MODEL=haiku 用更快的模型
    if (process.env.CLAUDE_MODEL) args.push("--model", process.env.CLAUDE_MODEL);

    // prompt 走 stdin，不拼进命令行：
    // 1. 避免 Windows 上换行/引号破坏命令
    // 2. 避免页面选中内容造成命令注入
    const child = spawn("claude", args, {
      env: { ...process.env },
      shell: true,
    });
    child.stdin.write(prompt);
    child.stdin.end();

    // stdout 是一行一个 JSON 事件（NDJSON）：按行切割，只转发文字增量
    let lineBuf = "";
    let sentChars = 0;

    function handleEvent(ev) {
      // 增量文字事件：{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"..."}}}
      const delta = ev?.event?.delta;
      if (ev.type === "stream_event" && delta?.type === "text_delta" && delta.text) {
        if (sentChars === 0) console.log(`  首个文字增量到达 (${elapsed()}s)`);
        sentChars += delta.text.length;
        res.write(delta.text);
        return;
      }
      // 兜底：CLI 版本不支持增量事件时，用最终 result 一次性返回
      if (ev.type === "result") {
        if (sentChars === 0 && typeof ev.result === "string") {
          console.log(`  未收到增量事件，回退为完整 result (${elapsed()}s)`);
          res.write(ev.result);
          sentChars += ev.result.length;
        }
        if (ev.is_error) console.error("[claude result] is_error=true");
      }
    }

    child.stdout.on("data", (data) => {
      lineBuf += data.toString();
      const lines = lineBuf.split("\n");
      lineBuf = lines.pop(); // 末尾可能是被分块劈开的半行 JSON，留到下次拼
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          handleEvent(JSON.parse(line));
        } catch {
          // 非 JSON 行（如启动警告）直接忽略
        }
      }
    });

    child.stderr.on("data", (data) => {
      console.error("[claude stderr]", data.toString());
    });

    child.on("close", (code) => {
      clearInterval(heartbeat);
      console.log(`[${new Date().toLocaleTimeString()}] 完成，exit code: ${code}，耗时 ${elapsed()}s，共 ${sentChars} 字`);
      if (sentChars === 0 && code !== 0) {
        res.write(`[错误] claude 退出码 ${code}，无输出。请看 bridge 终端的 stderr 日志。`);
      }
      res.end();
    });

    child.on("error", (err) => {
      clearInterval(heartbeat);
      console.error("启动 claude 失败:", err.message);
      res.write(`\n[错误] 无法启动 claude 命令：${err.message}\n请确认 claude CLI 已安装并在 PATH 中。`);
      res.end();
    });
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`✅ Claude Bridge 已启动：http://127.0.0.1:${PORT}`);
  console.log(`   等待插件连接中...`);
});
