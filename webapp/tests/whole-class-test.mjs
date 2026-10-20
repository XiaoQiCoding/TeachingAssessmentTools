import assert from 'node:assert/strict';
import fs from 'node:fs';
import worker from '../dist/server/index.js';
const html=fs.readFileSync(new URL('../frontend/classroom.html',import.meta.url),'utf8');
const code=html.slice(html.indexOf('  function buildCoverageWindows('),html.indexOf('  function updateAutoProgress('));
const {buildCoverageWindows:build,buildFollowupWindows:follow,dimensionEvidence:dimensions,mergeCandidateEvidence:merge,runWindowQueue:queue,coverageSeconds:coverage}=new Function(code+';return {buildCoverageWindows,buildFollowupWindows,dimensionEvidence,mergeCandidateEvidence,runWindowQueue,coverageSeconds}')();
for(const duration of [1,12,55,60,61,115,1792]){
  const windows=build(duration,'video');
  assert.equal(windows[0].start_seconds,0);assert.equal(windows.at(-1).end_seconds,duration);
  assert.ok(windows.every(w=>w.end_seconds>w.start_seconds&&w.end_seconds-w.start_seconds<=60));
  for(let i=1;i<windows.length;i++)assert.ok(windows[i].start_seconds<=windows[i-1].end_seconds);
  windows.forEach(w=>w.status='analyzed');assert.equal(coverage(windows),duration);
  assert.equal(build(duration,'video',windows).length,windows.length,'Resume keeps completed windows');
  assert.ok(!build(duration,'new-video',windows).some(w=>w.status==='analyzed'),'Video identities isolate coverage');
}
assert.throws(()=>build(Infinity,'v'));assert.throws(()=>build(0,'v'));
const windows=build(130,'video'),calls=[];
await queue(windows,async w=>{calls.push(w.id);throw Object.assign(new Error('overload'),{retryable:true})},new AbortController().signal,()=>{});
assert.equal(calls.length,1,'Overload pauses instead of flooding all remaining windows');
assert.equal(windows[1].status,'pending');assert.equal(coverage(windows),0);
await queue(windows,async()=>{},new AbortController().signal,()=>{});assert.equal(coverage(windows),130);
const unknown={video_identity:'video',start_seconds:52,end_seconds:64,completion_quality:'unknown',task:'分类',limitations:'任务过程不完整'};
const extras=follow(130,'video',windows,[unknown]);assert.equal(extras.length,1);assert.ok(extras[0].start_seconds<55&&extras[0].end_seconds>60);
assert.equal(follow(130,'video',[...windows,...extras],[unknown]).length,0,'Do not repeat the same supplementary view');
assert.equal(follow(12,'video',build(12,'video'),[{...unknown,start_seconds:0,end_seconds:10}]).length,0);
assert.equal(follow(130,'video',windows,[{...unknown,video_identity:'different'}]).length,0);
assert.equal(dimensions([{phase:'tool_use',type:'operation',task:'分类',expected_response:'正确'}])[3].items.length,0,'Repeated operations are not transfer');
assert.equal(dimensions([{phase:'generalization',type:'generalization',changed_context:'更换材料'}])[3].items.length,1);
assert.ok(dimensions([]).every(d=>d.items.length===0),'No evidence is fabricated');
const old={...unknown,id:'old',type:'operation',student_id:'S1',phase:'tool_use',outcome:'neutral'};
const next={...old,id:'new',completion_quality:'achieved'};
assert.equal(merge([old],[next]).length,1,'Boundary overlaps must not duplicate the same evidence');
assert.equal(merge([old],[next])[0].completion_quality,'achieved');
assert.equal(merge([old],[next],['old'])[0].completion_quality,'unknown','Confirmed evidence cannot be overwritten automatically');
assert.equal(merge([old],[{...next,student_id:'S2'}]).length,2,'Different students remain separate');

