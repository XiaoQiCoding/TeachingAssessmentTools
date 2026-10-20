(() => {
  let record=new URL(location.href).searchParams.get('record');
  if(!record)try{record=localStorage.getItem('teaching-evaluation-active-record-v1')}catch{}
  record=record||'standalone';
  const key='evaluation-diagnostics-v1-'+record;
  let entries=[],queued=[],sending=false,timer=null;
  try{const saved=JSON.parse(localStorage.getItem(key)||'[]');if(Array.isArray(saved))entries=saved.slice(-300)}catch{}
  const fields=['diagnostic_id','run_id','stage','status','elapsed_ms','upload_ms','capture_ms','request_ms','slice_ms','model','window_id','start_seconds','end_seconds','bytes','message','api_path','http_status','client_timestamp'];
  function clean(value){return String(value||'').replace(/Bearer\s+\S+/gi,'Bearer [REDACTED]').replace(/sk-[\w-]{12,}/g,'[KEY REDACTED]').replace(/data:[^,\s]+,[A-Za-z0-9+/=]+/g,'[MEDIA REDACTED]').slice(0,1400)}
  async function flush(){
    if(sending||!queued.length)return;sending=true;const batch=queued.splice(0,5);
    try{
      const response=await window.fetch('/api/diagnostics/events',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({events:batch}),keepalive:true});
      const status=document.querySelector('#diagnosticSaveState');if(status)status.textContent=response.ok?'诊断记录已提交服务器日志。':'服务器日志暂不可用，本页仍保留诊断记录，可下载。';
    }catch{const status=document.querySelector('#diagnosticSaveState');if(status)status.textContent='网络暂不可用，本页保留诊断记录，可下载。'}
    finally{sending=false;if(queued.length)timer=setTimeout(flush,500)}
  }
  function add(stage,data={}){
    const event={diagnostic_id:data.diagnostic_id||crypto.randomUUID(),run_id:globalThis.evaluationRunId||'',stage,client_timestamp:new Date().toISOString(),...Object.fromEntries(fields.filter(k=>Object.hasOwn(data,k)).map(k=>[k,typeof data[k]==='string'?clean(data[k]):data[k]]))};
    entries.push(event);entries=entries.slice(-300);queued.push(event);queued=queued.slice(-100);
    try{localStorage.setItem(key,JSON.stringify(entries))}catch{}
    if(event.status==='failed'){const box=document.querySelector('#diagnosticLastError');if(box)box.textContent=`最近失败：${event.message||'详见对应步骤'}；诊断编号：${event.diagnostic_id}`}
    clearTimeout(timer);timer=setTimeout(flush,300);return event;
  }
  function download(data,name){const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'})),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)}
  document.querySelector('#downloadDiagnostics')?.addEventListener('click',()=>download({exported_at:new Date().toISOString(),scope:'本页步骤诊断，服务器日志另按诊断编号查询',entries},'课堂分析诊断.json'));
  window.evaluationDiagnostics={record:add,download,flush};
})();
