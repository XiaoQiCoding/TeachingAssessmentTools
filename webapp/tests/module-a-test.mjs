import assert from 'node:assert/strict';
import fs from 'node:fs';
import worker from '../dist/server/index.js';

const template = fs.readFileSync(new URL('../backend/worker.template.js', import.meta.url), 'utf8');
const parserSource = template.slice(template.indexOf('const MODULE_A_CRITERIA ='), template.indexOf('async function evaluateModuleA'));
const parse = new Function(parserSource + '; return parseModuleAResult;')();
const rows = ['A1','A2','A3','A4','A5'].map(id => ({id, score:5, status:'supported', evidence:`材料中 ${id} 的具体事实`, modification:''}));
const valid = JSON.stringify({summary:'测试结果', dimensions:rows});
const read = text => parse(text, ['sample.txt'], 'test');
assert.equal(read(valid).module_a_score, 40);
const tab = rows.map(r => `A\t${r.id}\t5\tsupported\t${r.evidence}\t`).join('\n');
assert.equal(read(tab).module_a_score, 40);
assert.equal(read(tab.replaceAll('\t','<TAB>')).module_a_score, 40);
assert.equal(read(tab.replaceAll('\t','\\t')).module_a_score, 40);
assert.equal(read(tab.replace('A\tA1\t5', 'A\tA1\t主题与目标匹配\t5')).dimensions[0].evidence, rows[0].evidence);
for (const dimensions of [rows.slice(0,4), [...rows.slice(0,4),rows[0]], rows.map((r,i)=>i? r:{...r,score:'主题与目标匹配',evidence:'supported'}), rows.map((r,i)=>i?r:{...r,evidence:''}),rows.map((r,i)=>i?r:{...r,score:6}),rows.map((r,i)=>i?r:{...r,score:null})]) {
  assert.throws(()=>read(JSON.stringify({dimensions})));
}
assert.throws(()=>read(''));
assert.throws(()=>read(valid.slice(0,70)));
const unknown = rows.map((r,i)=>i?r:{...r,score:null,status:'unknown',evidence:'材料没有提供可核对依据',modification:'补充教具如何服务本课目标的具体任务及操作步骤。'});
assert.equal(read(JSON.stringify({dimensions:unknown})).dimensions[0].score,2);
assert.equal(read(JSON.stringify({dimensions:unknown})).dimensions[0].provisional,true);

let outputs=[], requests=[];
globalThis.fetch=async (_url,options)=>{
  requests.push(JSON.parse(options.body));
  return new Response(JSON.stringify({choices:[{message:{content:outputs.shift()}}],base_resp:{status_code:0}}),{headers:{'content-type':'application/json'}});
};
async function evaluate(sequence){
  outputs=[...sequence];requests=[];
  const form=new FormData();form.set('description','测试教具材料');
  const response=await worker.fetch(new Request('https://test/api/evaluation/module-a',{method:'POST',body:form}),{MINIMAX_API_KEY:'test'});
  return {response,body:await response.json()};
}
assert.equal((await evaluate([valid])).body.module_a_score,40);
assert.equal(requests.length,1);
assert.equal((await evaluate(['错误格式',valid])).body.module_a_score,40);
assert.equal(requests.length,2);
assert.ok(requests[1].messages[0].content.includes('校验错误'));
assert.equal((await evaluate(['',valid])).body.module_a_score,40);
assert.ok(requests[1].messages[0].content.includes('测试教具材料'));
const failed=await evaluate(['错误格式','错误格式','错误格式']);
assert.equal(failed.response.status,502);
assert.equal(failed.body.code,'MODULE_A_INVALID_RESULT');
assert.equal(requests.length,3);
assert.equal(failed.body.dimensions,undefined);
console.log('Module A format validation and bounded retries passed');

