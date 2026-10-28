import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import ffmpeg from 'ffmpeg-static';
import {createTranscriptionService} from '../backend/transcription-service.mjs';
if(!process.argv.includes('--run-live'))throw new Error('Explicit --run-live required');
const root=fileURLToPath(new URL('../../',import.meta.url));
const env={...process.env};
for(const name of ['webapp/.env.local','webapp/.env','.env.local','.env']){
 try{for(const line of (await fs.readFile(path.join(root,name),'utf8')).split(/\r?\n/)){
  const m=line.trim().match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
  if(m&&env[m[1]]==null)env[m[1]]=m[2].trim().replace(/^(["'])(.*)\1$/,'$2');
 }}catch(e){if(e.code!=='ENOENT')throw e}
}
if(!env.MINIMAX_API_KEY)throw new Error('Project MiniMax key unavailable');
const arg=(name,fallback)=>{const i=process.argv.indexOf(name);return i<0?fallback:process.argv[i+1]};
const video=path.resolve(arg('--video',path.join(root,'references/examples/教学评估/何蓥安（公开课）.mp4')));
const start=Number(arg('--start','0')),duration=Number(arg('--duration','120'));
if(!Number.isFinite(start)||start<0||!Number.isFinite(duration)||duration<=0||duration>420)throw new Error('Invalid sample range');
const out=path.join(root,'outputs','live-transcription',new Date().toISOString().replace(/[:.]/g,'-'));
await fs.mkdir(out,{recursive:true});
const clean=s=>String(s).split(env.MINIMAX_API_KEY).join('[REDACTED]');
const report={video:path.basename(video),start_seconds:start,duration_seconds:duration,model:env.MINIMAX_ASR_MODEL||'asr-1.0',api_origin:new URL(env.MINIMAX_API_BASE||'https://api.minimaxi.com/v1').origin,started:new Date().toISOString(),attempts:[],events:[]};
const persist=()=>fs.writeFile(path.join(out,'results.json'),clean(JSON.stringify(report,null,2)));
const audio=path.join(out,'sample.wav');
let server;
try{
 const extracted=Date.now();
 await promisify(execFile)(env.FFMPEG_PATH||ffmpeg,['-hide_banner','-loglevel','error','-nostdin','-ss',String(start),'-i',video,'-t',String(duration),'-map','0:a:0','-vn','-af','aresample=async=1:first_pts=0','-ar','16000','-ac','1','-c:a','pcm_s16le',audio],{windowsHide:true,timeout:120000});
 report.extraction_ms=Date.now()-extracted;report.audio_bytes=(await fs.stat(audio)).size;await persist();console.log(JSON.stringify({stage:'audio_extracted',video:report.video,seconds:duration,bytes:report.audio_bytes,output:out}));
 const handler=createTranscriptionService(env,{log:event=>report.events.push(JSON.parse(clean(JSON.stringify(event)))),fetcher:async(url,options)=>{
  const began=Date.now();let response;
  try{
   response=await fetch(url,options);const raw=clean(await response.clone().text());
   await fs.writeFile(path.join(out,`provider-response-${report.attempts.length+1}.txt`),raw);
   let payload;try{payload=JSON.parse(raw)}catch{}
   report.attempts.push({status:response.status,elapsed_ms:Date.now()-began,content_type:response.headers.get('content-type'),request_id:response.headers.get('x-request-id')||response.headers.get('request-id')||null,keys:payload&&Object.keys(payload),error:payload?.error||payload?.base_resp||null});await persist();
   console.log(JSON.stringify({stage:'provider_response',...report.attempts.at(-1)}));return response;
  }catch(error){report.attempts.push({status:response?.status||null,elapsed_ms:Date.now()-began,error:clean(error.message)});await persist();throw error}
 }});
 server=http.createServer(async(req,res)=>{try{if(!await handler(req,res,new URL(req.url,'http://local')))res.end()}catch(error){res.writeHead(500);res.end(clean(error.message))}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${server.address().port}`;
 const began=Date.now(),response=await fetch(base+'/api/classroom/transcription',{method:'POST',headers:{'content-type':'application/octet-stream','x-video-duration':String(duration)},body:await fs.readFile(audio)});
 const uploaded=await response.json();if(!response.ok)throw new Error(uploaded.error||'Start failed');
 const deadline=Date.now()+240000;
 let result;
 while(Date.now()<deadline){
  result=await (await fetch(base+'/api/classroom/transcription/'+uploaded.job_id)).json();
  if(['complete','failed','cancelled'].includes(result.status))break;
  await new Promise(resolve=>setTimeout(resolve,1500));
 }
 report.result=result;report.elapsed_ms=Date.now()-began;
 if(result?.status==='complete'){
  report.validation={segment_count:result.segments.length,timestamps_valid:result.segments.every(s=>Number.isFinite(s.start_seconds)&&Number.isFinite(s.end_seconds)&&s.start_seconds>=0&&s.end_seconds>s.start_seconds&&s.end_seconds<=duration),independent_listening_review:false};
  const label=s=>`${String(Math.floor(s/60)).padStart(2,'0')}:${(s%60).toFixed(2).padStart(5,'0')}`;
  await fs.writeFile(path.join(out,'transcript.txt'),result.segments.map(s=>`[${label(start+s.start_seconds)} - ${label(start+s.end_seconds)}] ${s.text}`).join('\n'));
 }
 report.finished=new Date().toISOString();await persist();console.log(JSON.stringify({stage:'finished',status:result?.status,message:result?.message,elapsed_ms:report.elapsed_ms,validation:report.validation,output:out}));
 if(result?.status!=='complete')process.exitCode=2;
}catch(error){report.failure=clean(error.message);await persist();console.log(JSON.stringify({stage:'failed',error:report.failure,output:out}));process.exitCode=2}
finally{if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}}
