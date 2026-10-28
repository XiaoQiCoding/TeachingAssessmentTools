import assert from 'node:assert/strict';
import fs from 'node:fs';
import worker from '../dist/server/index.js';
const html=fs.readFileSync(new URL('../frontend/classroom.html',import.meta.url),'utf8');
const helpers=html.slice(html.indexOf('  function buildScreeningWindows('),html.indexOf('  async function analyzeScreenWindow('));
const coverage=html.slice(html.indexOf('  function buildCoverageWindows('),html.indexOf('  function updateAutoProgress('));
const {screen,focus,queue}=new Function(helpers+coverage+';return {screen:buildScreeningWindows,focus:buildFocusedWindows,queue:runWindowQueue}')();
for(const duration of [1,12,120,121,1792.89]){
 const windows=screen(duration,'v');assert.equal(windows[0].start_seconds,0);assert.equal(windows.at(-1).end_seconds,duration);
 assert.ok(windows.every(w=>w.end_seconds-w.start_seconds<=120));
 assert.equal(screen(duration,'v',windows).length,windows.length);
 assert.equal(screen(duration,'other',windows).length,windows.length);
 const focused=focus(duration,'v',[]);assert.ok(focused.every(w=>w.start_seconds>=0&&w.end_seconds<=duration&&w.end_seconds>w.start_seconds&&w.end_seconds-w.start_seconds<=60));
 assert.equal(focus(duration,'v',[],focused).length,focused.length);
}
const screens=screen(240,'v');screens[0].status='analyzed';screens[0].windows=[{start_seconds:10,end_seconds:40,reason:'辅助',priority:'concern'}];screens[1].windows=[{start_seconds:130,end_seconds:160,reason:'未完成初筛，不可采用'}];
const focused=focus(240,'v',screens);assert.ok(focused.some(w=>w.reason==='辅助'));assert.ok(!focused.some(w=>w.reason==='未完成初筛，不可采用'));assert.ok(!focused.some(w=>w.id.startsWith('SAMPLE-')),'No mandatory sampling without a scoring question');
const calls=[];await queue(screens,async w=>{calls.push(w.id);throw Object.assign(new Error('overload'),{retryable:true})},new AbortController().signal,()=>{},{wait:async()=>{}});assert.deepEqual(calls,['SCREEN-120','SCREEN-120','SCREEN-120']);

