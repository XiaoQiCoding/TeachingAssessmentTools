import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import worker from '../dist/server/index.js';
import {createDiagnostics,redactDiagnostics} from '../backend/diagnostics.mjs';
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'evaluation-diagnostics-test-'));
try{
 const logger=createDiagnostics({directory:dir,secrets:['private-provider-key'],maxBytes:700,maxFiles:3}),id=randomUUID();
 await logger.write({diagnostic_id:id,event:'test',message:'Bearer private-provider-key data:video/mp4;base64,QUJDREVGRw==',prompt:'PRIVATE LESSON',body:'PRIVATE VIDEO'});
 const text=(await fs.readFile(path.join(dir,(await fs.readdir(dir))[0]),'utf8'));
 assert.ok(!text.includes('private-provider-key'));assert.ok(!text.includes('PRIVATE LESSON'));assert.ok(!text.includes('PRIVATE VIDEO'));assert.ok(!text.includes('QUJDREVGRw=='));
 assert.equal((await logger.read(id)).length,1);assert.equal(await logger.read('../secrets'),null);
 const afterRestart=createDiagnostics({directory:dir});assert.equal((await afterRestart.read(id)).length,1,'Persisted logs remain available after restart');
 for(let i=0;i<15;i++)await logger.write({diagnostic_id:randomUUID(),event:'rotation',message:'a'.repeat(90),i});
 assert.ok((await fs.readdir(dir)).length<=3,'Bound log retention');
 assert.ok(!JSON.stringify(redactDiagnostics({headers:{authorization:'Bearer secret'},api_key:'secret',usage:{input_tokens:12}})).includes('secret'));

 const events=[],timings={},env={QWEN_API_KEY:'private-provider-key',DIAGNOSTIC_ID:id,DIAGNOSTICS_LOG:e=>events.push(e),DIAGNOSTICS_TIMINGS:timings};
 const original=globalThis.fetch;
 const form=()=>{const f=new FormData();f.set('mode','video');f.set('video',new Blob(['video'],{type:'video/mp4'}),'clip.mp4');f.set('duration','60');return f};
 const request=()=>new Request('http://test/api/classroom/video-candidates',{method:'POST',headers:{'x-evaluation-model':'qwen3.8-flash'},body:form()});
 try{
  globalThis.fetch=async()=>Response.json({error:{code:'InvalidParameter',message:'Video size exceeds the limit; private-provider-key'}},{status:400,headers:{'x-request-id':'upstream-request-123'}});
  let response=await worker.fetch(request(),env),data=await response.json();
  assert.equal(data.failure_detail.stage,'model_request');assert.equal(data.failure_detail.code,'InvalidParameter');assert.equal(data.failure_detail.upstream_status,400);assert.equal(data.failure_detail.upstream_request_id,'upstream-request-123');assert.equal(data.failure_detail.diagnostic_id,id);assert.ok(data.failure_detail.provider_message.includes('Video size exceeds'));
  assert.ok(!JSON.stringify(data).includes('private-provider-key'));assert.ok(events.some(e=>e.event==='model_attempt'&&e.status===400));assert.ok(Number.isFinite(data.timings.model_ms));
  assert.ok(!JSON.stringify(events).includes('private-provider-key'));
  response=await worker.fetch(request(),{...env,NORMALIZE_VIDEO:async()=>{throw new Error('invalid encoded video')}});data=await response.json();assert.equal(data.failure_detail.stage,'video_normalize');
  globalThis.fetch=async()=>Response.json({choices:[{message:{content:'not JSON'},finish_reason:'stop'}]});
  response=await worker.fetch(request(),env);data=await response.json();assert.equal(data.failure_detail.stage,'validation');
  globalThis.fetch=async()=>Response.json({choices:[{message:{content:'{"summary":"ok","candidates":[]}'},finish_reason:'stop'}],usage:{prompt_tokens:23,completion_tokens:6}});
  response=await worker.fetch(request(),{...env,NORMALIZE_VIDEO:async f=>f});data=await response.json();assert.equal(data.analysis.timings.normalization_ms>=0,true);assert.equal(data.analysis.timings.model_ms>=0,true);assert.equal(data.diagnostic_id,id);
 }finally{globalThis.fetch=original}
}finally{if(path.dirname(path.resolve(dir))!==path.resolve(os.tmpdir())||!path.basename(dir).startsWith('evaluation-diagnostics-test-'))throw new Error('Unsafe test cleanup path');await fs.rm(dir,{recursive:true,force:true})}

