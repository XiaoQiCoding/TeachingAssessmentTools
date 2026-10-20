import assert from 'node:assert/strict';
import worker from '../dist/server/index.js';
const body={duration:60,segments:[{id:'S1',start_seconds:1,end_seconds:5,text:'请拍手'}],observation_tasks:[{task:'拍手'}]};
async function locate(){return worker.fetch(new Request('http://test/api/classroom/locate-transcript',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}),{MINIMAX_API_KEY:'test'})}
let calls=0;const original=globalThis.fetch;
try{
 globalThis.fetch=async()=>{calls++;return Response.json({choices:[{message:{content:''}}]})};
 assert.equal((await (await locate()).json()).error_code,'empty_model_output');assert.equal(calls,2);
 globalThis.fetch=async()=>{calls++;return Response.json({choices:[{message:{content:'{"windows":[{"task_id":"T1","segment_ids":["wrong"]}]}'}}]})};
 assert.equal((await (await locate()).json()).error_code,'invalid_references_or_format');
 calls=0;globalThis.fetch=async()=>{calls++;return Response.json({error:'unavailable'},{status:503})};
 const failed=await (await locate()).json();assert.equal(failed.error_code,'model_request_failed');assert.match(failed.error,/503/);assert.equal(calls,3);
 globalThis.fetch=async()=>Response.json({choices:[{finish_reason:'length',message:{content:'<think>incomplete'}}]});
 assert.equal((await (await locate()).json()).error_code,'model_output_truncated');
 globalThis.fetch=async()=>{throw Object.assign(new Error('timeout'),{name:'TimeoutError'})};
 assert.equal((await (await locate()).json()).error_code,'model_timeout');
}finally{globalThis.fetch=original}
console.log('Locator diagnostics distinguish timeout, request failure, empty output and invalid references');