const original=globalThis.fetch;let modelCalls=0,body,answer={summary:'学生操作，身份不清，需连续检查',windows:[{start_seconds:5,end_seconds:35,reason:'教师辅助学生操作',priority:'concern'}]};
const env={QWEN_API_KEY:'fixture',PREPARE_VIDEO_SCREEN:async()=>[{time_seconds:0,blob:new Blob(['jpeg'],{type:'image/jpeg'})}]};
function request(extra={}){const f=new FormData();for(const [key,value]of Object.entries({analysis_stage:'screening',video_source_id:'fixture',clip_offset:120,duration:120,...extra}))f.set(key,String(value));return new Request('http://test/api/classroom/video-candidates',{method:'POST',headers:{'x-evaluation-model':'qwen3.8-flash'},body:f})}
try{
 globalThis.fetch=async(_url,options)=>{modelCalls++;body=JSON.parse(options.body);return Response.json({choices:[{message:{content:JSON.stringify(answer)}}],usage:{prompt_tokens:123,completion_tokens:45}})};
 let res=await worker.fetch(request(),env),data=await res.json();assert.equal(res.status,200);assert.equal(data.windows[0].start_seconds,125);assert.equal(data.windows[0].end_seconds,155);assert.deepEqual(data.candidates,[],'Screening must never create scoring candidates');assert.equal(data.analysis.usage.input_tokens,123);assert.equal(data.analysis.usage.output_tokens,45);assert.ok(body.messages[0].content.some(c=>c.type==='image_url'));
 const timedRows=[{start_seconds:119,end_seconds:122,text:'跨边界语句'},{start_seconds:130,end_seconds:135,text:'请说说小熊为什么摔倒'},{start_seconds:240,end_seconds:245,text:'下一段语句'}];
 res=await worker.fetch(request({transcript_segments:JSON.stringify(timedRows),transcript_status:'complete'}),env);data=await res.json();assert.equal(res.status,200);assert.equal(data.analysis.transcript_segments,2);assert.deepEqual(data.candidates,[]);
 const prompt=body.messages[0].content.find(c=>c.type==='text').text;assert.ok(prompt.includes('请说说小熊为什么摔倒'));assert.ok(!prompt.includes('下一段语句'));assert.ok(prompt.includes('"relative_start_seconds":10'));assert.ok(prompt.includes('120—240秒'));assert.ok(prompt.includes('不能笼统声称本段缺乏声音信息'));
 answer={summary:'只核查可解决的评分疑点',windows:[{start_seconds:5,end_seconds:35,reason:'核查口头指令但声音不可用',dimensions:['B2'],score_question:'口头指令是否听懂',observable_fact:'学生坐姿观看',question_state:'not_observable',verification_method:'audio',needs_detail:false}]};
 res=await worker.fetch(request(),env);data=await res.json();assert.equal(data.windows[0].needs_detail,false);assert.equal(data.windows[0].verification_method,'audio');assert.deepEqual(data.windows[0].dimensions,['B2']);assert.deepEqual(data.candidates,[]);
 for(const bad of [{transcript_segments:'bad'},{transcript_segments:JSON.stringify([{start_seconds:120,end_seconds:119,text:'bad'}])},{duration:121},{clip_offset:-1},{duration:'NaN'}]){res=await worker.fetch(request(bad),env);assert.equal(res.status,400)}assert.equal(modelCalls,3,'Invalid ranges never reach the model');
 for(const windows of [[{start_seconds:130,end_seconds:140,reason:'outside'}],[{start_seconds:10,end_seconds:5,reason:'reversed'}],null]){answer={summary:'invalid',windows};res=await worker.fetch(request(),env);assert.equal(res.status,502)}
 for(const windows of [[{start_seconds:100,end_seconds:140,reason:'clip boundary'}],[{start_seconds:0,end_seconds:10,reason:'short clue'}],[{start_seconds:0,end_seconds:120,reason:'long activity'}],[{start_seconds:130,end_seconds:140,reason:'bad'},{start_seconds:20,end_seconds:50,reason:'valid'}]]){
   answer={summary:'Keep summary and normalize location hints only',windows};res=await worker.fetch(request(),env);data=await res.json();assert.equal(res.status,200);assert.ok(data.warnings.length);assert.deepEqual(data.candidates,[]);assert.ok(data.windows.every(w=>w.start_seconds>=120&&w.end_seconds<=240&&w.end_seconds-w.start_seconds>=20&&w.end_seconds-w.start_seconds<=60));
 }
 res=await worker.fetch(request(),{...env,PREPARE_VIDEO_SCREEN:async()=>{throw Object.assign(new Error('expired'),{local_status:410})}});data=await res.json();assert.equal(res.status,410);assert.equal(data.retryable,true);
 globalThis.fetch=async()=>Response.json({error:{message:'rate limited'}},{status:429});res=await worker.fetch(request(),env);data=await res.json();assert.equal(data.retryable,true);
 // Dense analysis supports explicit fps; a malicious value is rejected before media processing.
 const form=new FormData();form.set('video_fps','10');res=await worker.fetch(new Request('http://test/api/classroom/video-candidates',{method:'POST',headers:{'x-evaluation-model':'qwen3.8-flash'},body:form}),env);assert.equal(res.status,400);
 globalThis.fetch=async(_url,options)=>{body=JSON.parse(options.body);return Response.json({choices:[{message:{content:JSON.stringify({summary:'fine',candidates:[]})}}],usage:{prompt_tokens:300,completion_tokens:20}})};
 const detail=new FormData();detail.set('video_fps','1');detail.set('duration','30');detail.set('clip_offset','0');detail.set('video_source_id','fixture');
 res=await worker.fetch(new Request('http://test/api/classroom/video-candidates',{method:'POST',headers:{'x-evaluation-model':'qwen3.8-flash'},body:detail}),{...env,PREPARE_VIDEO_CLIP:async()=>new Blob(['fixture'],{type:'video/mp4'})});
 data=await res.json();assert.equal(res.status,200);assert.equal(body.messages[0].content.find(c=>c.type==='video_url').fps,1);assert.equal(data.analysis.usage.input_tokens,300);
}finally{globalThis.fetch=original}

