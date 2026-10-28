import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import worker from '../dist/server/index.js';
const credentials={QWEN_API_KEY:'qwen-test-secret',QWEN_API_BASE:'https://qwen.example/compatible-mode/v1',MINIMAX_API_KEY:'minimax-test-secret',MINIMAX_API_BASE:'https://minimax.example/v1'};
const original=globalThis.fetch,calls=[];
const request=(url,model,body)=>new Request('http://local'+url,{method:'POST',headers:model?{'x-evaluation-model':model}:{},body});
try{
 globalThis.fetch=async(url,options)=>{calls.push({url,headers:options.headers,body:JSON.parse(options.body)});return Response.json({choices:[{message:{content:'OK'},finish_reason:'stop'}]})};
 let response=await worker.fetch(request('/api/classroom/model-readiness'),credentials),data=await response.json();
 assert.equal(data.model,'qwen3.8-max');assert.equal(data.ready,true);assert.equal(calls[0].headers.Authorization,'Bearer qwen-test-secret');assert.equal(calls[0].body.enable_thinking,false);assert.equal(calls[0].body.max_tokens,128);assert.equal(calls[0].body.max_completion_tokens,undefined);
 assert.equal(calls[0].url,'https://qwen.example/compatible-mode/v1/chat/completions');
 response=await worker.fetch(request('/api/classroom/model-readiness','MiniMax-M3'),credentials);assert.equal((await response.json()).ready,true);
 assert.equal(calls.at(-1).headers.Authorization,'Bearer minimax-test-secret');assert.equal(calls.at(-1).body.model,'MiniMax-M3');
 const before=calls.length;
 response=await worker.fetch(request('/api/classroom/model-readiness','qwen3.8-max'),{MINIMAX_API_KEY:'minimax-test-secret'});assert.equal(response.status,503);assert.ok((await response.json()).error.includes('千问'));assert.equal(calls.length,before,'Never send a MiniMax credential to Qwen or silently fall back');
 response=await worker.fetch(request('/api/classroom/model-readiness','https://untrusted.example'),credentials);assert.equal(response.status,400);assert.equal(calls.length,before);
 const models=await worker.fetch(new Request('http://local/api/models'),credentials);const options=await models.json();assert.equal(options.default_model,'qwen3.8-max');assert.ok(options.models.every(m=>m.configured));assert.ok(!JSON.stringify(options).includes('secret'));

 const fact={start_seconds:1,end_seconds:4,phase:'tool_use',type:'operation',student_id:'S01',outcome:'positive',note:'学生将物品放入容器',task:'分类',expected_response:'放入对应容器',actual_response:'学生放入容器',completion_quality:'achieved'};
 globalThis.fetch=async(url,options)=>{calls.push({url,headers:options.headers,body:JSON.parse(options.body)});return Response.json({choices:[{message:{content:JSON.stringify({summary:'观察到学生操作',candidates:[fact]})},finish_reason:'stop'}]})};
 const form=new FormData();form.set('mode','video');form.set('video',new Blob(['fixture'],{type:'video/mp4'}),'clip.mp4');form.set('duration','10');form.set('clip_offset','20');form.set('audio_present','true');
 response=await worker.fetch(request('/api/classroom/video-candidates','qwen3.8-max',form),credentials);data=await response.json();
 assert.equal(response.status,200);assert.equal(data.analysis.model,'qwen3.8-max');assert.equal(data.analysis.provider,'qwen');assert.equal(data.analysis.audio_available,false);
 assert.equal(data.candidates[0].start_seconds,21);assert.equal(data.candidates[0].analysis_model,'qwen3.8-max');assert.ok(data.candidates[0].limitations.includes('声音'));
 const media=calls.at(-1).body.messages[0].content;assert.ok(media.some(c=>c.type==='video_url'&&c.video_url.url.startsWith('data:video/mp4;base64,')&&c.fps===1));assert.ok(media.find(c=>c.type==='text').text.includes('禁止推断口头指令'));
 const frames=new FormData();frames.set('mode','frames');frames.set('duration','10');frames.set('frames',new Blob(['fixture'],{type:'image/jpeg'}),'frame.jpg');frames.set('frame_times','[1]');
 response=await worker.fetch(request('/api/classroom/video-candidates','qwen3.7-plus',frames),credentials);data=await response.json();assert.equal(data.candidates[0].completion_quality,'unknown');assert.equal(data.candidates[0].outcome,'neutral');assert.ok(calls.at(-1).body.messages[0].content.some(c=>c.type==='image_url'));
 const asset=await worker.fetch(new Request('http://local/evaluation-model.js'),{});assert.equal(asset.status,200);assert.ok((await asset.text()).includes('x-evaluation-model'));
}finally{globalThis.fetch=original}

const script=fs.readFileSync(new URL('../frontend/evaluation-model.js',import.meta.url),'utf8');
function browserHarness(store=new Map()){
 const listeners={},events={},sent=[],select={value:'qwen3.8-max',disabled:false,addEventListener:(name,fn)=>events[name]=fn},hint={};
 const window={addEventListener:(name,fn)=>listeners[name]=fn,fetch:async(input,options)=>{sent.push({input,options});return Response.json({ok:true})}};
 const context={window,document:{querySelector:s=>s==='#evaluationModel'?select:hint},localStorage:{getItem:k=>store.get(k),setItem:(k,v)=>store.set(k,v)},crypto:globalThis.crypto,location:{href:'http://local/classroom',origin:'http://local'},URL,Headers};
 vm.runInNewContext(script,context);return {window,select,hint,events,sent,store};
}
const first=browserHarness();assert.equal(first.window.evaluationModelId(),'qwen3.8-max');
assert.equal(browserHarness(new Map([['teaching-evaluation-model-v1','obsolete-model']])).window.evaluationModelId(),'qwen3.8-max','Invalid saved models use Max');
assert.equal(browserHarness(new Map([['teaching-evaluation-model-v1','qwen3.8-flash']])).window.evaluationModelId(),'qwen3.8-flash','Keep an explicit saved model choice');
await first.window.evaluationFetch('/api/classroom/plan',{method:'POST'});assert.equal(first.sent[0].options.headers.get('x-evaluation-model'),'qwen3.8-max');
first.select.value='MiniMax-M3';first.events.change();assert.equal(browserHarness(first.store).window.evaluationModelId(),'MiniMax-M3','Choice persists across both module pages');
first.window.evaluationModelLocked=()=>true;first.select.value='qwen3.8-max';first.events.change();assert.equal(first.select.value,'MiniMax-M3','Do not switch providers mid-analysis');
for(const page of ['index.html','classroom.html']){const html=fs.readFileSync(new URL('../frontend/'+page,import.meta.url),'utf8');assert.ok(html.includes('id="evaluationModel"'));assert.ok(html.includes('src="/evaluation-model.js"'));assert.ok(html.includes('<option value="qwen3.8-max" selected>千问 Max（默认）</option>'))}
console.log('Model selection: Qwen default, credential isolation, both media adapters, source metadata, persistence and busy guards passed');
