import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

export const diagnosticId=value=>/^[a-f0-9]{8}-[a-f0-9-]{27}$/i.test(String(value||''))?String(value):randomUUID();
export function redactDiagnostics(value,secrets=[]){
  if(typeof value==='string'){
    let text=value;
    for(const secret of secrets.filter(Boolean))text=text.split(secret).join('[REDACTED]');
    return text.replace(/Bearer\s+\S+/gi,'Bearer [REDACTED]').replace(/data:[^,\s]+,[A-Za-z0-9+/=]+/g,'[MEDIA REDACTED]').replace(/sk-[\w-]{12,}/g,'[KEY REDACTED]').replace(/[A-Za-z0-9+/=_-]{100,}/g,'[LONG VALUE REDACTED]').slice(0,1600);
  }
  if(Array.isArray(value))return value.slice(0,100).map(v=>redactDiagnostics(v,secrets));
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([k])=>!['authorization','api_key','key','body','prompt','messages','content','base64','video','image'].includes(k.toLowerCase())).map(([k,v])=>[k,redactDiagnostics(v,secrets)]));
  return value;
}
export function createDiagnostics({directory,secrets=[],maxBytes=5*1024*1024,maxFiles=20}={}){
  const root=path.resolve(directory),filePattern=/^evaluation-\d{4}-\d{2}-\d{2}-\d+\.jsonl$/;
  let queue=Promise.resolve(),storageError=null,clientMinute=0,clientEvents=0;
  async function append(entry){
    await fs.mkdir(root,{recursive:true});
    const date=new Date().toISOString().slice(0,10);
    const names=(await fs.readdir(root)).filter(n=>filePattern.test(n)).sort();
    let index=Number(names.filter(n=>n.startsWith(`evaluation-${date}-`)).at(-1)?.match(/-(\d+)\.jsonl$/)?.[1]||0);
    let file=path.join(root,`evaluation-${date}-${String(index).padStart(4,'0')}.jsonl`);
    const line=JSON.stringify(entry)+'\n';
    try{if((await fs.stat(file)).size+Buffer.byteLength(line)>maxBytes)file=path.join(root,`evaluation-${date}-${String(++index).padStart(4,'0')}.jsonl`)}catch(e){if(e.code!=='ENOENT')throw e}
    await fs.appendFile(file,line,'utf8');
    const remaining=[...new Set([...names,path.basename(file)])].sort();
    for(const name of remaining.slice(0,Math.max(0,remaining.length-maxFiles)))await fs.unlink(path.join(root,name));
  }
  function write(entry){
    const safe=redactDiagnostics({timestamp:new Date().toISOString(),...entry},secrets);
    queue=queue.then(()=>append(safe)).catch(error=>{storageError=error.code||error.name;console.error(JSON.stringify({event:'diagnostics_storage_error',code:storageError}))});
    return queue;
  }
  async function read(id){
    if(diagnosticId(id)!==id)return null;
    await queue;
    let names;try{names=(await fs.readdir(root)).filter(n=>filePattern.test(n)).sort().reverse()}catch{return []}
    const entries=[];
    for(const name of names){
      for(const line of (await fs.readFile(path.join(root,name),'utf8')).split('\n')){
        try{const item=JSON.parse(line);if(item.diagnostic_id===id)entries.push(item)}catch{}
      }
      if(entries.length>=300)break;
    }
    return entries.slice(-300).sort((a,b)=>a.timestamp.localeCompare(b.timestamp));
  }
  async function handle(incoming,outgoing,url){
    if(!url.pathname.startsWith('/api/diagnostics/'))return false;
    const respond=(status,data)=>{outgoing.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});outgoing.end(JSON.stringify(data))};
    if(incoming.method==='POST'&&url.pathname==='/api/diagnostics/events'){
      let size=0,chunks=[];
      for await(const chunk of incoming){size+=chunk.length;if(size>16384){respond(413,{error:'诊断事件过大'});return true}chunks.push(chunk)}
      let data;try{data=JSON.parse(Buffer.concat(chunks).toString('utf8'))}catch{respond(400,{error:'诊断事件格式无效'});return true}
      if(!Array.isArray(data.events)||data.events.length>20){respond(400,{error:'诊断事件数量无效'});return true}
      const minute=Math.floor(Date.now()/60000);if(minute!==clientMinute){clientMinute=minute;clientEvents=0}
      if(clientEvents+data.events.length>600){respond(429,{error:'诊断事件过于频繁，本页记录仍可下载'});return true}clientEvents+=data.events.length;
      const fields=['diagnostic_id','run_id','stage','status','elapsed_ms','upload_ms','capture_ms','request_ms','slice_ms','model','window_id','start_seconds','end_seconds','bytes','message','api_path','http_status','client_timestamp'];
      for(const event of data.events){
        if(!event||!['source_upload','capture','clip_analysis','api_request','workflow'].includes(event.stage))continue;
        const row=Object.fromEntries(fields.filter(k=>Object.hasOwn(event,k)).map(k=>[k,event[k]]));
        row.diagnostic_id=diagnosticId(row.diagnostic_id);row.event='client_stage';row.source='browser';
        void write(row);
      }
      respond(202,{accepted:true});return true;
    }
    if(incoming.method==='GET'){
      const id=url.pathname.slice('/api/diagnostics/'.length),entries=await read(id);
      if(!entries){respond(400,{error:'诊断编号无效'});return true}
      respond(200,{diagnostic_id:id,entries,storage_error:storageError});return true;
    }
    respond(405,{error:'不支持的诊断操作'});return true;
  }
  return {write,read,handle,flush:()=>queue,status:()=>({storage_error:storageError})};
}
