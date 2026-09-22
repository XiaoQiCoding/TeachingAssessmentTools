import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import worker from "../dist/server/index.js";

const backendDir = path.dirname(fileURLToPath(import.meta.url));
const envFiles = [path.resolve(backendDir, "../.env.local"), path.resolve(backendDir, "../.env"), path.resolve(backendDir, "../../.env.local"), path.resolve(backendDir, "../../.env")];

function parseEnv(text) {
  const values = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    values[match[1]] = value;
  }
  return values;
}

for (const envFile of envFiles) {
  try {
    const values = parseEnv(await fs.readFile(envFile, "utf8"));
    for (const [name, value] of Object.entries(values)) if (process.env[name] == null) process.env[name] = value;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 4174);

const server = http.createServer(async (incoming, outgoing) => {
  try {
    const chunks = [];
    for await (const chunk of incoming) chunks.push(chunk);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const url = `http://${host}:${port}${incoming.url || "/"}`;
    const headers = new Headers();
    for (const [name, value] of Object.entries(incoming.headers)) {
      if (Array.isArray(value)) value.forEach(item => headers.append(name, item));
      else if (value != null) headers.set(name, value);
    }
    const request = new Request(url, { method: incoming.method, headers, body });
    const response = await worker.fetch(request, {
      MINIMAX_API_KEY: process.env.MINIMAX_API_KEY || "",
      MINIMAX_MODEL: process.env.MINIMAX_MODEL || "MiniMax-M3",
      MINIMAX_API_BASE: process.env.MINIMAX_API_BASE || "https://api.minimaxi.com/v1",
      MINIMAX_ANTHROPIC_BASE: process.env.MINIMAX_ANTHROPIC_BASE || "https://api.minimaxi.com/anthropic/v1"
    });
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    outgoing.writeHead(500, { "content-type": "application/json; charset=utf-8" });
    outgoing.end(JSON.stringify({ error: error instanceof Error ? error.message : "本地服务错误" }));
  }
});

server.listen(port, host, () => {
  console.log(`本地评估网站已启动：http://${host}:${port}/`);
  console.log(`评估模型：${process.env.MINIMAX_MODEL || "MiniMax-M3"}；密钥状态：${process.env.MINIMAX_API_KEY ? "已配置" : "未配置"}。`);
});