// Execute the actual automatic entry point with no transcript capability at all.
const start=html.slice(html.indexOf('  async function startAssessment(){'),html.indexOf("  $('#startAssessment').onclick"));
const controls=new Map(),$=key=>{if(!controls.has(key))controls.set(key,{files:[],value:'',checked:true,classList:{add(){},remove(){},toggle(){}},appendChild(){}});return controls.get(key)};
$('#videoFile').files=[{}];$('#goals').value='分类';$('#video').duration=125;
const createEntry=new Function('$','document','fetch',code+`
  let autoBusy=false,autoAbort=null,clipBusy=false,transcriptBusy=false,locateBusy=false,taskGenerating=false,loadedPlanKey='',autoStage='',videoIdentity='video',selectedVideoDuration=0,selectedWindowId=null,reportData=null,recommendedWindows=[],candidates=[],events=[],analysisInfo={};
  const tasksReady=()=>true,readObservationTasks=()=>[{task:'分类'}],waitForVideoMetadata=async()=>{},showStep=()=>{},setAutoControls=()=>{},autoMessage=()=>{},renderWindows=()=>{},renderCandidates=()=>{},renderEvents=()=>{},updateAutoProgress=()=>{},saveDraft=()=>{},timeLabel=String;
  const analyzeClip=async()=>{const w=recommendedWindows.find(w=>w.id===selectedWindowId);w.status='analyzed';w.summary='学生进行分类';};
  ${start}
  return {run:startAssessment,state:()=>({recommendedWindows,analysisInfo,autoBusy})};
`);
const entry=createEntry($,{querySelectorAll:()=>[]},async()=>Response.json({ready:true}));
await entry.run();assert.equal(entry.state().recommendedWindows.length,3);assert.equal(entry.state().analysisInfo.workflow_version,'whole-class-v1');assert.equal(entry.state().autoBusy,false);
await entry.run();assert.equal(entry.state().recommendedWindows.length,3,'Resume must not duplicate coverage windows');
const blocked=createEntry($,{querySelectorAll:()=>[]},async()=>Response.json({ready:false,error:'模型过载529'},{status:503}));
await blocked.run();assert.equal(blocked.state().recommendedWindows.length,0,'Failed connection preflight must prevent clip preparation');assert.equal(blocked.state().autoBusy,false);

const original=globalThis.fetch;
try{
 globalThis.fetch=async()=>Response.json({error:{type:'overloaded_error'}},{status:529});
 const readiness=await worker.fetch(new Request('http://test/api/classroom/model-readiness',{method:'POST'}),{MINIMAX_API_KEY:'test'});
 assert.equal(readiness.status,503);assert.equal((await readiness.json()).error_code,'model_overloaded');
 const form=new FormData();form.append('mode','video');form.append('duration','12');form.append('video',new Blob(['fixture'],{type:'video/mp4'}),'test.mp4');
 const response=await worker.fetch(new Request('http://test/api/classroom/video-candidates',{method:'POST',body:form}),{MINIMAX_API_KEY:'test'});
 const error=await response.json();assert.equal(error.upstream_status,529);assert.equal(error.retryable,true);
 for(const status of [429,401]){
  globalThis.fetch=async()=>Response.json({error:{message:'test'}},{status});
  const result=await worker.fetch(new Request('http://test/api/classroom/model-readiness',{method:'POST'}),{MINIMAX_API_KEY:'test'});
  assert.equal(result.status,503);assert.equal((await result.json()).upstream_status,status);
 }
 globalThis.fetch=async()=>Response.json({choices:[{message:{content:'OK'}}]});
 const ready=await worker.fetch(new Request('http://test/api/classroom/model-readiness',{method:'POST'}),{MINIMAX_API_KEY:'test'});
 assert.equal((await ready.json()).ready,true);
 globalThis.fetch=async()=>Response.json({choices:[{message:{content:''}}]});
 const empty=await worker.fetch(new Request('http://test/api/classroom/model-readiness',{method:'POST'}),{MINIMAX_API_KEY:'test'});
 assert.equal((await empty.json()).ready,false,'HTTP success alone does not prove model readiness');
}finally{globalThis.fetch=original}
console.log('Whole-class coverage, speech-independent orchestration, resumability, targeted context checks and overload pause passed');
