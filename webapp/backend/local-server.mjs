import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import worker from "../dist/server/index.js";
import { createTranscriptionService } from "./transcription-service.mjs";
import { normalizeVideo } from "./normalize-video.mjs";
import {createDiagnostics,diagnosticId,redactDiagnostics} from './diagnostics.mjs';
import {createVideoSourceService} from './video-source-service.mjs';

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
const diagnosticSecrets=[process.env.QWEN_API_KEY,process.env.MINIMAX_API_KEY].filter(Boolean);
const diagnostics=createDiagnostics({directory:process.env.DIAGNOSTICS_DIR||path.resolve(backendDir,'../../outputs/logs'),secrets:diagnosticSecrets});
const videoSources=createVideoSourceService();
const transcriptionService=createTranscriptionService(process.env,{log:event=>diagnostics.write(event),storage:videoSources.storage});

const server = http.createServer(async (incoming, outgoing) => {
  const parsedUrl=new URL(incoming.url||'/',`http://${host}:${port}`);
  if(parsedUrl.pathname.startsWith('/api/diagnostics/')){try{await diagnostics.handle(incoming,outgoing,parsedUrl)}catch{outgoing.writeHead(500,{'content-type':'application/json'});outgoing.end(JSON.stringify({error:'诊断日志暂不可读取'}))}return}
  const id=diagnosticId(incoming.headers['x-diagnostic-id']),started=Date.now(),timings={};
  const requestAbort=new AbortController();outgoing.once('close',()=>{if(!outgoing.writableEnded)requestAbort.abort()});
  const runId=String(incoming.headers['x-analysis-run-id']||'').slice(0,80);
  let modelFailure=null;
  const log=event=>{if(event.event==='model_attempt'&&(event.status>=400||event.outcome==='failure'))modelFailure=event;return diagnostics.write({diagnostic_id:id,run_id:runId,api_path:parsedUrl.pathname,...event})};
  outgoing.setHeader('x-diagnostic-id',id);
  incoming.headers['x-diagnostic-id']=id;
  if(parsedUrl.pathname.startsWith('/api/')){
    void log({event:'request_start',method:incoming.method,model:String(incoming.headers['x-evaluation-model']||process.env.DEFAULT_AI_MODEL||'qwen3.8-max'),bytes:Number(incoming.headers['content-length'])||null});
    outgoing.once('finish',()=>void log({event:'request_end',http_status:outgoing.statusCode,elapsed_ms:Date.now()-started,timings}));
  }
  try {
    if(await videoSources.handle(incoming,outgoing,parsedUrl,{log,diagnostic_id:id}))return;
    if (await transcriptionService(incoming, outgoing, parsedUrl)) return;
    const chunks = [];
    for await (const chunk of incoming) chunks.push(chunk);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const url = `http://${host}:${port}${incoming.url || "/"}`;
    const headers = new Headers();
    for (const [name, value] of Object.entries(incoming.headers)) {
      if (Array.isArray(value)) value.forEach(item => headers.append(name, item));
      else if (value != null) headers.set(name, value);
    }
    const request = new Request(url, { method: incoming.method, headers, body,signal:requestAbort.signal });
    const response = await worker.fetch(request, {
      DIAGNOSTIC_ID:id,DIAGNOSTICS_TIMINGS:timings,DIAGNOSTICS_LOG:log,REQUEST_ABORT_SIGNAL:requestAbort.signal,
      PREPARE_VIDEO_SCREEN:(sourceId,start,duration)=>videoSources.prepareScreen(sourceId,start,duration,{signal:requestAbort.signal}),
      PREPARE_VIDEO_CLIP:async(sourceId,start,duration)=>{
        const begin=Date.now();void log({event:'stage_start',stage:'video_slice',source_id:sourceId,start_seconds:start,duration_seconds:duration});
        try{const result=await videoSources.prepareClip(sourceId,start,duration,{signal:requestAbort.signal});void log({event:'stage_complete',stage:'video_slice',elapsed_ms:Date.now()-begin,bytes:result.size});return result}
        catch(error){void log({event:'stage_failed',stage:'video_slice',elapsed_ms:Date.now()-begin,code:error.code,message:error.message});throw error}
        finally{timings.slice_ms=Date.now()-begin}
      },
      NORMALIZE_VIDEO:async file=>{
        const begin=Date.now();void log({event:'stage_start',stage:'video_normalize',bytes:file.size,media_type:file.type});
        try{const result=await normalizeVideo(file);void log({event:'stage_complete',stage:'video_normalize',elapsed_ms:Date.now()-begin,bytes:result.size});return result}
        catch(error){void log({event:'stage_failed',stage:'video_normalize',elapsed_ms:Date.now()-begin,error_type:error.name,message:error.message});throw error}
        finally{timings.normalization_ms=Date.now()-begin}
      },
      DEFAULT_AI_MODEL: process.env.DEFAULT_AI_MODEL || 'qwen3.8-max',
      QWEN_API_KEY: process.env.QWEN_API_KEY || '',
      QWEN_API_BASE: process.env.QWEN_API_BASE || 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      MINIMAX_API_KEY: process.env.MINIMAX_API_KEY || "",
      MINIMAX_MODEL: process.env.MINIMAX_MODEL || "MiniMax-M3",
      MINIMAX_API_BASE: process.env.MINIMAX_API_BASE || "https://api.minimaxi.com/v1",
      MINIMAX_ANTHROPIC_BASE: process.env.MINIMAX_ANTHROPIC_BASE || "https://api.minimaxi.com/anthropic/v1"
    });
    const responseHeaders=Object.fromEntries(response.headers);let responseBytes=Buffer.from(await response.arrayBuffer());
    if(String(responseHeaders['content-type']).includes('application/json')){
      try{
        const data=JSON.parse(responseBytes.toString('utf8'));
        if(data&&typeof data==='object'&&!Array.isArray(data)){
          data.diagnostic_id??=id;data.timings??=timings;
          if(response.status>=400&&modelFailure&&!data.failure_detail)data.failure_detail={diagnostic_id:id,stage:'model_request',code:modelFailure.provider_code,provider_message:modelFailure.provider_message,upstream_status:modelFailure.status,upstream_request_id:modelFailure.request_id};
          responseBytes=Buffer.from(JSON.stringify(data));delete responseHeaders['content-length'];
        }
      }catch{}
    }
    outgoing.writeHead(response.status,responseHeaders);
    outgoing.end(responseBytes);
  } catch (error) {
    outgoing.writeHead(500, { "content-type": "application/json; charset=utf-8" });
    void log({event:'request_failed',stage:'local_server',message:error.message,error_type:error.name});
    outgoing.end(JSON.stringify(redactDiagnostics({ error: error instanceof Error ? error.message : "本地服务错误",diagnostic_id:id },diagnosticSecrets)));
  }
});

server.listen(port, host, () => {
  console.log(`本地评估网站已启动：http://${host}:${port}/`);
  console.log(`默认评估模型：${process.env.DEFAULT_AI_MODEL || 'qwen3.8-max'}；千问密钥：${process.env.QWEN_API_KEY ? '已配置' : '未配置'}；MiniMax 密钥：${process.env.MINIMAX_API_KEY ? '已配置' : '未配置'}。`);
});
