import assert from 'node:assert/strict';
import worker from '../dist/server/index.js';

const identity='sample.mp4:10000:123';
const event=(id,type,extra={})=>({id,type,phase:'tool_use',student_id:'S01',outcome:'positive',assistance:'independent',start_seconds:10,end_seconds:20,note:'学生完成任务',confirmed:true,reviewed_clip:true,video_identity:identity,task:'分类',expected_response:'按颜色归类',actual_response:'学生把红色物品放入红色篮子',...extra});
async function score(events){
  const response=await worker.fetch(new Request('http://test/api/classroom/report',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({evidence_version:2,video_identity:identity,lesson:{name:'分类课程'},events})}),{});
  assert.equal(response.status,200);return response.json();
}
const samples=[event('E1','response'),event('E2','operation'),event('E3','generalization',{phase:'generalization',changed_context:'更换物品后仍按颜色分类'}),event('E4','emotion',{actual_response:'本片段学生表情平稳'})];
const complete=await score(samples);
assert.equal(complete.version,'1.4');assert.equal(complete.audit.rule_version,'classroom-b-v6');assert.equal(complete.module_b_score,48);
const repeat=await score(samples);delete repeat.generated_at;const comparable={...complete};delete comparable.generated_at;assert.deepEqual(repeat,comparable);
for(const row of complete.dimensions){assert.ok(row.scoring_basis);assert.ok(row.evidence.length);for(const evidence of row.evidence){assert.equal(evidence.video_identity,identity);assert.ok(evidence.end_seconds>evidence.start_seconds);assert.ok(evidence.actual_response)}}
const rejected=await score([event('sample','response',{reviewed_clip:false}),event('teacher','response',{actual_response:''}),event('no-task','operation',{expected_response:''}),event('no-transfer','generalization',{phase:'generalization',changed_context:''}),event('wrong-video','emotion',{video_identity:'another'})]);
assert.equal(rejected.event_count,0);assert.equal(rejected.module_b_score,null);assert.equal(rejected.observed_weighted_score,0);assert.equal(rejected.audit.excluded_event_ids.length,5);
const partial=await score([event('E1','response')]);
assert.equal(partial.dimensions[4].score,null);assert.equal(partial.module_b_score,null);assert.equal(partial.scored_weight,24);assert.equal(partial.observed_weighted_score,19.2);
const many=await score(Array.from({length:12},(_,i)=>event(`E${i}`,'response',{start_seconds:i*10,end_seconds:i*10+5})));
assert.equal(many.dimensions[1].evidence.length,12,'Every scoring event must be traceable');
globalThis.fetch=async()=>new Response(JSON.stringify({content:[{type:'text',text:JSON.stringify({summary:'片段观察',candidates:[{start_seconds:2,end_seconds:9,type:'response',phase:'tool_use',outcome:'positive',note:'学生尝试',task:'分类',expected_response:'正确分类',actual_response:'放入篮子'}]})}]}),{headers:{'content-type':'application/json'}});
const form=new FormData();form.append('mode','video');form.append('clip_offset','100');form.append('duration','10');form.append('video',new Blob(['test'],{type:'video/webm'}),'clip.webm');
const clip=await (await worker.fetch(new Request('http://test/api/classroom/video-candidates',{method:'POST',body:form}),{MINIMAX_API_KEY:'test'})).json();
assert.equal(clip.candidates[0].start_seconds,102);assert.equal(clip.candidates[0].end_seconds,109);assert.equal(clip.candidates[0].confirmed,false);assert.equal(clip.candidates[0].analysis_source,'continuous_clip');
console.log('Video evidence eligibility, traceability, partial totals and clip offsets passed');
