// Interactive, explicit real-provider test. No production configuration is changed.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import ffmpeg from 'ffmpeg-static';
if(!process.argv.includes('--run-live'))throw new Error('Real requests require --run-live');
const keyFile=process.argv[process.argv.indexOf('--key-file')+1];
if(!process.argv.includes('--key-file')||!keyFile)throw new Error('Specify --key-file; never put a key in command arguments');
const root=fileURLToPath(new URL('../../',import.meta.url)),out=path.join(root,'outputs','qwen-diagnostics',new Date().toISOString().replace(/[:.]/g,'-'));
await fs.mkdir(out,{recursive:true});
const rawKey=await fs.readFile(keyFile),keyText=rawKey[0]===255&&rawKey[1]===254?rawKey.subarray(2).toString('utf16le'):rawKey.toString('utf8');
const keys=[...new Set(keyText.match(/sk-[A-Za-z0-9_-]{12,}/g)||[])],preferred=keys.filter(k=>k.startsWith('sk-sp-'));
const standalone=keyText.trim().replace(/^Bearer\s+/i,'').replace(/^(["'])(.*)\1$/,'$2');
if(!keys.length&&/^[A-Za-z0-9._~-]{16,512}$/.test(standalone))keys.push(standalone);
if((preferred.length||keys.length)!==1)throw new Error('Could not identify one unambiguous API key; key contents withheld');
const key=(preferred.length?preferred:keys)[0],clean=s=>String(s).split(key).join('[REDACTED]');
const base='https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',anthropic='https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic/v1/messages';
const report={started:new Date().toISOString(),provider:'Alibaba Cloud Token Plan',case:'小青蛙找家',results:[]};
const persist=()=>fs.writeFile(path.join(out,'results.json'),JSON.stringify(report,null,2));
async function call(model,content,max_tokens=1024){
 const response=await fetch(base+'/chat/completions',{method:'POST',signal:AbortSignal.timeout(120000),headers:{authorization:`Bearer ${key}`,'content-type':'application/json'},body:JSON.stringify({model,messages:[{role:'user',content}],enable_thinking:false,max_tokens,temperature:.1})});
 const text=clean(await response.text());let body;try{body=JSON.parse(text)}catch{}
 const answer=body?.choices?.[0]?.message?.content||'',reason=body?.choices?.[0]?.finish_reason;
 return {ok:response.ok&&Boolean(answer.trim())&&reason!=='length',status:response.status,model:body?.model||model,request_id:response.headers.get('x-request-id')||body?.request_id||body?.id,finish_reason:reason,usage:body?.usage,answer,error:response.ok?reason==='length'?'model_output_truncated':!answer.trim()?'empty_output':undefined:body?.error||text.slice(0,1200)};
}
async function probe(name,run){
 const started=Date.now();let result;try{result=await run()}catch(e){result={ok:false,error_type:e.name,error:clean(e.message)}}
 if(result.ok&&(name==='case_lesson_plan'||/^case_\d+s_video$/.test(name))){
  try{
   const answer=result.answer,data=JSON.parse(answer.slice(answer.indexOf('{'),answer.lastIndexOf('}')+1));
   const seconds=Number(name.match(/^case_(\d+)s_video$/)?.[1]);
   result.schema_valid=name==='case_lesson_plan'?Array.isArray(data.observation_tasks)&&data.observation_tasks.length>0&&data.observation_tasks.every(t=>['task','success_criteria','allowed_assistance'].every(k=>String(t[k]||'').trim())):Array.isArray(data.events)&&data.audio_available===false&&data.events.every(e=>Number.isFinite(e.start_seconds)&&Number.isFinite(e.end_seconds)&&e.start_seconds>=0&&e.end_seconds>e.start_seconds&&e.end_seconds<=seconds&&String(e.actual_response||'').trim());
   result.parsed_result=data;if(!result.schema_valid){result.ok=false;result.error='schema_validation_failed'}
  }catch{result.ok=false;result.schema_valid=false;result.error='invalid_json_result'}
 }
 const row={name,elapsed_ms:Date.now()-started,...result};report.results.push(row);await persist();console.log(JSON.stringify({name,status:row.status,ok:row.ok,elapsed_ms:row.elapsed_ms,error:row.error,answer_preview:row.answer?.slice(0,200)}));
 await new Promise(r=>setTimeout(r,1800));return row;
}
const flash=await probe('qwen3.8-flash_minimal_text',()=>call('qwen3.8-flash','你好，请只回复 OK。',128));
const max=await probe('qwen3.8-max_minimal_text',()=>call('qwen3.8-max','你好，请只回复 OK。',128));
if(!flash.ok&&!max.ok){report.finished=new Date().toISOString();await persist();console.log(JSON.stringify({results_file:path.join(out,'results.json')}));process.exit(2)}
const model=flash.ok?'qwen3.8-flash':'qwen3.8-max';
await probe('anthropic_minimal_text',async()=>{
 const response=await fetch(anthropic,{method:'POST',signal:AbortSignal.timeout(60000),headers:{'x-api-key':key,'anthropic-version':'2023-06-01','content-type':'application/json'},body:JSON.stringify({model,max_tokens:128,thinking:{type:'disabled'},messages:[{role:'user',content:'你好，请只回复 OK。'}]})});
 const text=clean(await response.text());let body;try{body=JSON.parse(text)}catch{}
 const answer=body?.content?.filter(c=>c.type==='text').map(c=>c.text).join('\n')||'';
 return {ok:response.ok&&Boolean(answer),status:response.status,answer,usage:body?.usage,request_id:response.headers.get('x-request-id')||body?.request_id,error:response.ok?undefined:body?.error||text.slice(0,1200)};
});
const exec=promisify(execFile),files=await fs.readdir(path.join(root,'test')),source=files.find(f=>f.includes('小青蛙')&&f.endsWith('.mp4'));
if(!source)throw new Error('Case video not found');
const video=path.join(root,'test',source);
const frame=path.join(out,'case-frame.jpg');
await exec(ffmpeg,['-y','-loglevel','error','-nostdin','-ss','3','-i',video,'-frames:v','1','-vf','scale=640:-2',frame],{windowsHide:true,timeout:30000});
const frameBytes=await fs.readFile(frame);
await probe('case_single_frame',()=>call(model,[{type:'image_url',image_url:{url:'data:image/jpeg;base64,'+frameBytes.toString('base64')}},{type:'text',text:'只描述这张课堂画面中可见的人物动作和物品。不要识别姓名，不推断声音或学习效果。简短回答。'}],768));
const lessonFiles=await fs.readdir(path.join(root,'outputs','live-diagnostics'));
let lesson='';
for(const dir of lessonFiles){try{lesson=await fs.readFile(path.join(root,'outputs','live-diagnostics',dir,'lesson-extracted.txt'),'utf8');if(lesson)break}catch{}}
if(lesson){
 await probe('case_lesson_plan',()=>call(model,'根据下面教案原文提取观察参照，不能把教案预期当作视频已经发生的事实。学生匿名。不编造次数和准确率。只返回JSON：{"lesson":"课名","goals":[],"observation_tasks":[{"task":"任务","success_criteria":"达成条件","allowed_assistance":"教案允许的辅助；未明确则如实注明"}]}。最多4个核心任务。教案原文：\n'+lesson.slice(0,10000),2048));
}
for(const seconds of [5,60]){
 const target=path.join(out,`first-${seconds}s-silent.mp4`);
 await exec(ffmpeg,['-y','-loglevel','error','-nostdin','-i',video,'-t',String(seconds),'-an','-vf','scale=640:-2','-c:v','libx264','-preset','veryfast','-crf','26','-pix_fmt','yuv420p','-movflags','+faststart',target],{windowsHide:true,timeout:120000});
 const bytes=await fs.readFile(target);
 await probe(`case_${seconds}s_video`,()=>call(model,[{type:'video_url',video_url:{url:'data:video/mp4;base64,'+bytes.toString('base64')},fps:2},{type:'text',text:`这是《小青蛙找家》课堂视频开头${seconds}秒，仅有画面，无声音。请按时间顺序描述实际可见的动作和物品，不编造口头指令、节奏、准确率或学习效果。时间必须在0到${seconds}秒内；无法判断写未知。只输出JSON：{"summary":"实际活动概述","events":[{"start_seconds":0,"end_seconds":1,"actual_response":"实际可见动作","limitations":"看不清或缺少前后过程的限制"}],"audio_available":false}。最多8条。` }],2048));
}
report.finished=new Date().toISOString();await persist();console.log(JSON.stringify({results_file:path.join(out,'results.json')}));
if(report.results.some(r=>!r.ok))process.exitCode=2;
