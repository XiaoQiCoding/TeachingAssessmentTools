import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import ffmpeg from 'ffmpeg-static';

const execute=promisify(execFile),validId=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const problem=(message,status=400,code='INVALID_VIDEO_SOURCE')=>Object.assign(new Error(message),{local_status:status,code});

// Only opaque identifiers cross the HTTP boundary; uploaded paths are never accepted.
export function createVideoSourceService({directory=path.join(os.tmpdir(),'teaching-video-sources'),maxBytes=512*1024*1024,maxStoredBytes=2*1024*1024*1024,ttlMs=6*60*60*1000,now=Date.now}={}){
  const root=path.resolve(directory),sources=new Map();let uploading=false,slicing=0;
  const sourceDir=id=>{if(!validId.test(id))throw problem('视频编号无效');return path.join(root,id)};
  async function remove(id){
    const target=sourceDir(id);
    if(path.dirname(path.resolve(target))!==root)throw new Error('Unsafe video cleanup path');
    await fs.rm(target,{recursive:true,force:true});sources.delete(id);
  }
  async function cleanup(){
    await fs.mkdir(root,{recursive:true,mode:0o700});
    for(const item of await fs.readdir(root,{withFileTypes:true})){
      if(!item.isDirectory()||!validId.test(item.name))continue;
      const entry=sources.get(item.name);if(entry?.busy)continue;
      const stat=await fs.stat(sourceDir(item.name));
      if(now()-(entry?.touched??stat.mtimeMs)>ttlMs)await remove(item.name);
    }
  }
  const timer=setInterval(()=>void cleanup().catch(()=>{}),60000);timer.unref();
  async function probe(file){
    let output='';
    try{const result=await execute(process.env.FFMPEG_PATH||ffmpeg,['-hide_banner','-nostdin','-i',file],{windowsHide:true,timeout:20000,maxBuffer:1024*1024});output=result.stderr}
    catch(error){if(error.code==='ENOENT')throw problem('服务器未找到视频处理工具，请检查 FFMPEG_PATH 配置。',503,'FFMPEG_UNAVAILABLE');output=error.stderr||''}
    const match=output.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
    const duration=match?Number(match[1])*3600+Number(match[2])*60+Number(match[3]):0;
    if(!duration||!output.includes('Video:'))throw problem('无法读取视频时长或画面，请检查原视频是否完整。',422);
    return {duration_seconds:duration,has_audio:output.includes('Audio:')};
  }
  async function handle(req,res,url,{log=()=>{},diagnostic_id=null}={}){
    if(url.pathname!=='/api/classroom/video-source')return false;
    const send=(status,data)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify({diagnostic_id,...data}))};
    if(req.method!=='POST'){send(405,{error:'请上传原视频'});return true}
    if(uploading){send(429,{error:'另一个原视频正在上传，请稍后重试。',retryable:true});return true}
    if(Number(req.headers['content-length'])>maxBytes){send(413,{error:'原视频超过512MB，请压缩后重试。'});return true}
    uploading=true;let id=null,bytes=0;const started=now();
    try{
      await cleanup();let stored=0;
      for(const item of await fs.readdir(root,{withFileTypes:true}))if(item.isDirectory()&&validId.test(item.name)){try{stored+=(await fs.stat(path.join(sourceDir(item.name),'source.media'))).size}catch{}}
      const allowance=Math.min(maxBytes,maxStoredBytes-stored);
      if(allowance<=0||Number(req.headers['content-length'])>allowance)throw problem('临时视频空间不足，请稍后重试。',507,'VIDEO_STORAGE_FULL');
      id=randomUUID();const dir=sourceDir(id);await fs.mkdir(dir,{mode:0o700});
      const file=path.join(dir,'source.media'),handle=await fs.open(file,'wx',0o600);
      try{for await(const chunk of req){bytes+=chunk.length;if(bytes>allowance)throw problem('视频超过上传或临时存储限制。',413);await handle.writeFile(chunk)}}finally{await handle.close()}
      if(!bytes)throw problem('没有收到视频内容');
      const metadata=await probe(file),entry={file,bytes,...metadata,touched:now(),busy:0};sources.set(id,entry);
      await fs.utimes(dir,new Date(now()),new Date(now()));
      void log({event:'stage_complete',stage:'source_upload',elapsed_ms:now()-started,bytes,duration_seconds:metadata.duration_seconds,source_id:id});
      send(201,{source_id:id,bytes,...metadata,expires_after_seconds:ttlMs/1000});
    }catch(error){
      if(id)await remove(id).catch(()=>{});
      const message=error.local_status?error.message:'原视频上传或读取失败，请重试。';
      void log({event:'stage_failed',stage:'source_upload',elapsed_ms:now()-started,bytes,message,error_type:error.name});
      if(!res.destroyed)send(error.local_status||500,{error:message,failure_detail:{diagnostic_id,stage:'source_upload',code:error.code||'UPLOAD_FAILED',message}});
    }finally{uploading=false}
    return true;
  }
  async function prepareClip(id,start,duration,{signal}={}){
    signal?.throwIfAborted();
    if(!validId.test(String(id)))throw problem('视频编号无效');
    const entry=sources.get(id);
    if(!entry||now()-entry.touched>ttlMs)throw problem('服务器上的临时视频已过期或服务已重启，请重试以重新上传原视频。',410,'VIDEO_SOURCE_EXPIRED');
    if(!Number.isFinite(start)||!Number.isFinite(duration)||start<0||duration<=0||duration>60||start+duration>entry.duration_seconds+0.1)throw problem('切片时间超出原视频，单片段最多60秒。');
    if(slicing>=2)throw problem('视频切片任务较多，请稍后重试。',429,'VIDEO_SLICE_BUSY');
    slicing++;entry.busy++;entry.touched=now();
    const dir=sourceDir(id),output=path.join(dir,`clip-${randomUUID()}.mp4`);
    try{
      await fs.utimes(dir,new Date(now()),new Date(now()));
      // Seek before decoding; no real-time playback and no browser re-recording.
      await execute(process.env.FFMPEG_PATH||ffmpeg,['-hide_banner','-loglevel','error','-nostdin','-ss',String(start),'-i',entry.file,'-t',String(duration),'-map','0:v:0','-map','0:a:0?','-vf','scale=w=min(1280\\,iw):h=min(720\\,ih):force_original_aspect_ratio=decrease:force_divisible_by=2','-c:v','libx264','-preset','veryfast','-crf','24','-maxrate','800k','-bufsize','1600k','-threads','2','-pix_fmt','yuv420p','-c:a','aac','-b:a','64k','-movflags','+faststart',output],{windowsHide:true,timeout:120000,maxBuffer:1024*1024,signal});
      const bytes=await fs.readFile(output);
      if(!bytes.length||bytes.length>20*1024*1024)throw problem('生成的片段为空或超过20MB，请缩短区间。',422);
      return new Blob([bytes],{type:'video/mp4'});
    }catch(error){if(signal?.aborted)throw problem('已停止服务器切片。',499,'VIDEO_SLICE_CANCELLED');if(error.local_status)throw error;throw problem('服务器切片失败，请检查视频格式或视频处理工具配置。',422,'VIDEO_SLICE_FAILED')}
    finally{await fs.unlink(output).catch(()=>{});entry.busy--;entry.touched=now();slicing--}
  }
  async function prepareScreen(id,start,duration,{signal}={}){
    signal?.throwIfAborted();sourceDir(id);
    const entry=sources.get(id);
    if(!entry||now()-entry.touched>ttlMs)throw problem('临时视频已过期，请重新上传。',410,'VIDEO_SOURCE_EXPIRED');
    if(!Number.isFinite(start)||!Number.isFinite(duration)||start<0||duration<=0||duration>120||start+duration>entry.duration_seconds+0.1)throw problem('初筛区间无效，最多120秒。');
    if(slicing>=2)throw problem('视频处理任务较多，请稍后继续。',429);
    slicing++;entry.busy++;entry.touched=now();
    let dir;
    try{
      dir=await fs.mkdtemp(path.join(sourceDir(id),'screen-'));
      await fs.utimes(sourceDir(id),new Date(now()),new Date(now()));
      await execute(process.env.FFMPEG_PATH||ffmpeg,['-hide_banner','-loglevel','error','-nostdin','-ss',String(start),'-i',entry.file,'-t',String(duration),'-vf','fps=fps=1/4:start_time=0:round=up,scale=w=min(640\\,iw):h=min(360\\,ih):force_original_aspect_ratio=decrease','-frames:v',String(Math.ceil(duration/4)),'-q:v','5','-threads','1',path.join(dir,'frame-%03d.jpg')],{windowsHide:true,timeout:120000,maxBuffer:1024*1024,signal});
      // Explicit timestamps: one still every four seconds. These are location clues only.
      const frames=[];
      for(let offset=0;offset<duration;offset+=4){
        signal?.throwIfAborted();
        const output=path.join(dir,`frame-${String(offset/4+1).padStart(3,'0')}.jpg`);
        frames.push({time_seconds:offset,blob:new Blob([await fs.readFile(output)],{type:'image/jpeg'})});
      }
      return frames;
    }finally{
      // mkdtemp always creates this direct child of the verified source directory.
      if(dir&&path.dirname(dir)===sourceDir(id))await fs.rm(dir,{recursive:true,force:true}).catch(()=>{});
      entry.busy--;entry.touched=now();slicing--;
    }
  }
  return {handle,prepareClip,prepareScreen,cleanup,close:()=>clearInterval(timer)};
}
