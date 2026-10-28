import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const MAX_VIDEO_BYTES=1.5*1024**3;
export const MAX_STORED_VIDEO_BYTES=15*1024**3;
export const storageProblem=()=>Object.assign(new Error('服务器临时视频空间不足，无法上传此视频。请稍后重试，或使用更小的视频。'),{local_status:507,code:'VIDEO_STORAGE_FULL'});

// Reserve space before reading a request, including concurrent transcription uploads.
export function createVideoStorage({directory=path.join(os.tmpdir(),'teaching-video-sources'),maxStoredBytes=MAX_STORED_VIDEO_BYTES,statfs=dir=>fs.statfs(dir)}={}){
  const root=path.resolve(directory),reservations=new Map();let queue=Promise.resolve();
  const locked=work=>{const result=queue.then(work);queue=result.catch(()=>{});return result};
  async function bytesIn(dir){
    let total=0;
    let entries;try{entries=await fs.readdir(dir,{withFileTypes:true})}catch(error){if(error.code==='ENOENT')return 0;throw error}
    for(const item of entries){
      const file=path.join(dir,item.name);
      if(item.isDirectory())total+=await bytesIn(file);
      else if(item.isFile()){try{total+=(await fs.stat(file)).size}catch(error){if(error.code!=='ENOENT')throw error}}
    }
    return total;
  }
  async function inspect(){
    await fs.mkdir(root,{recursive:true,mode:0o700});
    const stored=await bytesIn(root);let reserved=0;
    for(const [dir,bytes] of reservations)reserved+=Math.max(0,bytes-await bytesIn(dir));
    const disk=await statfs(root),diskFree=Number(disk.bavail)*Number(disk.bsize);
    // Count written files and only the unwritten portion of concurrent uploads.
    return {max_stored_bytes:maxStoredBytes,used_bytes:stored+reserved,available_bytes:Math.max(0,Math.min(maxStoredBytes-stored-reserved,diskFree-reserved))};
  }
  return {
    directory:root,
    isReserved:dir=>reservations.has(path.resolve(dir)),
    capacity:()=>locked(inspect),
    reserve:(dir,bytes)=>locked(async()=>{
      const target=path.resolve(dir);
      if(path.dirname(target)!==root||reservations.has(target))throw new Error('Invalid video storage reservation');
      const capacity=await inspect();if(bytes>capacity.available_bytes)throw storageProblem();
      reservations.set(target,bytes);
      return ()=>reservations.delete(target);
    })
  };
}
