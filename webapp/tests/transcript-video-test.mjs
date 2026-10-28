import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import ffmpeg from 'ffmpeg-static';
import worker from '../dist/server/index.js';
import {createTranscriptionService,normalizeASR} from '../backend/transcription-service.mjs';

const source=await fs.readFile(new URL('../backend/worker.template.js',import.meta.url),'utf8');
const region=source.slice(source.indexOf('function validateTranscript('),source.indexOf('async function locateTranscript('));
const {validate,resolve}=new Function(region+';return {validate:validateTranscript,resolve:resolveTranscriptWindows}')();
const rows=[{id:'S1',start_seconds:10,end_seconds:15,text:'请分类'},{id:'S2',start_seconds:18,end_seconds:22,text:'再试一次'}];
const tasks=[{id:'T1',task:'按颜色分类'}];
const locatorHtml=await fs.readFile(new URL('../frontend/classroom.html',import.meta.url),'utf8');
const locateSource=locatorHtml.slice(locatorHtml.indexOf('async function locateFromTranscript(){'),locatorHtml.indexOf('async function pollTranscript('));
function locatorHarness(fetcher,timeout=95000){
  const controls=new Map(),$=id=>{if(!controls.has(id))controls.set(id,{checked:true,disabled:false,textContent:'',classList:{add(){},remove(){}}});return controls.get(id)};
  const api=new Function('$','fetch',`
    let videoIdentity='test',transcriptState={video_identity:'test',duration:100,segments:[{id:'S1',start_seconds:1,end_seconds:2,text:'拍手'}]},locateBusy=false,locateAbort=null,transcriptBusy=false,recommendedWindows=[];
    const tasksReady=()=>true,readObservationTasks=()=>[{task:'拍手'}],renderWindows=()=>{},saveDraft=()=>{};
    const locateBatches=async(duration,segments,observation_tasks,signal)=>{const response=await fetch('/api/classroom/locate-transcript',{signal:AbortSignal.any([signal,AbortSignal.timeout(${timeout})])});return response.json()};
    ${locateSource.replace('AbortSignal.timeout(95000)',`AbortSignal.timeout(${timeout})`)}
    return {run:locateFromTranscript,cancel:()=>locateAbort.abort(),busy:()=>locateBusy};
  `)($,fetcher);
  return {...api,$};
}
const pending=(_url,{signal})=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
const cancelled=locatorHarness(pending),cancelRun=cancelled.run();
assert.equal(cancelled.busy(),true);assert.equal(cancelled.$('#analyzeClip').disabled,true);
cancelled.cancel();await assert.rejects(cancelRun,/已取消定位/);
assert.equal(cancelled.busy(),false);assert.equal(cancelled.$('#analyzeClip').disabled,false);assert.equal(cancelled.$('#applyTranscriptEdits').disabled,false);
const timed=locatorHarness(pending,10),keepTimer=setTimeout(()=>{},200);
await assert.rejects(timed.run(),/定位等待超时/);clearTimeout(keepTimer);
assert.equal(timed.$('#analyzeVideo').disabled,false);
const success=locatorHarness(async()=>new Response(JSON.stringify({windows:[]})));
await success.run();assert.equal(success.$('#locateTranscript').disabled,false);assert.ok(success.$('#transcriptStatus').textContent.includes('AI 推荐'));
assert.throws(()=>validate([{...rows[0],end_seconds:300}],100));
assert.throws(()=>validate([rows[0],rows[0]],100));
const windows=resolve(JSON.stringify({windows:[{task_id:'T1',segment_ids:['S1','S2'],reason:'检查指令后学生尝试及再次提示'}]}),rows,tasks,100);
assert.equal(windows.windows[0].start_seconds,5);assert.equal(windows.windows[0].end_seconds,37);assert.equal(windows.windows[0].transcript[0].text,'请分类');
assert.throws(()=>resolve(JSON.stringify({windows:[{task_id:'T1',segment_ids:['invented']}]}),rows,tasks,100));
assert.equal(resolve('{"windows":[]}',rows,tasks,100).unlocated_tasks.length,1);
assert.deepEqual(normalizeASR({segments:[{start:1,end:2,text:'再试一次'}]},420,5).map(s=>s.start_seconds),[421]);
assert.throws(()=>normalizeASR({text:'无时间'},0,10));
assert.throws(()=>normalizeASR({segments:[{start:1,end:20,text:'超出'}]},0,10));
const html=await fs.readFile(new URL('../frontend/classroom.html',import.meta.url),'utf8');
const parseText=html.slice(html.indexOf('  function parseTimedTranscript('),html.indexOf('  function renderTranscript('));
const parse=new Function(parseText+';return parseTimedTranscript')();
assert.equal(parse('1\n00:00:10,000 --> 00:00:15,000\n请分类\n\n2\n00:00:18,000 --> 00:00:22,000\n再试一次\n',100).length,2);
assert.equal(parse('WEBVTT\n\n00:10.000 --> 00:15.000\n请分类\n',100)[0].start_seconds,10);
assert.throws(()=>parse('普通文字无时间',100));

