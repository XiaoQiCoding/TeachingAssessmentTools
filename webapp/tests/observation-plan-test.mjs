import assert from 'node:assert/strict';
import fs from 'node:fs';
import worker from '../dist/server/index.js';
const tasks=[{task:'歌曲演唱',success_criteria:'学生独立演唱，教师带唱单独记录',allowed_assistance:'目标要求独立，提示后完成单独记录',basis:'教学目标明确独立演唱'}];
let replies=[],calls=[];
globalThis.fetch=async(_url,options)=>{calls.push(JSON.parse(options.body));return new Response(JSON.stringify({choices:[{message:{content:replies.shift()}}]}),{headers:{'content-type':'application/json'}})};
async function generate(sequence,goals='独立演唱歌曲'){
  replies=[...sequence];calls=[];
  const response=await worker.fetch(new Request('http://test/api/classroom/observation-plan',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({lesson:'音乐课',goals,instructions:'教师引导演唱'})}),{MINIMAX_API_KEY:'test'});
  return {response,data:await response.json()};
}
const valid=JSON.stringify({observation_tasks:tasks});
const result=await generate([valid]);
assert.equal(result.response.status,200);assert.equal(result.data.observation_tasks[0].success_criteria,tasks[0].success_criteria);assert.equal(result.data.observation_tasks[0].source,'ai_reference');
assert.ok(calls[0].messages[0].content.includes('不凭空编造次数'));
assert.equal((await generate(['invalid',valid])).response.status,200);assert.equal(calls.length,2);
assert.equal((await generate([JSON.stringify({observation_tasks:[{task:'演唱',success_criteria:'',allowed_assistance:'提示'}]}),'invalid'])).response.status,502);
assert.equal((await generate([], '')).response.status,400);assert.equal(calls.length,0);
async function extract(sequence){
  replies=[...sequence];calls=[];
  const form=new FormData();form.set('lesson_plan',new File(['独立演唱歌曲，教师可先示范。'],'lesson.txt'));
  const response=await worker.fetch(new Request('http://test/api/classroom/plan',{method:'POST',body:form}),{MINIMAX_API_KEY:'test'});
  return {response,data:await response.json()};
}
const completePlan={lesson:'音乐课',goals:['独立演唱歌曲'],steps:['演唱'],observation_tasks:tasks};
const extracted=await extract([JSON.stringify(completePlan)]);
assert.equal(extracted.response.status,200);assert.equal(calls.length,1,'Plan and criteria should use one model call');
assert.equal(extracted.data.observation_tasks[0].success_criteria,tasks[0].success_criteria);
const incomplete=await extract([JSON.stringify({...completePlan,observation_tasks:[]})]);
assert.equal(calls.length,1,'Missing criteria must not delay the plan with another serial call');
assert.equal(incomplete.data.goals[0],'独立演唱歌曲');assert.ok(incomplete.data.observation_warning);
assert.equal((await extract(['invalid',JSON.stringify(completePlan)])).response.status,200);assert.equal(calls.length,2);
const html=fs.readFileSync(new URL('../frontend/classroom.html',import.meta.url),'utf8');
assert.ok(html.includes('data-task-field="success_criteria"'));assert.ok(html.includes('data-task-field="allowed_assistance"'));
assert.ok(!html.includes('<textarea class="control" id="observationPlan"'));
assert.ok(html.includes('taskRevision!==revision'),'Late AI responses must not overwrite user edits');
assert.ok(html.includes('observation_tasks:readObservationTasks()'),'Structured edits must persist');
assert.ok(html.includes('if(!tasksReady())await fillObservationTasks(false)'),'Missing criteria should be filled automatically after extraction');
assert.ok(html.includes('AbortSignal.timeout(95000)'),'UI requests must stop waiting after a bounded period');
assert.ok(!html.includes("basis:'旧记录需要生成参考条件'"),'A failed new extraction must not be labelled as an old record');
const template=fs.readFileSync(new URL('../backend/worker.template.js',import.meta.url),'utf8');
const boundedCall=new Function(template.slice(template.indexOf('async function callMiniMax('),template.indexOf('function bytesToBase64'))+';return callMiniMax;')();
globalThis.fetch=async(_url,{signal})=>new Response(new ReadableStream({start(controller){signal.addEventListener('abort',()=>controller.error(signal.reason),{once:true})}}));
// Also bound a model response that sends headers but never finishes its JSON body.
const keepAlive=setTimeout(()=>{},200);
await assert.rejects(()=>boundedCall({MINIMAX_API_KEY:'test'},[],0.1,4096,15));
clearTimeout(keepAlive);
console.log('AI task prefill, invalid-response retries and per-task editable form checks passed');