// Exercise the real automatic entry point in quick mode, including pause/resume and mode switching.
const start=html.slice(html.indexOf('  async function startAssessment(options={}){'),html.indexOf("  $('#startAssessment').onclick"));
const controls=new Map(),$=key=>{if(!controls.has(key))controls.set(key,{files:[],value:'',checked:true,classList:{add(){},remove(){},toggle(){}},appendChild(){}});return controls.get(key)};
$('#videoFile').files=[{}];$('#goals').value='分类';$('#video').duration=245;$('#analysisStrategy').value='quick';$('#detailFps').value='2';
const factory=new Function('$','document','fetch',helpers+coverage.replace('options={})','options={wait:async()=>{}})')+`
 let serverVideoSource=null;const checkVideoUploadCapacity=async()=>{};
 let autoBusy=false,autoAbort=null,clipBusy=false,transcriptBusy=false,locateBusy=false,taskGenerating=false,loadedPlanKey='',autoStage='',videoIdentity='video',selectedVideoDuration=0,selectedWindowId=null,reportData=null,recommendedWindows=[],candidates=[],events=[],analysisInfo={},screenCalls=0,clipCalls=0,screenFailures=0;
 const tasksReady=()=>true,readObservationTasks=()=>[{task:'分类'}],waitForVideoMetadata=async()=>{},showStep=()=>{},setAutoControls=()=>{},autoMessage=()=>{},renderWindows=()=>{},renderCandidates=()=>{},renderEvents=()=>{},updateAutoProgress=()=>{},saveDraft=()=>{},timeLabel=String;
 const ensureAnalysisTranscript=async()=>{};
 const analyzeScreenWindow=async w=>{screenCalls++;if(w.start_seconds===120&&screenFailures++<3){throw Object.assign(new Error('overload'),{retryable:true})}w.windows=[{start_seconds:w.start_seconds,end_seconds:Math.min(w.end_seconds,w.start_seconds+30),reason:'操作'}]};
 const analyzeClip=async()=>{clipCalls++;recommendedWindows.find(w=>w.id===selectedWindowId).status='analyzed';candidates.push({id:'FACT-'+clipCalls,video_identity:'video',analysis_source:'continuous_clip',type:'operation',task:'分类',expected_response:'正确分类',actual_response:'学生完成分类',completion_quality:'achieved'})};
 ${start}
 return {run:startAssessment,state:()=>({analysisInfo,recommendedWindows,screenCalls,clipCalls})};
`);
const entry=factory($,{querySelectorAll:()=>[]},async()=>Response.json({ready:true}));
await entry.run();assert.equal(entry.state().clipCalls,0,'Incomplete initial screening must pause before focus analysis');
await entry.run({useCompletedScreening:true});assert.equal(entry.state().screenCalls,4,'Explicit partial continuation never retries failed screening');assert.ok(entry.state().clipCalls>0);assert.equal(entry.state().analysisInfo.screening_incomplete,true);assert.ok(entry.state().analysisInfo.screening_windows.some(w=>w.status!=='analyzed'),'Missing screening is preserved, never marked complete');
await entry.run();const state=entry.state();assert.equal(state.screenCalls,6,'Completed screening windows are reused');assert.equal(state.analysisInfo.workflow_version,'score-questions-v3');assert.ok(state.clipCalls>0);
assert.equal(state.analysisInfo.screening_incomplete,false);
await entry.run();assert.equal(entry.state().screenCalls,6);assert.equal(entry.state().clipCalls,state.clipCalls,'Resume must not rerun completed focus windows');
$('#analysisStrategy').value='full';await entry.run();assert.equal(entry.state().analysisInfo.workflow_version,'whole-class-v1');assert.ok(entry.state().recommendedWindows.some(w=>w.source==='whole_class'));
console.log('Fast analysis: range validation, low-cost screening, no scoring candidates, usage, overload/expiry, resume and full-mode compatibility passed');
