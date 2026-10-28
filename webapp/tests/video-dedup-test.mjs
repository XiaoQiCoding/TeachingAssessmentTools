import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import http from 'node:http';
import {createHash,randomBytes} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import ffmpeg from 'ffmpeg-static';
import {createVideoSourceService} from '../backend/video-source-service.mjs';
import {createTranscriptionService} from '../backend/transcription-service.mjs';
import {createVideoStorage} from '../backend/video-storage.mjs';

const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
const script=await fs.readFile(new URL('../frontend/video-fingerprint.js',import.meta.url),'utf8');
const messages=[],context={Uint8Array,Uint32Array,DataView,postMessage:data=>messages.push(data)};
vm.createContext(context);vm.runInContext(script,context);
for(const size of [0,1,55,56,63,64,65,127,128,1000,1024*1024]){
  const bytes=randomBytes(size),hash=new context.VideoSha256();
  for(let offset=0;offset<size;offset+=37)hash.update(bytes.subarray(offset,offset+37));
  assert.equal(hash.hex(),sha256(bytes),`Incremental SHA-256 matches Node crypto for ${size} bytes`);
}
const multiChunk=randomBytes(4*1024*1024+123);
await context.onmessage({data:{file:new Blob([multiChunk])}});
assert.equal(messages.at(-1).sha256,sha256(multiChunk));
assert.equal(messages.filter(m=>'progress' in m).length,2,'Worker hashes the entire file in bounded chunks');

const directory=await fs.mkdtemp(path.join(os.tmpdir(),'video-dedup-test-'));
let sources,server,transcribe,clock=Date.now();
try{
  const file=path.join(directory,'sample.mp4');
  execFileSync(ffmpeg,['-y','-v','error','-f','lavfi','-i','color=size=16x16:rate=2','-f','lavfi','-i','sine=frequency=300:sample_rate=16000','-t','2','-c:v','libx264','-c:a','aac',file],{windowsHide:true,stdio:'ignore'});
  const bytes=await fs.readFile(file),digest=sha256(bytes),root=path.join(directory,'sources');
  let full=false;
  const storage=createVideoStorage({directory:root,statfs:async()=>({bavail:full?0:1024**3,bsize:1})});
  sources=createVideoSourceService({directory:root,storage,now:()=>clock,ttlMs:60000});
  server=http.createServer(async(req,res)=>{try{
    const url=new URL(req.url,'http://test');
    if(await sources.handle(req,res,url))return;
    if(transcribe&&await transcribe(req,res,url))return;
    res.writeHead(404);res.end();
  }catch(error){res.writeHead(500);res.end(JSON.stringify({error:error.message}));}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  const upload=hash=>fetch(base+'/api/classroom/video-source',{method:'POST',headers:{'content-type':'application/octet-stream','x-video-sha256':hash},body:bytes});
  const lookup=(hash=digest)=>fetch(`${base}/api/classroom/video-source?bytes=${bytes.length}&sha256=${hash}`);
  let response=await upload('a'.repeat(64));assert.equal(response.status,422,'Server verifies the actual bytes');
  assert.equal((await fs.readdir(root)).length,0,'Hash mismatch does not leave temporary videos');
  response=await upload(digest);assert.equal(response.status,201);
  const first=await response.json();assert.equal(first.sha256,digest);
  full=true;
  response=await lookup();assert.equal(response.status,200,'Existing content can be reused even if the disk is full');
  assert.equal((await response.json()).reusable_source.source_id,first.source_id);
  response=await lookup('b'.repeat(64));assert.equal(response.status,507,'Different content still needs free space');
  response=await upload(digest);assert.equal(response.status,200);assert.equal((await response.json()).source_id,first.source_id);
  assert.equal((await fs.readdir(root)).length,1,'Duplicate content occupies only one source directory');

  sources.close();sources=createVideoSourceService({directory:root,storage,now:()=>clock,ttlMs:60000});
  response=await lookup();assert.equal((await response.json()).reusable_source.source_id,first.source_id,'Verified metadata survives service restart');
  assert.ok((await sources.prepareClip(first.source_id,0,1)).size>0);
  full=false;
  let asrCalls=0;
  transcribe=createTranscriptionService({MINIMAX_API_KEY:'fixture'},{storage,acquireSource:sources.acquireSource,fetcher:async()=>{
    asrCalls++;return Response.json({segments:[{start:.1,end:.5,text:'测试'}]});
  }});
  response=await fetch(base+'/api/classroom/transcription',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({video_source_id:first.source_id})});
  assert.equal(response.status,202);const {job_id:job}=await response.json();
  let state;
  for(let attempt=0;attempt<100;attempt++){
    state=await (await fetch(`${base}/api/classroom/transcription/${job}`)).json();
    if(['complete','failed'].includes(state.status))break;
    await new Promise(resolve=>setTimeout(resolve,30));
  }
  assert.equal(state.status,'complete');assert.equal(asrCalls,1);
  assert.deepEqual(await fs.readdir(root),[first.source_id],'Transcription uses the original and deletes only its audio work directory');
  assert.ok((await sources.prepareClip(first.source_id,0,1)).size>0,'The shared source remains usable after transcription');
  clock+=61000;
  response=await lookup();assert.equal((await response.json()).reusable_source,undefined,'Expired files are not reused');
  assert.equal((await fs.readdir(root)).length,0);
}finally{
  sources?.close();if(server)await new Promise(resolve=>server.close(resolve));
  if(path.dirname(directory)!==path.resolve(os.tmpdir())||!path.basename(directory).startsWith('video-dedup-test-'))throw new Error('Unsafe test cleanup');
  await fs.rm(directory,{recursive:true,force:true});
}

const html=await fs.readFile(new URL('../frontend/classroom.html',import.meta.url),'utf8');
const code=html.slice(html.indexOf('  let serverVideoSource=null;'),html.indexOf("  $('#cancelClip').onclick"));
const file={name:'renamed-video.mp4',size:200},controls={files:[file]};let posts=0,gets=0;
const factory=new Function('$','fetch','window',`let videoIdentity='test';${code};return ensureServerVideoSource`);
const ensure=factory(selector=>selector==='#videoFile'?controls:{textContent:''},async(url,options)=>{
  if(options.method==='POST')posts++;else gets++;
  assert.match(url,/sha256=/);
  return Response.json({reusable_source:{source_id:'existing',bytes:200}});
},{evaluationVideoFingerprint:async()=> 'a'.repeat(64)});
assert.equal((await ensure(new AbortController().signal,'test')).source_id,'existing');
assert.equal(posts,0);assert.equal(gets,1);
console.log('Video deduplication: full-file SHA-256, bounded worker, server verification, rename-independent reuse, full storage, restart, expiry and transcription source reuse passed');
