// Shared by both modules. Credentials and upstream URLs stay on the server.
(() => {
  // crypto.randomUUID only exists in a secure context (https or localhost).
  // The site is often opened over plain http on a public IP, so fall back to getRandomValues.
  const uuid=()=>{
    const c=(typeof globalThis!=='undefined'?globalThis.crypto:null)||(typeof window!=='undefined'?window.crypto:null);
    if(typeof c?.randomUUID==='function')return c.randomUUID();
    const bytes=c.getRandomValues(new Uint8Array(16));
    bytes[6]=(bytes[6]&0x0f)|0x40;bytes[8]=(bytes[8]&0x3f)|0x80;
    const hex=[...bytes].map(x=>x.toString(16).padStart(2,'0')).join('');
    return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
  };
  if(typeof window!=='undefined')window.evaluationUuid=uuid;
  const storageKey='teaching-evaluation-model-v1',select=document.querySelector('#evaluationModel'),hint=document.querySelector('#evaluationModelHint');
  const allowed=['qwen3.8-flash','qwen3.8-max','qwen3.7-plus','MiniMax-M3'];
  let selected='qwen3.8-max',pending=0;
  try{const saved=localStorage.getItem(storageKey);if(allowed.includes(saved))selected=saved}catch{}
  if(select)select.value=selected;
  window.evaluationModelId=()=>selected;
  window.evaluationModelLabel=()=>select?.selectedOptions?.[0]?.textContent||selected;
  const describe=()=>{if(hint)hint.textContent=selected.startsWith('qwen')?'当前使用千问。视频按画面分析，声音及节奏正确性需另行核实。切换只影响后续请求，已有结果保留。':'当前使用 MiniMax M3。已有结果保留，后续请求使用当前选择。'};
  window.updateEvaluationModelControl=()=>{if(select)select.disabled=pending>0||Boolean(window.evaluationAnalysisRunning?.())};
  select?.addEventListener('change',()=>{
    if(pending||window.evaluationModelLocked?.()){select.value=selected;if(hint)hint.textContent='当前处理尚未结束，完成或暂停后再切换模型。';return}
    selected=allowed.includes(select.value)?select.value:'qwen3.8-max';
    try{localStorage.setItem(storageKey,selected)}catch{}
    describe();
  });
  window.addEventListener('storage',event=>{if(event.key===storageKey&&allowed.includes(event.newValue)&&!pending&&!window.evaluationModelLocked?.()){selected=event.newValue;if(select)select.value=selected;describe()}});
  window.evaluationFetch=async(input,options={})=>{
    const target=new URL(typeof input==='string'?input:input.url,location.href);
    if(target.origin!==location.origin||!target.pathname.startsWith('/api/')||target.pathname.startsWith('/api/diagnostics/'))return window.fetch(input,options);
    const headers=new Headers(options.headers||((typeof input!=='string'&&input.headers)||undefined));headers.set('x-evaluation-model',selected);
    const diagnosticId=headers.get('x-diagnostic-id')||uuid();headers.set('x-diagnostic-id',diagnosticId);if(globalThis.evaluationRunId)headers.set('x-analysis-run-id',globalThis.evaluationRunId);
    const started=Date.now();
    pending++;window.updateEvaluationModelControl();
    try{
      const response=await window.fetch(input,{...options,headers});
      const event={diagnostic_id:response.headers.get('x-diagnostic-id')||diagnosticId,status:response.ok?'complete':'failed',api_path:target.pathname,model:selected,http_status:response.status,elapsed_ms:Date.now()-started};
      if(!response.ok&&String(response.headers.get('content-type')).includes('application/json'))response.clone().json().then(data=>window.evaluationDiagnostics?.record('api_request',{...event,message:data.failure_detail?.provider_message||data.error||'请求失败'})).catch(()=>window.evaluationDiagnostics?.record('api_request',event));
      else window.evaluationDiagnostics?.record('api_request',event);
      return response;
    }catch(error){window.evaluationDiagnostics?.record('api_request',{diagnostic_id:diagnosticId,status:'failed',api_path:target.pathname,model:selected,elapsed_ms:Date.now()-started,message:error.message});throw error}
    finally{pending--;window.updateEvaluationModelControl()}
  };
  describe();
})();
