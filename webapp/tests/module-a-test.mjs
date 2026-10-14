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
const unknown = rows.map((r,i)=>i?r:{...r,score:null,status:'unknown',evidence:'材料没有提供可核对依据'});
assert.equal(read(JSON.stringify({dimensions:unknown})).module_a_score, null);

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