// Exercise the same automatic transcription helper used before screening.
const automaticTranscriptSource=html.slice(html.indexOf('  function transcriptForRange('),html.indexOf("  $('#cancelTranscript').onclick"));
function automaticTranscriptHarness({state=null,hasAudio=true,pollError=null}={}){
  let posts=0,polls=0,sources=0;
  const api=new Function('fetch','getSource','pollTranscript','initial',`
    let videoIdentity='v',selectedVideoDuration=245,serverVideoSource=null,transcriptState=initial;
    const $=()=>({}),renderTranscript=()=>{},saveDraft=()=>{},ensureServerVideoSource=getSource;
    ${automaticTranscriptSource}
    return {ensure:ensureAnalysisTranscript,range:transcriptForRange,state:()=>transcriptState};
  `)(async(_url,options)=>{posts++;assert.deepEqual(JSON.parse(options.body),{video_source_id:'source'});return Response.json({job_id:'job'})},async()=>{sources++;return {source_id:'source',has_audio:hasAudio}},async()=>{polls++;if(pollError)throw pollError;return {duration_seconds:245,source:'minimax_asr',segments:[{start_seconds:119,end_seconds:122,text:'边界句'},{start_seconds:130,end_seconds:135,text:'本段句'},{start_seconds:240,end_seconds:242,text:'下一段'}]}},state);
  return {...api,counts:()=>({posts,polls,sources})};
}
const autoTranscript=automaticTranscriptHarness(),transcriptSignal=new AbortController().signal;
await autoTranscript.ensure(transcriptSignal);assert.equal(autoTranscript.state().complete,true);
assert.deepEqual(autoTranscript.range(120,240).map(s=>s.text),['边界句','本段句']);
await autoTranscript.ensure(transcriptSignal);assert.deepEqual(autoTranscript.counts(),{posts:1,polls:1,sources:1},'Resume reuses the transcript without new ASR charges');
const imported=automaticTranscriptHarness({state:{video_identity:'v',source:'import',segments:[{start_seconds:1,end_seconds:2,text:'字幕'}]}});await imported.ensure(transcriptSignal);assert.equal(imported.counts().posts,0);
const noAudio=automaticTranscriptHarness({hasAudio:false});await noAudio.ensure(transcriptSignal);assert.equal(noAudio.state().source,'no_audio');assert.equal(noAudio.counts().posts,0);
const resumed=automaticTranscriptHarness({state:{video_identity:'v',job_id:'existing',segments:[]}});await resumed.ensure(transcriptSignal);assert.equal(resumed.counts().posts,0);assert.equal(resumed.counts().polls,1);
const failedTranscript=automaticTranscriptHarness({pollError:new Error('ASR failed')});await assert.rejects(failedTranscript.ensure(transcriptSignal),/ASR failed/);assert.equal(failedTranscript.state().job_id,undefined,'Failed jobs must not prevent retries');
const staleTranscript=automaticTranscriptHarness({state:{video_identity:'other',segments:[{start_seconds:1,end_seconds:2,text:'旧视频'}]}});assert.deepEqual(staleTranscript.range(0,10),[]);await staleTranscript.ensure(transcriptSignal);assert.equal(staleTranscript.counts().posts,1);

