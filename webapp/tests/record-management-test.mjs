import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const main=fs.readFileSync(new URL('../frontend/index.html',import.meta.url),'utf8');
const navigation=fs.readFileSync(new URL('../frontend/assessment-navigation.js',import.meta.url),'utf8');
const classroom=fs.readFileSync(new URL('../frontend/classroom.html',import.meta.url),'utf8');
const materialScript=fs.readFileSync(new URL('../frontend/assessment-materials.js',import.meta.url),'utf8');
const freshCode=main.slice(main.indexOf('function fresh('),main.indexOf('function allRecords('));
const fresh=new Function('DEMO_ID','A_ITEMS',freshCode+';return fresh')('current',['A1','A2','A3','A4','A5'].map(id=>({id})));

function setup({others=true,confirm=true,busy=false}={}){
  const current={...fresh(),name:'原名称',basic:{tool_name:'教具名称',teacher:'教师',goals:'目标'},module_a:{A1:{score:5,evidence:'证据'}},module_a_inputs:{description:'旧说明'},module_a_meta:{summary:'旧总结'},module_b:{report:{module_b_score:60},events:[{id:'E1'}],candidates:[{id:'C1'}],transcript_state:{segments:[{text:'旧文字稿'}]}}};
  const other={...fresh(),id:'other',name:'其他记录'},key='records',draftKey='classroom-evaluation-draft-v4-current';
  const store={records:JSON.stringify(others?[current,other]:[current]),[draftKey]:'old',[draftKey+'-plan-batches']:'old',[draftKey+'-locator-batches']:'old',[draftKey+'-before-restore']:'old','classroom-evaluation-draft-v4-other':'keep'};
  const materials=new Map([['current:moduleA.files',['photo']],['current:lessonPlan',['lesson']],['current:classroomVideo',['video']],['other:classroomVideo',['keep']]]);
  const calls=[],elements=new Map();
  const element=selector=>{if(!elements.has(selector))elements.set(selector,{dataset:{},disabled:false,value:'',textContent:'',open:false,showModal(){this.open=true},close(){this.open=false},focus(){},select(){},setAttribute(name,value){this[name]=value},removeAttribute(name){delete this[name]},listeners:{},classList:{add(){},remove(){},toggle(){}},addEventListener(type,fn){this.listeners[type]=fn},replaceChildren(...children){this.children=children},querySelector(selector){return element(selector)},getAttribute(){return null},cloneNode(){return {querySelectorAll:()=>[]}}});return elements.get(selector)};
  let suppressSave=false;
  const frame=element('#classroomFrame');frame.contentWindow={evaluationModelLocked:()=>busy,discardAssessment(){suppressSave=true},assessmentMaterials:{whenIdle:async()=>calls.push('child-idle')}};
  const document={querySelector:element,querySelectorAll:()=>[],addEventListener(){},createElement:()=>({})};
  const localStorage={getItem:k=>store[k]??null,setItem:(k,v)=>store[k]=v,removeItem:k=>delete store[k]};
  // Storage keys are enumerable in the browser, its methods are not.
  const storage=new Proxy(localStorage,{ownKeys:()=>Reflect.ownKeys(store),getOwnPropertyDescriptor:()=>({enumerable:true,configurable:true})});
  const location={hash:'#overview',origin:'http://local',replace(url){calls.push(url);if(!suppressSave)store[draftKey]='resurrected by unload'}};
  const window={addEventListener(){},scrollTo(){},assessmentMaterials:{bind:async()=>{},whenIdle:async()=>calls.push('parent-idle'),removeRecord:async id=>{calls.push('remove-materials');for(const key of materials.keys())if(key.startsWith(id+':'))materials.delete(key)}}};
  const context=vm.createContext({document,window,location,localStorage:storage,DEMO_ID:'current',RECORDS_KEY:key,ACTIVE_KEY:'active',record:current,allRecords:()=>JSON.parse(store.records),fresh,persist:()=>{store.records=JSON.stringify([context.record,...JSON.parse(store.records).filter(item=>item.id!=='current')])},recalc(){},crypto:{randomUUID:()=> 'new-id'},confirm:()=>confirm,Date,console});
  vm.runInContext(navigation,context);
  return {store,materials,calls,context,element,other,click:selector=>element(selector).listeners.click(),submitName:()=>element('#saveRename').listeners.click({preventDefault(){}})};
}

