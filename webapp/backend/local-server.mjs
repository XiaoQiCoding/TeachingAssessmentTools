import http from "node:http";
import worker from "../dist/server/index.js";

const host = "127.0.0.1";
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
      MINIMAX_API_KEY: process.env.MINIMAX_API_KEY || ""
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
  console.log("模型密钥由本地服务保管，网页无需填写试用码。");
});
