// Explicit real-provider integration test through application handlers, no browser storage writes.
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import worker from '../dist/server/index.js';
import {normalizeVideo} from '../backend/normalize-video.mjs';
if(!process.argv.includes('--run-live'))throw new Error('Use --run-live to authorize real requests');
const root=fileURLToPath(new URL('../../',import.meta.url)),env={...process.env};
for(const file of ['webapp/.env.local','webapp/.env','.env.local','.env']){
 try{for(const line of (await fs.readFile(path.join(root,file),'utf8')).split(/\r?\n/)){
  const m=line.trim().match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);if(m&&env[m[1]]==null)env[m[1]]=m[2].replace(/^(["'])(.*)\1$/,'$2');
 }}catch(e){if(e.code!=='ENOENT')throw e}
}
env.NORMALIZE_VIDEO=normalizeVideo;
const model=process.argv.includes('--model')?process.argv[process.argv.indexOf('--model')+1]:'qwen3.8-flash';
const out=path.join(root,'outputs','model-integration',new Date().toISOString().replace(/[:.]/g,'-'));await fs.mkdir(out,{recursive:true});
const report={started:new Date().toISOString(),model,case:'小青蛙找家',results:[]};
async function call(name,url,body){
 const started=Date.now(),response=await worker.fetch(new Request('http://integration'+url,{method:'POST',headers:{'x-evaluation-model':model},body}),env),data=await response.json();
 const row={name,status:response.status,ok:response.ok,elapsed_ms:Date.now()-started,data};report.results.push(row);await fs.writeFile(path.join(out,'results.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({name,status:row.status,ok:row.ok,elapsed_ms:row.elapsed_ms,error:data.error,candidates:data.candidates?.length,model:data.model||data.analysis?.model}));return row;
}
const ready=await call('model_readiness','/api/classroom/model-readiness');if(!ready.ok||!ready.data.ready)process.exit(2);
const names=await fs.readdir(path.join(root,'test')),lesson=names.find(n=>n.includes('小青蛙')&&n.endsWith('.docx'));
if(process.argv.includes('--module-a-only')){
 const form=new FormData();form.set('files',new Blob([await fs.readFile(path.join(root,'test',lesson))]),lesson);form.set('basic',JSON.stringify({tool_name:'小青蛙找家'}));
 const result=await call('module_a_application','/api/evaluation/module-a',form);
 console.log(JSON.stringify({results_file:path.join(out,'results.json')}));
 if(!result.ok)process.exit(2);
 const rows=result.data.dimensions;
 assert.equal(rows?.length,5);
 assert.deepEqual(rows.map(r=>r.id).sort(),['A1','A2','A3','A4','A5']);
 for(const row of rows){
  assert.ok(Number.isInteger(row.score)&&row.score>=0&&row.score<=5,`${row.id} score`);
  assert.ok(typeof row.evidence==='string'&&row.evidence.trim(),`${row.id} evidence`);
  assert.ok(typeof row.modification==='string'&&row.modification.trim(),`${row.id} advice`);
  if(row.score<5)assert.doesNotMatch(row.modification,/^(?:暂无必要修改|需改进|建议完善|建议修改|待完善)[。.!！\s]*$/,`${row.id} deduction advice`);
 }
 console.log(JSON.stringify({verified:true,dimensions:rows.map(({id,score,modification})=>({id,score,modification}))}));
 process.exit(0);
}
const prepare=new FormData();prepare.set('lesson_plan',new Blob([await fs.readFile(path.join(root,'test',lesson))]),lesson);prepare.set('prepare_batches','true');
const extracted=await call('lesson_extract','/api/classroom/plan',prepare);if(!extracted.ok)process.exit(2);
const part=new FormData();part.set('lesson_plan',new Blob([extracted.data.chunks[0]]),'lesson-part.txt');part.set('batch_part','true');
const plan=await call('lesson_model','/api/classroom/plan',part);if(!plan.ok)process.exit(2);
const qwenRuns=(await fs.readdir(path.join(root,'outputs','qwen-diagnostics'))).sort().reverse();let clip;
for(const run of qwenRuns){const candidate=path.join(root,'outputs','qwen-diagnostics',run,'first-60s-silent.mp4');try{await fs.access(candidate);clip=candidate;break}catch{}}
if(!clip)throw new Error('Run the explicit Qwen case diagnostic once to prepare the known 60-second case clip');
const form=new FormData();form.set('mode','video');form.set('video',new Blob([await fs.readFile(clip)],{type:'video/mp4'}),'case-60s.mp4');form.set('duration','60');form.set('clip_offset','0');form.set('audio_present','false');form.set('lesson',plan.data.lesson||'小青蛙找家');form.set('goals',(plan.data.goals||[]).join('\n'));form.set('observation_plan',JSON.stringify(plan.data.observation_tasks||[]));
const video=await call('video_application','/api/classroom/video-candidates',form);
report.finished=new Date().toISOString();await fs.writeFile(path.join(out,'results.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({results_file:path.join(out,'results.json')}));
if(!video.ok||video.data.analysis?.model!==model||!Array.isArray(video.data.candidates))process.exitCode=2;
