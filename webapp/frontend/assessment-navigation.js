// Route within one workspace so file inputs and the classroom session stay alive.
(() => {
  const frame=document.querySelector('#classroomFrame');
  let pendingEvidence=null;
  function route(){return ['overview','moduleA','moduleB'].includes(location.hash.slice(1))?location.hash.slice(1):'overview'}
  function sendEvidence(){
    if(!pendingEvidence||frame.dataset.ready!=='true')return;
    frame.contentWindow.postMessage({type:'assessment-evidence',...pendingEvidence},location.origin);pendingEvidence=null;
  }
  function ensureClassroom(){
    if(!frame.getAttribute('src')){frame.dataset.ready='false';frame.src=`/classroom?record=${encodeURIComponent(DEMO_ID)}&embedded=1`;}
  }
  function applyView(){
    const view=route();
    for(const section of document.querySelectorAll('[data-view]'))section.hidden=section.dataset.view!==view;
    for(const link of document.querySelectorAll('[data-app-view]')){const active=link.dataset.appView===view;link.classList.toggle('active',active);if(active)link.setAttribute('aria-current','page');else link.removeAttribute('aria-current');}
    if(view==='moduleB')ensureClassroom();
    document.title=({overview:'总览',moduleA:'模块 A · 课前适配',moduleB:'模块 B · 课堂效果'})[view]+' · 教具学具评估';
  }
  function navigate(view){location.hash=view;applyView();window.scrollTo(0,0)}
  function refreshOverview(){
    const source=document.querySelector('#moduleA .table-wrap'),target=document.querySelector('#overviewAContent');
    if(source&&target){const table=source.cloneNode(true);for(const node of table.querySelectorAll('[id]'))node.removeAttribute('id');target.replaceChildren(table);}
    const picker=document.querySelector('#recordPicker'),selection=DEMO_ID;
    picker.replaceChildren(...allRecords().map(item=>{const option=document.createElement('option');option.value=item.id;option.textContent=(item.basic?.tool_name||'未命名评估')+' · '+new Date(item.created_at||item.updated_at).toLocaleDateString();return option}));picker.value=selection;
  }
  async function finishMaterialWrites(){
    await window.assessmentMaterials.whenIdle();
    try{await frame.contentWindow?.assessmentMaterials?.whenIdle()}catch{}
  }
  window.openAssessmentB=dimension=>{
    persist();if(dimension)pendingEvidence={dimension,return_view:'overview'};navigate('moduleB');sendEvidence();
  };
  window.assessmentNavigation={refreshOverview,navigate};
  window.addEventListener('hashchange',applyView);
  window.addEventListener('message',event=>{
    if(event.origin!==location.origin||event.source!==frame.contentWindow)return;
    if(event.data?.type==='assessment-ready'){frame.dataset.ready='true';sendEvidence();}
    if(event.data?.type==='assessment-navigate'&&['overview','moduleA','moduleB'].includes(event.data.view))navigate(event.data.view);
  });
  window.addEventListener('storage',event=>{
    if(event.key!==RECORDS_KEY)return;
    const latest=allRecords().find(item=>item.id===DEMO_ID);if(latest){record=latest;for(const input of document.querySelectorAll('.basic'))if(input!==document.activeElement)input.value=record.basic[input.dataset.field]||'';recalc();}
  });
  document.addEventListener('click',event=>{
    const detail=event.target.closest('[data-evidence-dimension]');if(detail)window.openAssessmentB(detail.dataset.evidenceDimension);
  });
  document.querySelector('#recordPicker').addEventListener('change',async event=>{
    const id=event.target.value;if(!id||id===DEMO_ID)return;
    await finishMaterialWrites();persist();localStorage.setItem(ACTIVE_KEY,id);location.href=`/?record=${encodeURIComponent(id)}#overview`;
  });
  document.querySelector('#restartAssessment').addEventListener('click',async()=>{
    if(document.querySelector('#analyzeA').disabled||frame.contentWindow?.evaluationAnalysisRunning?.()){document.querySelector('#saveState').textContent='请先完成或暂停当前分析，再开始新评估。';return;}
    await finishMaterialWrites();persist();
    const id='EVAL-'+crypto.randomUUID(),next={...fresh(),id};
    localStorage.setItem(RECORDS_KEY,JSON.stringify([next,...allRecords()]));localStorage.setItem(ACTIVE_KEY,id);location.href=`/?record=${encodeURIComponent(id)}#overview`;
  });
  document.querySelector('#aDescription').addEventListener('input',event=>{record.module_a_inputs={...(record.module_a_inputs||{}),description:event.target.value};persist()});
  document.querySelector('#aDescription').value=record.module_a_inputs?.description||'';
  void window.assessmentMaterials.bind({recordId:DEMO_ID,slot:'moduleA.files',input:document.querySelector('#aFiles'),status:document.querySelector('#aMaterialStatus')});
  refreshOverview();applyView();
})();
