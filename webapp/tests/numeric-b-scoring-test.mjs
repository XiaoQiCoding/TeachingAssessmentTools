import assert from 'node:assert/strict';
import fs from 'node:fs';
import worker from '../dist/server/index.js';
const source=fs.readFileSync(new URL('../frontend/classroom-score-policy.js',import.meta.url),'utf8');
const normalize=new Function(source+';return normalizeClassroomScores')();
const fixture=()=>({version:'1.4',dimensions:[3.5,3.5,3.5,4,null].map((score,i)=>({id:'B'+(i+1),score,weight:12,evidence:[],status:score==null?'insufficient_evidence':'mixed'})),module_b_score:null,summary:'B5待补证',score_note:'暂不生成总分'});
const saved=normalize(fixture());assert.deepEqual(saved.dimensions.map(d=>d.score),[3.5,3.5,3.5,4,5]);assert.equal(saved.module_b_score,46.8);assert.equal(saved.dimensions[4].evidence.length,0,'Default points never invent evidence');assert.ok(!JSON.stringify(saved).includes('待补证'));assert.deepEqual(normalize(structuredClone(saved)),saved);
const zero=normalize({dimensions:[1,2,3,4,5].map(i=>({id:'B'+i,score:0,evidence:[]}))});assert.equal(zero.module_b_score,0,'Explicit zero is a score, including an explicit B5 zero');
const controls=new Map(),$=id=>{if(!controls.has(id))controls.set(id,{textContent:'',innerHTML:'',classList:{add(){},remove(){}}});return controls.get(id)};
const main=fs.readFileSync(new URL('../frontend/index.html',import.meta.url),'utf8');
const render=main.slice(main.indexOf('function renderB('),main.indexOf('function recalc('));
const record={module_b:{report:fixture()}};
const rendered=new Function('record','$','esc','openB',source+render+';return renderB()')(record,$,String,()=>{});
assert.equal(rendered.module_b_score,46.8);assert.equal($('#bTotal').textContent,'46.8 / 60');assert.ok(!$('#bContent').innerHTML.includes('待补证'));assert.ok($('#bContent').innerHTML.includes('5 / 5'));
record.module_b.report=zero;new Function('record','$','esc','openB',source+render+';renderB()')(record,$,String,()=>{});assert.equal($('#bTotal').textContent,'0 / 60');
const classroom=fs.readFileSync(new URL('../frontend/classroom.html',import.meta.url),'utf8');
const reportView=classroom.slice(classroom.indexOf('  function renderReport('),classroom.indexOf('  function closeDimensionDetails('));
// Extract only the renderer so report dialogs do not enter this harness.
const renderer=reportView.slice(0,reportView.indexOf('\n  function ',5)>0?reportView.indexOf('\n  function ',5):undefined);
new Function('$','escapeHtml','timeLabel','input',source+renderer+';renderReport(input)')($,String,String,fixture());
assert.equal($('#moduleScore').textContent,46.8);assert.ok(!$('#reportDimensions').innerHTML.includes('待补证'));
const response=await worker.fetch(new Request('http://test/api/classroom/report',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({events:[]})}),{});assert.equal(response.status,200);const empty=await response.json();assert.deepEqual(empty.dimensions.map(d=>d.score),[0,0,0,0,5]);assert.equal(empty.module_b_score,12);
const negative={id:'N',phase:'tool_use',type:'emotion',outcome:'negative',confirmed:true,reviewed_clip:true,video_identity:'v',start_seconds:1,end_seconds:5,actual_response:'持续哭闹',completion_quality:'not_achieved'};
const bad=await(await worker.fetch(new Request('http://test/api/classroom/report',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({events:[negative],video_identity:'v'})}),{})).json();assert.ok(bad.dimensions[4].score<5,'Clear negative emotion never receives the no-problem default');
const zeroResponse=await worker.fetch(new Request('http://test/api/classroom/report',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({events:[{...negative,completion_quality:'unknown'}],video_identity:'v'})}),{});const zeroReport=await zeroResponse.json();assert.equal(zeroReport.module_b_score,0,'API must also return a real numeric zero total');assert.ok(zeroReport.dimensions.every(d=>d.score===0));
for(const report of [fixture(),zero]){
 const payload={basic:{tool_name:'课堂'},module_a:Object.fromEntries(['A1','A2','A3','A4','A5'].map(id=>[id,{score:5,evidence:'依据'}])),module_b:{report}};
 for(const module of ['B','demo']){
  const form=new FormData();form.set('payload',JSON.stringify(payload));form.set('module',module);
  const res=await worker.fetch(new Request('http://test/api/evaluation/export',{method:'POST',body:form}),{});assert.equal(res.status,200);const xml=new TextDecoder().decode(await res.arrayBuffer());assert.ok(!xml.includes('待补证'));assert.ok(xml.includes('SUM('));assert.ok(xml.includes(report===zero?'<v>0</v>':'<v>46.8</v>'));
 }
}
console.log('Numeric B scores: screenshot case 46.8/60, B5 defaults, negative emotion, empty evidence, zero total, saved reports, both views and Excel exports passed');