// Reset a populated formal record with scored A/B reports and every draft cache.
{
  const app=setup();await app.click('#restartAssessment');
  const [reset,other]=JSON.parse(app.store.records);
  assert.equal(reset.id,'current');assert.equal(reset.basic.tool_name,'');assert.equal(reset.basic.teacher,'');
  assert.ok(Object.values(reset.module_a).every(item=>item.score===''&&item.evidence===''));
  assert.equal(reset.module_a_meta,null);assert.equal(reset.module_a_inputs,undefined);
  assert.deepEqual(reset.module_b,{report:null,events:[],analysis_info:null});
  assert.equal(other.name,'其他记录');assert.equal(app.store.active,'current');
  assert.ok(!Object.keys(app.store).some(key=>key.startsWith('classroom-evaluation-draft-v4-current')),'Unload must not restore old scores or draft');
  assert.deepEqual([...app.materials.keys()],['other:classroomVideo']);
  assert.equal(app.store['classroom-evaluation-draft-v4-other'],'keep');
  assert.equal(app.calls.at(-1),'/?record=current#overview');
  // The actual A/B render functions must show blank scores after reset.
  const render=main.slice(main.indexOf('function aState('),main.indexOf('function recalc('));
  new Function('record','A_ITEMS','$','esc','openB',`let aFailure='';${render};buildA();renderB();`)(reset,['A1','A2','A3','A4','A5'].map(id=>({id})),app.element,String,()=>{});
  assert.equal(app.element('#aTotal').textContent,'— / 40');assert.equal(app.element('#bTotal').textContent,'— / 60');
  assert.ok(app.element('#aBody').innerHTML.includes('— / 5'));
}
{
  const app=setup();await app.click('#deleteAssessment');
  assert.deepEqual(JSON.parse(app.store.records).map(item=>item.id),['other']);assert.equal(app.store.active,'other');
  assert.equal(app.calls.at(-1),'/?record=other#overview');assert.ok(!app.store['classroom-evaluation-draft-v4-current']);
}
{
  const app=setup({others:false});await app.click('#deleteAssessment');
  const [next]=JSON.parse(app.store.records);assert.equal(next.id,'EVAL-new-id');assert.equal(next.module_b.report,null);assert.equal(app.store.active,next.id);
}
for(const options of [{confirm:false},{busy:true}]){
  const app=setup(options),before=app.store.records;await app.click('#restartAssessment');assert.equal(app.store.records,before);assert.equal(app.materials.size,4);
}
{
  const app=setup();await app.click('#renameAssessment');
  assert.equal(app.element('#renameDialog').open,true);
  assert.equal(app.element('#recordName').value,'原名称');
  app.element('#recordName').value='  审阅记录  ';app.submitName();
  const renamed=JSON.parse(app.store.records)[0];assert.equal(renamed.name,'审阅记录');assert.equal(renamed.basic.tool_name,'教具名称');assert.equal(renamed.module_b.report.module_b_score,60);
  assert.ok(app.element('#recordPicker').children[0].textContent.startsWith('审阅记录'));
  assert.equal(app.element('#renameDialog').open,false);
  await app.click('#renameAssessment');assert.equal(app.element('#recordName').value,'审阅记录');
}
{
  const app=setup(),before=app.store.records;await app.click('#renameAssessment');
  app.element('#recordName').value='   ';app.submitName();
  assert.equal(app.store.records,before);assert.equal(app.element('#renameDialog').open,true);
  assert.equal(app.element('#renameError').textContent,'记录名称不能为空。');
  assert.equal(app.element('#recordName')['aria-invalid'],'true');
  await app.click('#cancelRename');assert.equal(app.element('#renameDialog').open,false);
  await app.click('#renameAssessment');assert.equal(app.element('#renameError').textContent,'');
  assert.equal(app.element('#recordName')['aria-invalid'],undefined);
  app.element('#recordName').value='未保存名称';await app.click('#cancelRename');assert.equal(app.store.records,before);
}
{
  const app=setup(),before=app.store.records;await app.click('#renameAssessment');
  app.context.persist=()=>{throw new Error('storage unavailable')};
  app.element('#recordName').value='保存失败的名称';app.submitName();
  assert.equal(app.store.records,before);assert.equal(app.context.record.name,'原名称');
  assert.equal(app.element('#renameDialog').open,true);assert.match(app.element('#renameError').textContent,/未能保存/);
}
// Exercise the actual IndexedDB cursor deletion, including optional B-only slots.
{
  const files=new Map([['r:moduleA.files',1],['r:lessonPlan',2],['r:classroomVideo',3],['r2:lessonPlan',4]]);
  const db={transaction(){const tx={objectStore:()=>({openCursor(){const request={},keys=[...files.keys()];let index=0;const advance=()=>queueMicrotask(()=>{if(index===keys.length){request.result=null;request.onsuccess();queueMicrotask(()=>tx.oncomplete());return}const key=keys[index++];request.result={key,delete:()=>files.delete(key),continue:advance};request.onsuccess()});advance();return request}})};return tx}};
  const indexedDB={open(){const request={};queueMicrotask(()=>{request.result=db;request.onsuccess()});return request}};
  const window={};vm.runInNewContext(materialScript,{window,indexedDB});
  await window.assessmentMaterials.removeRecord('r',['lessonPlan','classroomVideo']);assert.deepEqual([...files.keys()],['r:moduleA.files','r2:lessonPlan']);
  await window.assessmentMaterials.removeRecord('r');assert.deepEqual([...files.keys()],['r2:lessonPlan']);
}

// B-only clearing suppresses unload autosave and erases the formal report too.
{
  const app=setup(),start=classroom.indexOf("  $('#clearDraft').addEventListener('click',"),end=classroom.indexOf("  document.querySelectorAll('#lessonName",start);
  let handler,reloaded=false;const context=vm.createContext({$:()=>({addEventListener:(_event,fn)=>handler=fn}),window:{assessmentMaterials:{whenIdle:async()=>{},removeRecord:async()=>{}},evaluationModelLocked:()=>false},confirm:()=>true,alert:message=>assert.fail(message),localStorage:new Proxy({getItem:key=>app.store[key]??null,setItem:(key,value)=>app.store[key]=value,removeItem:key=>delete app.store[key]},{ownKeys:()=>Object.keys(app.store),getOwnPropertyDescriptor:()=>({enumerable:true,configurable:true})}),ACTIVE_RECORD_ID:'current',DRAFT_KEY:'classroom-evaluation-draft-v4-current',RECORDS_KEY:'records',LEGACY_DRAFT_KEY:'legacy',restoringDraft:false,location:{reload(){reloaded=true}},Date});
  vm.runInContext(classroom.slice(start,end),context);await handler();assert.equal(context.restoringDraft,true);assert.equal(reloaded,true);assert.equal(JSON.parse(app.store.records)[0].module_b.report,null);
}
console.log('Record management: complete reset, blank score rendering, rename, delete, cancellation, material isolation and unload protection passed');