// Execute the real clip controller; upload, server slicing and rendering stay separate.
const html=await fs.readFile(new URL('../frontend/classroom.html',import.meta.url),'utf8');
const code=html.slice(html.indexOf('  async function analyzeClip(){'),html.indexOf('  // Cover the entire recording'));
const displayCode=html.slice(html.indexOf('  function diagnosticDuration('),html.indexOf('  async function downloadRequestDiagnostic('));
const display=new Function('escapeHtml',displayCode+';return windowDiagnosticHtml')(s=>String(s).replaceAll('<','&lt;').replaceAll('>','&gt;'));
assert.ok(display({status:'failed'}).includes('未记录'));assert.ok(display({status:'failed',failure_detail:{provider_message:'<script>bad</script>',stage:'model_request',code:'InvalidParameter'}}).includes('&lt;script&gt;'));
const originalNow=Date.now;let clock=1000,fail=false;
Date.now=()=>clock;
try{
 const controls=new Map(),$=key=>{if(!controls.has(key))controls.set(key,{value:'',duration:60,checked:true,classList:{add(){},remove(){}}});return controls.get(key)};
 $('#clipStart').value=0;$('#clipEnd').value=60;
 const w={id:'W1',start_seconds:0,end_seconds:60,video_identity:'v',status:'pending'};
 const fetch=async(_url,options)=>{assert.equal(options.body.get('video'),null,'Browser must not record/reupload a clip');assert.equal(options.body.get('video_source_id'),'source');clock+=fail?500:20000;return fail?Response.json({error:'HTTP400',failure_detail:{stage:'model_request',code:'InvalidParameter',provider_message:'invalid video'},timings:{model_ms:500}},{status:502}):Response.json({summary:'ok',candidates:[],analysis:{model:'qwen3.8-flash',timings:{slice_ms:3000,model_ms:16000,validation_ms:2}}})};
 const run=new Function('$','fetch','recommendedWindows',`
 let clipBusy=false,stopClip=null,serverVideoSource=null,transcriptBusy=false,videoUrl='blob',videoIdentity='v',selectedWindowId='W1',autoBusy=true,autoAbort=new AbortController(),candidates=[],events=[],analysisInfo={},reportData=null;
 const tasksReady=()=>true,waitForVideoMetadata=async()=>{},ensureServerVideoSource=async()=>advanceUpload(),timeLabel=String,mergeCandidateEvidence=(a,b)=>[...a,...b],renderCandidates=()=>advanceRender(),renderWindows=()=>{},saveDraft=()=>{};
 ${code}
 return analyzeClip;
 `)($,fetch,[w]);
 let uploadCount=0;globalThis.advanceUpload=()=>{const upload_ms=uploadCount++?0:5000;clock+=upload_ms;return {source_id:'source',has_audio:true,upload_ms}};globalThis.advanceRender=()=>clock+=700;
 await run();assert.equal(w.last_attempt.capture_ms,0);assert.equal(w.last_attempt.upload_ms,5000);assert.equal(w.last_attempt.request_ms,20000);assert.equal(w.last_attempt.slice_ms,3000);assert.equal(w.last_attempt.model_ms,16000);
 fail=true;await assert.rejects(run(),/HTTP400/);assert.equal(w.failure_detail.code,'InvalidParameter');assert.equal(w.timing_totals.upload_ms,5000);assert.equal(w.timing_totals.capture_ms,0);assert.equal(w.timing_totals.request_ms,20500);assert.equal(w.attempt_history.length,2);
}finally{Date.now=originalNow;delete globalThis.advanceUpload;delete globalThis.advanceRender}
console.log('Diagnostics: persistence, redaction, rotation, stage errors and separate upload/slicing/request timing passed');