const policyResult=dimensions=>read(JSON.stringify({dimensions}));
const absent=rows.map(r=>({...r,score:null,status:'unknown',evidence:'没有该项直接材料依据',evidence_level:'missing',modification:'补充该指标对应的教具用途、任务步骤和支持安排。'}));
assert.deepEqual(policyResult(absent).dimensions.map(r=>r.score),[2,2,2,5,2]);
const vague=rows.map(r=>({...r,score:1,status:'concern',evidence:'教案仅宽泛说明使用教具支持学习',evidence_level:'vague',modification:'将笼统的教具支持意图细化为任务中的操作步骤。'}));
assert.deepEqual(policyResult(vague).dimensions.map(r=>r.score),[2,2,2,5,2]);
const risk=rows.map(r=>r.id==='A4'?{...r,score:3,status:'mixed',modification:'将学生直接接触的尖锐刀具更换为安全替代教具。',safety_risks:[{evidence:'材料明确写明学生直接接触尖锐刀具',deduction:4}]}:r);
assert.equal(policyResult(risk).dimensions[3].score,1);assert.equal(policyResult(risk).audit.safety_veto,true);
const zero=rows.map(r=>r.id==='A5'?{...r,score:0,status:'concern',evidence_level:'direct',evidence:'材料明确说明所有教具封死，学生无法接触或操作',modification:'调整教具结构，开放可操作部件，让学生能够完成对应任务。',exceptional_zero_reason:'材料明确说明全部封死，完全不能完成任何对应操作任务'}:r);
assert.equal(policyResult(zero).dimensions[4].score,0);
assert.equal(policyResult(zero.map(r=>({...r,exceptional_zero_reason:''}))).dimensions[4].score,2);
assert.equal(policyResult(rows.map(r=>r.id==='A4'?{...r,score:1,status:'concern',evidence:'未提供材质尺寸和消毒说明，无法判断是否有小零件'}:r)).dimensions[3].score,5);
console.log('Module A lenient policy: all five scored, provisional minimum 2, safety deduction, evidenced zero and no missing-info veto passed');

const partial=rows.map(r=>({...r,score:2,status:'concern',evidence_level:'partial',modification:'补充各组教具的轮换顺序和使用安排。',evidence:'文字已写明分组操作和必要辅助，仅未逐件列数量'}));
assert.deepEqual(policyResult(partial).dimensions.map(r=>r.score),[4,4,4,5,4]);
const clearDesign=rows.map(r=>({...r,evidence_level:'direct',evidence:'教案写明具体任务、教具用途、操作或辅助安排；未附实物照片'}));
assert.deepEqual(policyResult(clearDesign).dimensions.map(r=>r.score),[5,5,5,5,5]);
console.log('Core design anchors: actionable text counts as direct evidence, partial implementation remains 4, genuine vague/missing still 2-3');

// Advice is independent of full marks; deductions must have actionable changes.
assert.ok(read(valid).dimensions.every(r=>r.modification==='暂无必要修改'));
const advice='可选优化：将现有分组流程制作成视觉提示卡。';
assert.ok(policyResult(rows.map(r=>({...r,modification:advice}))).dimensions.every(r=>r.score===5&&r.modification===advice));
for(const modification of ['', '   ', '—', '暂无必要修改', '无需修改。', '建议完善']) {
  const deducted=rows.map(r=>r.id==='A1'?{...r,score:4,modification}:r);
  assert.throws(()=>policyResult(deducted),/可执行修改措施/);
}
const missingAdvice=JSON.stringify({dimensions:rows.map(r=>r.id==='A1'?{...r,score:4}:r)});
const repairedAdvice=JSON.stringify({dimensions:rows.map(r=>r.id==='A1'?{...r,score:4,modification:'在教案中明确教具对应的目标和操作任务。'}:r)});
const repaired=await evaluate([missingAdvice,repairedAdvice]);
assert.equal(requests.length,2);
assert.match(repaired.body.dimensions[0].modification,/明确教具/);
assert.equal(repaired.body.dimensions[0].score,4);
console.log('Module A advice: full-score fallback, optional optimization preserved, missing deduction advice triggers repair');