const originalFetch=globalThis.fetch;
globalThis.fetch=async()=>new Response(JSON.stringify({choices:[{message:{content:'{"windows":[{"task_id":"T1","segment_ids":["S1"],"reason":"核对学生反应"}]}'}}]}),{headers:{'content-type':'application/json'}});
const located=await worker.fetch(new Request('http://test/api/classroom/locate-transcript',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({segments:rows,duration:100,observation_tasks:tasks})}),{MINIMAX_API_KEY:'test'});
assert.equal(located.status,200);assert.equal((await located.json()).windows[0].end_seconds,30);
globalThis.fetch=originalFetch;

// Exercise real FFmpeg extraction and asynchronous HTTP jobs with a mocked ASR service.
const testDir=await fs.mkdtemp(path.join(os.tmpdir(),'teaching-transcript-test-'));
let server;
try{
  const file=path.join(testDir,'sample.mp4');
  await promisify(execFile)(ffmpeg,['-hide_banner','-loglevel','error','-f','lavfi','-i','color=size=16x16:rate=1','-f','lavfi','-i','sine=frequency=300:sample_rate=16000','-t','425','-c:v','libx264','-preset','ultrafast','-c:a','aac',file],{windowsHide:true});
  let asrCalls=0;
  const handler=createTranscriptionService({MINIMAX_API_KEY:'test'}, {fetcher:async(url,options)=>{
    assert.ok(url.endsWith('/speech_to_text'));assert.equal(options.body.get('response_format'),'verbose_json');assert.equal(options.body.get('timestamp_level'),'sentence');
    const audio=new Uint8Array(await options.body.get('file').arrayBuffer());assert.equal(new TextDecoder().decode(audio.slice(0,4)),'RIFF');asrCalls++;
    return new Response(JSON.stringify({segments:[{start:1,end:2,text:'测试语句'}]}),{headers:{'content-type':'application/json'}});
  }});
  server=http.createServer(async(req,res)=>{try{if(!await handler(req,res,new URL(req.url,'http://test')))res.end()}catch(error){res.writeHead(500);res.end(error.message)}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${server.address().port}`;
  const uploaded=await fetch(base+'/api/classroom/transcription',{method:'POST',headers:{'content-type':'application/octet-stream','x-video-duration':'425'},body:await fs.readFile(file)});
  assert.equal(uploaded.status,202);const {job_id}=await uploaded.json();let result;
  for(let i=0;i<100;i++){result=await (await fetch(base+'/api/classroom/transcription/'+job_id)).json();if(['complete','failed'].includes(result.status))break;await new Promise(resolve=>setTimeout(resolve,100));}
  assert.equal(result.status,'complete',result.message);assert.equal(asrCalls,2);assert.equal(result.segments[1].start_seconds,421);assert.equal(result.segments[0].id,'S1');
  assert.equal((await fetch(base+'/api/classroom/transcription/no-such-job')).status,404);
}finally{
  if(server)await new Promise(resolve=>server.close(resolve));
  const resolved=path.resolve(testDir);assert.equal(path.dirname(resolved),path.resolve(os.tmpdir()));assert.ok(path.basename(resolved).startsWith('teaching-transcript-test-'));await fs.rm(resolved,{recursive:true,force:true});
}
console.log('Transcript parsing, grounded AI windows, FFmpeg extraction and ASR chunk offsets passed');
