import fs from 'node:fs';
import assert from 'node:assert/strict';
const template=fs.readFileSync(new URL('../backend/worker.template.js',import.meta.url),'utf8');
const call=new Function(template.slice(template.indexOf('function safeDiagnosticText('),template.indexOf('function bytesToBase64'))+';return callMiniMax')();
const original=globalThis.fetch;let calls=0,delays=[];
const options={direct:true,transientAttempts:3,wait:async ms=>delays.push(ms)};
try{
 globalThis.fetch=async(_url,{body})=>{calls++;assert.equal(JSON.parse(body).thinking.type,'disabled');return calls<3?Response.json({error:{type:'overloaded_error'}},{status:529}):Response.json({choices:[{message:{content:'{"windows":[]}'}}]})};
 assert.equal(await call({MINIMAX_API_KEY:'test'},[],0.1,4096,90000,options),'{"windows":[]}');assert.equal(calls,3);assert.deepEqual(delays,[2000,6000]);
 calls=0;delays=[];globalThis.fetch=async()=>{calls++;return Response.json({error:{type:'invalid_request'}},{status:400})};
 await assert.rejects(call({MINIMAX_API_KEY:'test'},[],0.1,4096,90000,options),e=>e.status===400&&!e.retryable);assert.equal(calls,1);assert.deepEqual(delays,[]);
 calls=0;delays=[];globalThis.fetch=async()=>{calls++;return calls===1?new Response('<html>busy</html>',{status:529,headers:{'retry-after':'9'}}):Response.json({choices:[{message:{content:'ok'}}]})};
 assert.equal(await call({MINIMAX_API_KEY:'test'},[],0.1,4096,90000,options),'ok');assert.deepEqual(delays,[9000]);
 calls=0;globalThis.fetch=async()=>{calls++;return Response.json({}, {status:529})};
 await assert.rejects(call({MINIMAX_API_KEY:'test'},[],0.1,4096,90000,options),e=>e.status===529&&e.retryable);assert.equal(calls,3);
 const region=template.slice(template.indexOf('function validateTranscript('),template.indexOf('async function locateTranscript('));
 const resolve=new Function(region+';return resolveTranscriptWindows')();
 const result=resolve('{"windows":[{"task_id":"T1","segment_ids":["S1",],"reason":"原文包含 ,] 不应改变",},]}',[{id:'S1',start_seconds:1,end_seconds:2,text:'拍手'}],[{id:'T1',task:'拍手'}],10);
 assert.equal(result.windows[0].reason,'原文包含 ,] 不应改变');
}finally{globalThis.fetch=original}
console.log('Transient HTTP retries back off, honor Retry-After, preserve nonretryable failures and safely repair trailing commas');
