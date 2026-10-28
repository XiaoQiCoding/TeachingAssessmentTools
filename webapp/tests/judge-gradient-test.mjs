import assert from 'node:assert/strict';
import worker from '../dist/server/index.js';

const identity='test-video';
function event(id,start,quality='achieved',extra={}){
  return {id,phase:'tool_use',type:'operation',student_id:'S01',confirmed:true,reviewed_clip:true,video_identity:identity,start_seconds:start,end_seconds:start+5,task:'分类',expected_response:'正确归类',actual_response:'学生将物品归入对应篮子',note:'学生实际操作',outcome:'positive',assistance:'independent',completion_quality:quality,quality_evidence:quality==='excellent'?'正确归类，动作连贯，持续主动完成':'' ,...extra};
}
async function report(events,extra={}){
  const response=await worker.fetch(new Request('http://test/api/classroom/report',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({events,video_identity:identity,video_duration:70,...extra})}),{});
  assert.equal(response.status,200);return response.json();
}
const students=[{id:'S01',level:'基础层'},{id:'S02',level:'发展层'}];
const ordinary=await report([event('normal',0)]);
assert.equal(ordinary.dimensions[2].score,4);assert.ok(ordinary.dimensions[2].evidence_sufficiency.notes.some(n=>n.includes('观察对象')));
const assisted=await report([event('assisted',0,'achieved',{assistance:'physical',assistance_matches_goal:'allowed'})]);
assert.equal(assisted.dimensions[2].score,4,'Allowed assistance is not automatically penalized');
const tooMuch=await report([event('over',0,'achieved',{assistance:'physical',assistance_matches_goal:'exceeds',assistance_evidence:'目标要求独立完成，实际全程由教师握手操作'})]);
assert.equal(tooMuch.dimensions[2].score,3);
const half=await report([event('a',0),event('b',10,'partial')]);
assert.equal(half.dimensions[2].score,3.5);assert.equal(half.dimensions[2].weighted_score,8.4);
const excellent=(count)=>Array.from({length:count},(_,i)=>event(`E${i}`,i*10,'excellent',{student_id:i%2?'S02':'S01'}));
const high=await report([event('mixed-a',0,'excellent'),event('mixed-b',10)],{students});assert.equal(high.dimensions[2].score,4.5);assert.equal(high.dimensions[2].evidence_sufficiency.status,'limited');
const top=await report(excellent(6),{students});assert.equal(top.dimensions[2].score,5);
assert.equal((await report(excellent(6).map(e=>({...e,quality_evidence:''})),{students})).dimensions[2].score,4,'No excellent score from an unsubstantiated label');
assert.equal((await report(excellent(6).map(e=>({...e,start_seconds:0,end_seconds:5})),{students})).dimensions[2].judge_metrics.opportunities,1,'Overlapping records cannot establish stability');
assert.equal((await report(excellent(6),{students:[...students,{id:'S03',level:'提高层'}]})).dimensions[2].score,5,'Missing student coverage must be disclosed separately, not lower observed performance');
assert.equal((await report([event('unverified-quality',0,'unknown')])).dimensions[2].score,0,'An explicit unknown quality cannot become a success score from a positive label');
const neutral=await report([event('unknown',0,'unknown',{outcome:'neutral'})]);assert.equal(neutral.dimensions[2].score,0);
const allDimensions=excellent(6).flatMap((e,i)=>[e,{...e,id:`G${i}`,type:'generalization',phase:'generalization',changed_context:'更换物品后仍按原分类规则完成'},{...e,id:`M${i}`,type:'emotion',actual_response:'持续平稳参与活动'}]);
const full=await report(allDimensions,{students});assert.equal(full.module_b_score,60,'Full marks remain attainable with sufficient evidence');
for(const row of full.dimensions){assert.ok(row.score_explanation);assert.ok(row.next_level_gap);assert.ok(row.judge_metrics.rated_event_ids.length);assert.equal(row.score*2,Math.round(row.score*2))}
const repeat=await report(allDimensions,{students});delete full.generated_at;delete repeat.generated_at;assert.deepEqual(full,repeat);
const exportResponse=await worker.fetch(new Request('http://test/api/classroom/export',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({video_identity:identity,video_duration:70,students,events:allDimensions})}),{});
assert.equal(exportResponse.status,200);const bytes=new TextDecoder().decode(await exportResponse.arrayBuffer());assert.ok(bytes.includes('本档依据'));assert.ok(bytes.includes('上一档核验'));
assert.equal((await report([event('single',0,'excellent')])).dimensions[2].score,5);
assert.ok((await report([event('single',0,'excellent')])).dimensions[2].evidence_sufficiency.notes.some(n=>n.includes('单次')));
console.log('Judge quality bands, separate evidence scope, assistance fairness and report/export explanations passed');
