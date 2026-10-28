import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Readable} from 'node:stream';
import {createVideoStorage,MAX_VIDEO_BYTES,MAX_STORED_VIDEO_BYTES} from '../backend/video-storage.mjs';
import {createVideoSourceService} from '../backend/video-source-service.mjs';
import {createTranscriptionService} from '../backend/transcription-service.mjs';

assert.equal(MAX_VIDEO_BYTES,1610612736);
assert.equal(MAX_STORED_VIDEO_BYTES,16106127360);
const directory=await fs.mkdtemp(path.join(os.tmpdir(),'video-storage-test-'));
const disk={bavail:100*1024**3,bsize:1};
const storage=createVideoStorage({directory,statfs:async()=>disk});
const sources=createVideoSourceService({directory,storage});
async function request(handler,url,{method='GET',size}={}){
  let consumed=false;
  const req=Readable.from((async function*(){consumed=true;yield Buffer.from('x')})());
  req.method=method;req.headers=size===undefined?{}:{'content-length':String(size)};
  const res={writeHead(status){this.status=status},end(body){this.data=JSON.parse(body)}};
  await handler(req,res,new URL(url,'http://test'));
  return {...res,consumed};
}
try{
  const handle=(...args)=>sources.handle(...args);
  let result=await request(handle,`/api/classroom/video-source?bytes=${MAX_VIDEO_BYTES}`);
  assert.equal(result.status,200,'Exactly 1.5GB is allowed');
  assert.equal(result.data.max_stored_bytes,MAX_STORED_VIDEO_BYTES);
  result=await request(handle,`/api/classroom/video-source?bytes=${MAX_VIDEO_BYTES+1}`);
  assert.equal(result.status,413);
  result=await request(handle,'/api/classroom/video-source',{method:'POST',size:MAX_VIDEO_BYTES+1});
  assert.equal(result.status,413);assert.equal(result.consumed,false);

  const release=await storage.reserve(path.join(directory,'transcript-active'),MAX_STORED_VIDEO_BYTES-100);
  result=await request(handle,'/api/classroom/video-source?bytes=101');
  assert.equal(result.status,507);assert.match(result.data.error,/空间不足/);
  result=await request(handle,'/api/classroom/video-source',{method:'POST',size:101});
  assert.equal(result.status,507);assert.equal(result.consumed,false,'Reject before reading the video');
  const transcribe=createTranscriptionService({MINIMAX_API_KEY:'fixture'},{storage});
  result=await request(transcribe,'/api/classroom/transcription',{method:'POST',size:MAX_VIDEO_BYTES+1});
  assert.equal(result.status,413);assert.equal(result.consumed,false);
  const req={method:'POST',headers:{'content-length':'101','x-video-duration':'60'}};
  const res={writeHead(status){this.status=status},end(body){this.data=JSON.parse(body)}};
  await transcribe(req,res,new URL('http://test/api/classroom/transcription'));
  assert.equal(res.status,507,'Transcription shares the same quota');
  release();
  assert.equal((await storage.capacity()).available_bytes,MAX_STORED_VIDEO_BYTES,'Failed reservations are released');

  disk.bavail=50;
  result=await request(handle,'/api/classroom/video-source?bytes=51');
  assert.equal(result.status,507,'Actual disk space also limits uploads');
  disk.bavail=100*1024**3;
  const small=createVideoStorage({directory,maxStoredBytes:100,statfs:async()=>disk});
  const reservations=await Promise.allSettled([small.reserve(path.join(directory,'a'),60),small.reserve(path.join(directory,'b'),60)]);
  assert.deepEqual(reservations.map(r=>r.status),['fulfilled','rejected'],'Concurrent uploads cannot overbook capacity');
  reservations[0].value();
  await fs.writeFile(path.join(directory,'existing.media'),Buffer.alloc(40));
  assert.equal((await small.capacity()).available_bytes,60,'Existing temporary files count toward the quota');
}finally{
  sources.close();
  if(path.dirname(directory)!==path.resolve(os.tmpdir())||!path.basename(directory).startsWith('video-storage-test-'))throw new Error('Unsafe test cleanup');
  await fs.rm(directory,{recursive:true,force:true});
}

// The browser must stop before posting a video when preflight reports insufficient space.
const html=await fs.readFile(new URL('../frontend/classroom.html',import.meta.url),'utf8');
const code=html.slice(html.indexOf('  let serverVideoSource=null;'),html.indexOf("  $('#cancelClip').onclick"));
let posts=0;const uploadControl={files:[{size:200}]};
const ensure=new Function('$','fetch','window',`let videoIdentity='test';${code};return ensureServerVideoSource`)(
  selector=>selector==='#videoFile'?uploadControl:{textContent:''},
  async(_url,options)=>{if(options.method==='POST')posts++;return Response.json({error:'服务器临时视频空间不足，请稍后重试。'},{status:507})},
  {evaluationVideoFingerprint:async()=> 'a'.repeat(64)}
);
await assert.rejects(ensure(new AbortController().signal,'fixture'),error=>error.fatal&&/空间不足/.test(error.message));
assert.equal(posts,0);
const queueCode=html.slice(html.indexOf('  async function runWindowQueue('),html.indexOf('  function coverageSeconds('));
const runQueue=new Function(`${queueCode};return runWindowQueue`)();
await assert.rejects(runQueue([{status:'pending'}],async()=>{throw Object.assign(new Error('服务器临时视频空间不足'),{http_status:507,fatal:true})},new AbortController().signal,()=>{}),/空间不足/,'Capacity errors reach the main status message');
console.log('Video storage: 1.5GB boundary, shared 15GB quota, disk capacity, concurrent reservations and upload preflight passed');
