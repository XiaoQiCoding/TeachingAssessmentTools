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
