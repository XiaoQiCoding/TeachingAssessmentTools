import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import ffmpegStatic from 'ffmpeg-static';

export function normalizeASR(payload, offset, length) {
  if (!Array.isArray(payload?.segments)) throw new Error('语音服务未返回带时间的句子，不能用估算时间代替。');
  return payload.segments.map(segment => {
    const start=Number(segment.start), end=Number(segment.end);
    if (!Number.isFinite(start)||!Number.isFinite(end)||start<0||start>=length||end<=start||end>length+1) throw new Error('语音服务返回了无效时间范围。');
    return {start_seconds:offset+start,end_seconds:offset+Math.min(end,length),text:String(segment.text||'').trim(),speaker:String(segment.speaker||'未区分')};
  }).filter(segment=>segment.text);
}

export function createTranscriptionService(env, {fetcher=fetch, ffmpeg=process.env.FFMPEG_PATH||ffmpegStatic, ttl=30*60*1000}={}) {
  const jobs=new Map();
  const respond=(response,status,data)=>{response.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});response.end(JSON.stringify(data));};
  async function cleanup(job){if(job.dir){const dir=path.resolve(job.dir);if(path.dirname(dir)!==path.resolve(os.tmpdir())||!path.basename(dir).startsWith('teaching-transcript-'))throw new Error('临时目录校验失败');job.dir=null;await fs.rm(dir,{recursive:true,force:true}).catch(()=>{});}}
  async function run(job) {
    try {
      job.status='extracting';job.message='正在提取音轨并按7分钟分段。';
      await new Promise((resolve,reject)=>{
        const child=spawn(ffmpeg,['-hide_banner','-loglevel','error','-nostdin','-i',path.join(job.dir,'source.media'),'-map','0:a:0','-vn','-af','aresample=async=1:first_pts=0','-ar','16000','-ac','1','-c:a','pcm_s16le','-f','segment','-segment_time','420','-reset_timestamps','1',path.join(job.dir,'audio-%04d.wav')],{windowsHide:true});
        job.child=child;const timeout=setTimeout(()=>{child.kill();reject(new Error('提取音轨超时。'));},10*60*1000);
        child.on('error',()=>{clearTimeout(timeout);reject(new Error('视频处理组件不可用，请配置 FFmpeg 或导入字幕。'));});
        child.on('exit',code=>{clearTimeout(timeout);job.child=null;code===0?resolve():reject(new Error('无法读取音轨，可能视频没有声音或格式不支持；可导入字幕或人工检查。'));});
      });
      const files=(await fs.readdir(job.dir)).filter(name=>/^audio-\d+\.wav$/.test(name)).sort();
      job.total=files.length;job.segments=[];
      if(!files.length)throw new Error('没有可转写的音轨。');
      for(let index=0;index<files.length;index++){
        if(job.cancelled)throw new Error('已取消转写。');
        job.status='transcribing';job.message=`正在转写音轨 ${index+1}/${files.length}。`;job.completed=index;
        const body=new FormData();body.append('model',env.MINIMAX_ASR_MODEL||'asr-1.0');body.append('response_format','verbose_json');body.append('timestamp_level','sentence');
        body.append('file',new Blob([await fs.readFile(path.join(job.dir,files[index]))],{type:'audio/wav'}),files[index]);
        job.abort=new AbortController();const timeout=setTimeout(()=>job.abort.abort(),180000);
        let response,result;
        try{response=await fetcher(`${String(env.MINIMAX_API_BASE||'https://api.minimaxi.com/v1').replace(/\/$/,'')}/speech_to_text`,{method:'POST',headers:{Authorization:`Bearer ${env.MINIMAX_API_KEY}`},body,signal:job.abort.signal});result=await response.json().catch(()=>null);}finally{clearTimeout(timeout)}
        if(!response.ok||result?.base_resp?.status_code)throw new Error(`语音转写服务未完成（${response.status}）；请检查当前密钥是否有 ASR 权限，或导入带时间字幕。`);
        const offset=index*420,remaining=Math.max(0,job.duration-offset);
        job.segments.push(...normalizeASR(result,offset,Math.min(420,remaining)));
        job.completed=index+1;
      }
      if(job.cancelled)throw new Error('已取消转写。');
      job.segments=job.segments.map((segment,index)=>({...segment,id:`S${index+1}`}));
      job.status='complete';job.message=job.segments.length?'带时间文字稿已生成，请检查听不清或误识别的句子。':'音轨未识别出可用语句；不能据此推断课堂无活动。';
    }catch(error){job.status=job.cancelled?'cancelled':'failed';job.message=error.name==='AbortError'?'语音转写超时或已取消，可重试或导入字幕。':error.message;job.segments=[];}
    finally{await cleanup(job);job.finished=Date.now();}
  }
  return async function handle(incoming,outgoing,url){
    const root='/api/classroom/transcription';
    if(url.pathname!==root&&!url.pathname.startsWith(root+'/'))return false;
    for(const [id,job] of jobs)if(job.finished&&Date.now()-job.finished>ttl)jobs.delete(id);
    if(incoming.method==='POST'&&url.pathname===root){
      if(!env.MINIMAX_API_KEY){respond(outgoing,503,{error:'尚未配置 MiniMax 密钥。'});return true;}
      if([...jobs.values()].filter(job=>!job.finished).length>=2){respond(outgoing,429,{error:'已有视频正在转写，请稍后重试。'});return true;}
      const duration=Number(incoming.headers['x-video-duration']);
      if(!Number.isFinite(duration)||duration<=0||duration>14400){respond(outgoing,400,{error:'请提供有效视频时长（不超过4小时）。'});return true;}
      const job={id:randomUUID(),duration,status:'uploading',message:'正在接收视频。',completed:0,total:0,cancelled:false};jobs.set(job.id,job);
      try{
        job.dir=await fs.mkdtemp(path.join(os.tmpdir(),'teaching-transcript-'));
        let size=0;const cap=new Transform({transform(chunk,_encoding,callback){size+=chunk.length;callback(size>512*1024*1024?new Error('视频超过512MB，请压缩或导入字幕。'):null,chunk);}});
        await pipeline(incoming,cap,createWriteStream(path.join(job.dir,'source.media')));
        if(!size)throw new Error('视频为空。');
        respond(outgoing,202,{job_id:job.id});void run(job);
      }catch(error){job.status='failed';job.message=error.message;job.finished=Date.now();await cleanup(job);if(!outgoing.destroyed)respond(outgoing,400,{error:job.message});}
      return true;
    }
    const id=url.pathname.slice(root.length+1),job=jobs.get(id);
    if(!job){respond(outgoing,404,{error:'转写任务不存在或已过期，请重新开始。'});return true;}
    if(incoming.method==='DELETE'){
      job.cancelled=true;job.abort?.abort();job.child?.kill();respond(outgoing,200,{ok:true});return true;
    }
    if(incoming.method!=='GET'){respond(outgoing,405,{error:'不支持的请求。'});return true;}
    respond(outgoing,200,{job_id:id,status:job.status,message:job.message,completed:job.completed,total:job.total,segments:job.status==='complete'?job.segments:[],duration_seconds:job.duration,source:'minimax_asr',model:env.MINIMAX_ASR_MODEL||'asr-1.0'});return true;
  };
}
