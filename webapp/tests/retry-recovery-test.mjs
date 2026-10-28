import assert from 'node:assert/strict';
import fs from 'node:fs';
const html=fs.readFileSync(new URL('../frontend/classroom.html',import.meta.url),'utf8');
const queueSource=html.slice(html.indexOf('  async function runWindowQueue('),html.indexOf('  function coverageSeconds('));
const queue=new Function(queueSource+';return runWindowQueue')();
const noWait={wait:async()=>{}};
let attempts=0;
const jobs=[{id:'done',status:'analyzed'},{id:'recover',status:'pending'},{id:'next',status:'pending'}];
const calls=[];
const result=await queue(jobs,async w=>{calls.push(w.id);if(w.id==='recover'&&attempts++<2)throw Object.assign(new Error('temporary outage'),{retryable:true})},new AbortController().signal,()=>{},noWait);
assert.deepEqual(calls,['recover','recover','recover','next']);assert.equal(result.completed,3);
assert.ok(jobs.every(w=>w.status==='analyzed'));assert.equal(jobs[1].auto_retry,undefined);
const blocked=[{id:'a',status:'pending'},{id:'b',status:'pending'}];let failures=0;
await queue(blocked,async()=>{failures++;throw Object.assign(new Error('still overloaded'),{retryable:true})},new AbortController().signal,()=>{},noWait);
assert.equal(failures,3);assert.equal(blocked[0].status,'failed');assert.equal(blocked[1].status,'pending');
const aborter=new AbortController(),cancelled=[{id:'a',status:'pending'},{id:'b',status:'pending'}];
await queue(cancelled,async()=>{throw Object.assign(new Error('network'),{retryable:true})},aborter.signal,()=>{},{wait:async()=>{aborter.abort();throw aborter.signal.reason}});
assert.deepEqual(cancelled.map(w=>w.status),['pending','pending']);
const permanent=[{id:'bad',status:'pending'},{id:'good',status:'pending'}];
await queue(permanent,async w=>{if(w.id==='bad')throw new Error('invalid media')},new AbortController().signal,()=>{},noWait);
assert.deepEqual(permanent.map(w=>w.status),['failed','analyzed']);
const auth=[{id:'a',status:'pending'},{id:'b',status:'pending'}];let authCalls=0;
await queue(auth,async()=>{authCalls++;throw Object.assign(new Error('credential expired'),{fatal:true})},new AbortController().signal,()=>{},noWait);
assert.equal(authCalls,1);assert.equal(auth[1].status,'pending');

// Exercise real source caching + screening handlers: 410 clears the source and the queue reuploads automatically.
const source=html.slice(html.indexOf('  let serverVideoSource=null;'),html.indexOf("  $('#cancelClip').onclick"));
const screen=html.slice(html.indexOf('  async function analyzeScreenWindow('),html.indexOf("  $('#analysisStrategy').onchange"));
let uploads=0,requests=0;const controls=new Map();
const $=key=>{if(!controls.has(key))controls.set(key,{files:[],value:'',textContent:''});return controls.get(key)};
$('#videoFile').files=[new Blob(['fixture'])];
const fakeFetch=async url=>{
 if(url.startsWith('/api/classroom/video-source?'))return Response.json({available_bytes:15*1024**3});
 if(url==='/api/classroom/video-source'){uploads++;return Response.json({source_id:'source-'+uploads,bytes:7})}
 requests++;if(requests===1)return Response.json({error:'video expired',retryable:false},{status:410});
 return Response.json({summary:'Recovered',windows:[],analysis:{timings:{},frame_count:1}});
};
const analyze=new Function('$','fetch','videoIdentity','timeLabel','window',source+screen+';return analyzeScreenWindow')($,fakeFetch,'video',String,{evaluationVideoFingerprint:async()=> 'a'.repeat(64)});
const screenJobs=[{id:'screen',status:'pending',video_identity:'video',start_seconds:0,end_seconds:120}];
await queue(screenJobs,w=>analyze(w,new AbortController().signal),new AbortController().signal,()=>{},noWait);
assert.equal(uploads,2);assert.equal(requests,2);assert.equal(screenJobs[0].status,'analyzed');
assert.equal(screenJobs[0].timing_totals.attempts,2,'Failed and successful attempts both stay in timing statistics');
console.log('Automatic recovery: network/model retries, 410 source reupload, continuation, pause during wait, persistent outage limit and credential stop passed');
