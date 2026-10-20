// Keep the actual File objects in browser storage, isolated by assessment record.
(() => {
  let database;
  const pending=new Set();
  function open(){
    if(!database)database=new Promise((resolve,reject)=>{
      const request=indexedDB.open('teaching-assessment-materials-v1',1);
      request.onupgradeneeded=()=>request.result.createObjectStore('materials',{keyPath:'id'});
      request.onsuccess=()=>resolve(request.result);
      request.onerror=()=>{database=null;reject(request.error)};
      request.onblocked=()=>{database=null;reject(new Error('浏览器材料存储暂时不可用'))};
    });
    return database;
  }
  async function read(recordId,slot){
    const db=await open();
    return new Promise((resolve,reject)=>{const request=db.transaction('materials').objectStore('materials').get(`${recordId}:${slot}`);request.onsuccess=()=>resolve(request.result?.files||[]);request.onerror=()=>reject(request.error)});
  }
  async function write(recordId,slot,files){
    const db=await open();
    return new Promise((resolve,reject)=>{const tx=db.transaction('materials','readwrite');tx.objectStore('materials').put({id:`${recordId}:${slot}`,files:Array.from(files),saved_at:Date.now()});tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error||new Error('材料保存未完成'))});
  }
  function track(operation){pending.add(operation);operation.finally(()=>pending.delete(operation)).catch(()=>{});return operation}
  async function bind({recordId,slot,input,status,accept=()=>true}){
    let restoring=false,revision=0;
    const names=files=>Array.from(files).map(file=>file.name).join('、');
    const message=text=>{if(status)status.textContent=text};
    input.addEventListener('change',()=>{
      if(restoring)return;
      revision++;
      const files=Array.from(input.files||[]);if(!files.length)return;
      message('正在保留已选材料，请稍候…');
      const currentRevision=revision;
      void track(write(recordId,slot,files)).then(()=>{if(revision===currentRevision)message('已保存在本浏览器：'+names(files))}).catch(()=>message('本浏览器未能保存材料；本次页签切换仍可使用，关闭或刷新后需重新选择。'));
    });
    const initialRevision=revision;
    try{
      const files=await read(recordId,slot);
      if(initialRevision!==revision||input.files?.length||!files.length)return;
      if(!accept(files)){message('已保存材料与当前结果的来源不一致，请选择评分时使用的原文件。');return;}
      const transfer=new DataTransfer();for(const file of files)transfer.items.add(file);
      restoring=true;input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));restoring=false;
      message('已恢复上次选择：'+names(files));
    }catch{restoring=false;message('本浏览器暂不能恢复材料，请重新选择原文件；评分记录已保留。')}
  }
  window.assessmentMaterials={bind,read,write,whenIdle:()=>Promise.allSettled([...pending])};
})();
