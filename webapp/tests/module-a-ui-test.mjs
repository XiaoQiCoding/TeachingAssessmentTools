import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html=fs.readFileSync(new URL('../frontend/index.html',import.meta.url),'utf8');
// Parse the entire startup script, not only isolated helpers.
new vm.Script(html.slice(html.lastIndexOf('<script>')+8,html.lastIndexOf('</script>')));
const handler=html.slice(html.indexOf("$('#analyzeA').onclick="),html.indexOf("window.addEventListener('pageshow'"));
const elements=new Map();
const $=selector=>{
  if(!elements.has(selector))elements.set(selector,{files:[],value:'',textContent:'',disabled:false,classList:{add(){},remove(){}}});
  return elements.get(selector);
};
const dimensions=['A1','A2','A3','A4','A5'].map(id=>({id,score:id==='A1'?0:5,evidence:'材料中有明确证据',status:'supported'}));
let resolveRequest,saveCount=0,renderCount=0;
const context=vm.createContext({$,FormData,Set,Date,record:{basic:{}},A_ITEMS:dimensions,alert:()=>assert.fail('Unexpected missing-material alert'),
  fetch:()=>new Promise(resolve=>resolveRequest=resolve),persist:()=>saveCount++,recalc:()=>renderCount++});
vm.runInContext("let aFailure='';"+handler,context);
$('#aDescription').value='教案和教具说明';
const button=$('#analyzeA');
const pending=button.onclick({currentTarget:button});
assert.equal(button.disabled,true);
assert.match($('#aState').textContent,/正在读取材料/);
resolveRequest(Response.json({dimensions,summary:'完成评估'}));
await pending;
assert.equal(saveCount,1);assert.equal(renderCount,1);assert.equal(button.disabled,false);
assert.equal(context.record.module_a.A1.score,0);
const previous=context.record.module_a;
const failed=button.onclick({currentTarget:button});
resolveRequest(Response.json({error:'模拟模型服务不可用'},{status:503}));
await failed;
assert.equal(button.disabled,false);assert.equal(saveCount,1);
assert.equal(context.record.module_a,previous,'Failed requests must preserve previous results');
assert.match($('#aState').textContent,/模拟模型服务不可用/);
assert.match($('#aState').textContent,/不是本次结果/);
console.log('Module A UI: complete script parses, click starts request, success saves, failure is visible and previous results survive');

const stateSource=html.slice(html.indexOf('function aState('),html.indexOf('function buildA('));
const stateFor=record=>new Function('record','A_ITEMS',stateSource+';return aState()')(record,dimensions);
assert.equal(stateFor(context.record).complete,true,'A legitimate zero must not become a missing score');
assert.equal(stateFor({module_a:Object.fromEntries(dimensions.map(r=>[r.id,{score:'',evidence:''}]))}).complete,false,'Unassessed empty inputs must not become zeros');
