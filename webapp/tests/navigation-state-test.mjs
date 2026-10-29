import assert from 'node:assert/strict';
import fs from 'node:fs';
const main=fs.readFileSync(new URL('../frontend/index.html',import.meta.url),'utf8');
const classroom=fs.readFileSync(new URL('../frontend/classroom.html',import.meta.url),'utf8');
const navigation=fs.readFileSync(new URL('../frontend/assessment-navigation.js',import.meta.url),'utf8');

// Switching views keeps the same classroom frame, including its selected File objects.
const views=['overview','moduleA','moduleB'].map(view=>({dataset:{view},hidden:false}));
const links=views.map(view=>({dataset:{appView:view.dataset.view},classList:{toggle(){}},setAttribute(){},removeAttribute(){}}));
let src='',loads=0;const frame={dataset:{},getAttribute:()=>src,set src(value){src=value;loads++},selectedFiles:['original-video.mp4']};
const document={querySelectorAll:selector=>selector==='[data-view]'?views:links};
const location={hash:'#overview'};
const helpers=navigation.slice(navigation.indexOf('  function route(){'),navigation.indexOf('  function navigate('));
const apply=new Function('document','location','frame','DEMO_ID',helpers+';return applyView')(document,location,frame,'record-1');
apply();assert.deepEqual(views.map(view=>view.hidden),[false,true,true]);
location.hash='#moduleB';apply();assert.equal(loads,1);assert.ok(src.includes('record=record-1&embedded=1'));
location.hash='#moduleA';apply();assert.deepEqual(views.map(view=>view.hidden),[true,false,true]);
location.hash='#moduleB';apply();assert.equal(loads,1,'Changing tabs cannot reload the classroom');assert.deepEqual(frame.selectedFiles,['original-video.mp4']);

// A parent editing A must not overwrite newer B work saved by the classroom.
const latest={id:'record-1',module_b:{candidates:[{id:'AI1'}],events:[{id:'E1'}],report:{score:12}}};
const record={id:'record-1',basic:{teacher:'new edit'},module_b:{candidates:[],events:[],report:null}};
const store=new Map([['records',JSON.stringify([latest])]]),localStorage={getItem:key=>store.get(key),setItem:(key,value)=>store.set(key,value)};
const allRecords=()=>JSON.parse(store.get('records'));
const persistCode=main.slice(main.indexOf('function persist('),main.indexOf('function aState('));
const scorePolicy=fs.readFileSync(new URL('../frontend/classroom-score-policy.js',import.meta.url),'utf8');
new Function('record','allRecords','localStorage','$',`let records=[];const DEMO_ID='record-1',RECORDS_KEY='records',ACTIVE_KEY='active';${scorePolicy}${persistCode};persist();`)(record,allRecords,localStorage,()=>({textContent:''}));
assert.deepEqual(JSON.parse(store.get('records'))[0].module_b,latest.module_b);assert.equal(JSON.parse(store.get('records'))[0].basic.teacher,'new edit');

// Formal-record recovery retains AI candidates, not only confirmed events and reports.
const formal={basic:{tool_name:'lesson',goals:'goal'},module_b:{candidates:[{id:'AI1'}],events:[{id:'E1'}],recommended_windows:[{status:'analyzed'}],observation_tasks:[{task:'task'}],report:{version:'1.4'},plan_source_key:'lesson.docx:100:1'}};
const recordDraftCode=classroom.slice(classroom.indexOf('  function recordDraft(){'),classroom.indexOf('  function syncEvaluationRecord(){'));
const draft=new Function('activeEvaluationRecord','analysisInfo',recordDraftCode+';return recordDraft()')(()=>formal,{});
assert.deepEqual(draft.candidates,formal.module_b.candidates);assert.deepEqual(draft.events,formal.module_b.events);assert.equal(draft.plan_source_key,formal.module_b.plan_source_key);assert.equal(draft.step,4);
console.log('Workspace navigation: persistent frame, separate views, concurrent A/B preservation and complete formal-record recovery passed');

// Overview hides an unassessed A rubric, including after resetting a previous result.
{
  let entered='',cloned=0;
  const button={addEventListener(_type,handler){this.click=handler}};
  const target={innerHTML:'',querySelector:()=>button,replaceChildren(node){this.innerHTML='';this.child=node}};
  const source={cloneNode(){cloned++;return{querySelectorAll:()=>[]}}};
  const picker={replaceChildren(){}};
  const record={module_a:{A1:{score:'',evidence:''}},module_a_meta:null};
  const document={querySelector:selector=>selector==='#moduleA .table-wrap'?source:selector==='#overviewAContent'?target:picker,createElement:()=>({})};
  const code=navigation.slice(navigation.indexOf('  function refreshOverview(){'),navigation.indexOf('  async function finishMaterialWrites('));
  const refresh=new Function('document','record','allRecords','DEMO_ID','navigate',code+';return refreshOverview')(document,record,()=>[],'current',view=>entered=view);
  refresh();assert.match(target.innerHTML,/尚未生成课前评估结果/);assert.equal(cloned,0);
  button.click();assert.equal(entered,'moduleA');
  record.module_a_meta={summary:'证据不足'};refresh();assert.equal(cloned,1,'Completed assessments with unknown scores must still show results');
  record.module_a_meta=null;record.module_a.A1={score:5,evidence:'已观察'};refresh();assert.equal(cloned,2,'Legacy scored records retain their table');
  record.module_a.A1={score:'',evidence:''};refresh();assert.match(target.innerHTML,/进入评估/);assert.equal(cloned,2);
}