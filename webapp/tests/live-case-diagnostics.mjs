// Explicit opt-in only. Makes real, sequential MiniMax requests using local credentials.
// Never part of npm test. Usage: node tests/live-case-diagnostics.mjs --run-live
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import ffmpeg from 'ffmpeg-static';
import worker from '../dist/server/index.js';
import {normalizeVideo} from '../backend/normalize-video.mjs';
if(!process.argv.includes('--run-live'))throw new Error('Real requests require --run-live');
const root=fileURLToPath(new URL('../../',import.meta.url));
const out=path.join(root,'outputs','live-diagnostics',new Date().toISOString().replace(/[:.]/g,'-'));
await fs.mkdir(out,{recursive:true});
const env={...process.env};
for(const file of ['webapp/.env.local','webapp/.env','.env.local','.env']){
 try{for(const line of (await fs.readFile(path.join(root,file),'utf8')).split(/\r?\n/)){
  const m=line.trim().match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);if(!m||env[m[1]]!=null)continue;
  env[m[1]]=m[2].replace(/^(["'])(.*)\1$/,'$2');
 }}catch(e){if(e.code!=='ENOENT')throw e}
}
if(!env.MINIMAX_API_KEY)throw new Error('Local MiniMax credentials not configured');
const model=env.MINIMAX_MODEL||'MiniMax-M3',base=(env.MINIMAX_API_BASE||'https://api.minimaxi.com/v1').replace(/\/$/,''),media=(env.MINIMAX_ANTHROPIC_BASE||'https://api.minimaxi.com/anthropic/v1').replace(/\/$/,'');
const report={started:new Date().toISOString(),case:'小青蛙找家',configuration:{model,text_origin:new URL(base).origin,media_origin:new URL(media).origin},results:[]};
const clean=text=>String(text).split(env.MINIMAX_API_KEY).join('[REDACTED]');
const persist=()=>fs.writeFile(path.join(out,'results.json'),JSON.stringify(report,null,2));
async function probe(name,run){
 const started=Date.now();let result;
 try{result=await run()}catch(e){result={ok:false,error_type:e.name,error:clean(e.message)}}
 const row={name,elapsed_ms:Date.now()-started,...result};report.results.push(row);await persist();console.log(JSON.stringify({name,elapsed_ms:row.elapsed_ms,status:row.status,ok:row.ok,error:row.error,request_id:row.request_id}));
 await new Promise(r=>setTimeout(r,2500));return row;
}
async function raw(url,payload,anthropic=false){
 const response=await fetch(url,{method:'POST',signal:AbortSignal.timeout(90000),headers:{'content-type':'application/json',...(anthropic?{'x-api-key':env.MINIMAX_API_KEY,'anthropic-version':'2023-06-01'}:{authorization:`Bearer ${env.MINIMAX_API_KEY}`})},body:JSON.stringify(payload)});
 const text=clean(await response.text());let data;try{data=JSON.parse(text)}catch{}
 return {ok:response.ok,status:response.status,request_id:response.headers.get('x-request-id')||response.headers.get('request-id')||data?.request_id||null,retry_after:response.headers.get('retry-after'),body:data||text.slice(0,2000),error:response.ok?undefined:JSON.stringify(data?.error||data?.base_resp||text.slice(0,1000))};
}
const textPayload={model,max_completion_tokens:128,temperature:.1,thinking:{type:'disabled'},reasoning_split:true,messages:[{role:'user',content:'请只回复 OK。'}]};
if(process.argv.includes('--baseline-only')){
 const reference=process.argv[process.argv.indexOf('--baseline-only')+1];if(!/^MiniMax-[A-Za-z0-9.]+$/.test(reference||''))throw new Error('Expected an explicit reference model');
 report.configuration.reference_model=reference;
 const payload={model:reference,max_completion_tokens:256,temperature:.1,messages:[{role:'user',content:'请只回复 OK。'}]};
 await probe('reference_model_text',()=>raw(base+'/chat/completions',payload));report.finished=new Date().toISOString();await persist();console.log(JSON.stringify({results_file:path.join(out,'results.json')}));process.exit(0);
}
await probe('minimal_openai_text',()=>raw(base+'/chat/completions',textPayload));
const mediaPayload={model,max_tokens:256,temperature:.1,messages:[{role:'user',content:[{type:'text',text:'请只回复 OK。'}]}]};
await probe('minimal_anthropic_text',()=>raw(media+'/messages',mediaPayload,true));
const files=await fs.readdir(path.join(root,'test')),lesson=files.find(f=>f.includes('小青蛙')&&f.endsWith('.docx')),video=files.find(f=>f.includes('小青蛙')&&f.endsWith('.mp4'));
if(!lesson||!video)throw new Error('Case lesson and video not found');
const planForm=new FormData();planForm.append('lesson_plan',new Blob([await fs.readFile(path.join(root,'test',lesson))]),lesson);planForm.append('prepare_batches','true');
const prepared=await worker.fetch(new Request('http://diagnostic/api/classroom/plan',{method:'POST',body:planForm}),env);const extracted=await prepared.json();
await probe('case_document_extraction',async()=>({ok:prepared.ok,status:prepared.status,chunks:extracted.chunks?.length,characters:extracted.chunks?.join('').length,error:extracted.error}));
if(prepared.ok){await fs.writeFile(path.join(out,'lesson-extracted.txt'),extracted.chunks.join(''));}
const part=new FormData();part.append('lesson_plan',new Blob([extracted.chunks?.[0]||'']), 'lesson.part-1.txt');part.append('batch_part','true');
let plan;
await probe('case_plan_first_batch',async()=>{const response=await worker.fetch(new Request('http://diagnostic/api/classroom/plan',{method:'POST',body:part}),env);plan=await response.json();return {ok:response.ok,status:response.status,body:plan,error:plan.error}});
const run=promisify(execFile);
for(const seconds of [5,60]){
 const target=path.join(out,`first-${seconds}s.mp4`);
 await run(ffmpeg,['-y','-loglevel','error','-nostdin','-i',path.join(root,'test',video),'-t',String(seconds),'-vf','scale=640:-2','-c:v','libx264','-preset','veryfast','-crf','26','-pix_fmt','yuv420p','-c:a','aac','-b:a','64k','-movflags','+faststart',target],{windowsHide:true,timeout:120000});
 const bytes=await fs.readFile(target);
 if(seconds===5)await probe('case_5s_native_video',()=>raw(media+'/messages',{...mediaPayload,max_tokens:512,messages:[{role:'user',content:[{type:'text',text:'简述视频内可见的实际活动；看不清或听不清时说明，不推断。只描述这5秒。'},{type:'video',source:{type:'base64',media_type:'video/mp4',data:bytes.toString('base64')}}]}]},true));
 if(seconds===60){
  const form=new FormData();form.append('mode','video');form.append('video',new Blob([bytes],{type:'video/mp4'}),'case-first-60s.mp4');form.append('duration','60');form.append('clip_offset','0');form.append('lesson','小青蛙找家');form.append('goals',(plan?.goals||[]).join('\n'));form.append('observation_plan',JSON.stringify(plan?.observation_tasks||[]));form.append('audio_present','true');
  await probe('case_60s_application_video',async()=>{const response=await worker.fetch(new Request('http://diagnostic/api/classroom/video-candidates',{method:'POST',body:form}),{...env,NORMALIZE_VIDEO:normalizeVideo});const data=await response.json();return {ok:response.ok,status:response.status,clip_bytes:bytes.length,body:data,error:data.error}});
 }
}
const minimal=report.results.filter(r=>r.name.startsWith('minimal_'));
report.diagnosis={minimal_requests_failed:minimal.every(r=>!r.ok),overload_reproduced:minimal.every(r=>r.status===529),case_completed:report.results.filter(r=>r.name.startsWith('case_')).every(r=>r.ok),note:minimal.every(r=>r.status===529)?'最小文字请求及案例请求均失败，当前模型服务路径返回过载；本轮没有获得课堂分析结果，不能评价分析准确率。':'结合各项原始返回检查接口、解析与素材处理结果。'};
report.finished=new Date().toISOString();await persist();console.log(JSON.stringify({results_file:path.join(out,'results.json'),diagnosis:report.diagnosis}));
if(!report.diagnosis.case_completed)process.exitCode=2;
