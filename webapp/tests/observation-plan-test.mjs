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
const html=fs.readFileSync(new URL('../frontend/classroom.html',import.meta.url),'utf8');
assert.ok(html.includes('data-task-field="success_criteria"'));assert.ok(html.includes('data-task-field="allowed_assistance"'));
assert.ok(!html.includes('<textarea class="control" id="observationPlan"'));
assert.ok(html.includes('taskRevision!==revision'),'Late AI responses must not overwrite user edits');
assert.ok(html.includes('observation_tasks:readObservationTasks()'),'Structured edits must persist');
console.log('AI task prefill, invalid-response retries and per-task editable form checks passed');
