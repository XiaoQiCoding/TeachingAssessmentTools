import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import ffmpeg from 'ffmpeg-static';
import {createVideoSourceService} from '../backend/video-source-service.mjs';
import worker from '../dist/server/index.js';

const dir=await fs.mkdtemp(path.join(os.tmpdir(),'video-source-test-')),events=[];
let clock=Date.now();
const sources=createVideoSourceService({directory:path.join(dir,'sources'),now:()=>clock,ttlMs:60000});
const server=http.createServer(async(req,res)=>{try{if(!await sources.handle(req,res,new URL(req.url,'http://test'),{log:e=>events.push(e)})){res.writeHead(404);res.end()}}catch(e){res.writeHead(500);res.end(e.message)}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${server.address().port}`,nativeFetch=globalThis.fetch;
const upload=async file=>{const response=await nativeFetch(base+'/api/classroom/video-source',{method:'POST',headers:{'content-type':'application/octet-stream'},body:createReadStream(file),duplex:'half'});return {status:response.status,data:await response.json()}};
const decode=(file,args)=>execFileSync(ffmpeg,['-v','error','-i',file,...args],{windowsHide:true,maxBuffer:1024*1024,stdio:['ignore','pipe','pipe']});
try{
 const sample=path.join(dir,'sample.mp4');
 execFileSync(ffmpeg,['-y','-f','lavfi','-i','color=c=red:size=160x90:rate=10:duration=1','-f','lavfi','-i','color=c=green:size=160x90:rate=10:duration=1','-f','lavfi','-i','sine=frequency=440:sample_rate=16000:duration=2','-filter_complex','[0:v][1:v]concat=n=2:v=1:a=0[v]','-map','[v]','-map','2:a','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac',sample],{windowsHide:true,stdio:'ignore'});
 const originalHash=createHash('sha256').update(await fs.readFile(sample)).digest('hex');
 const result=await upload(sample);assert.equal(result.status,201);const {source_id:id}=result.data;
 assert.equal(result.data.duration_seconds,2);assert.equal(result.data.has_audio,true);assert.ok(!JSON.stringify(result.data).includes(dir));
 const clip=await sources.prepareClip(id,1,1),output=path.join(dir,'out.mp4');await fs.writeFile(output,Buffer.from(await clip.arrayBuffer()));
 const pixel=decode(output,['-frames:v','1','-vf','scale=1:1','-f','rawvideo','-pix_fmt','rgb24','-']);assert.ok(pixel[1]>pixel[0]*3&&pixel[1]>pixel[2]*3,'The cut must start in green, not at the beginning of the source');
 decode(output,['-map','0:a:0','-f','null','-']);
 const second=await sources.prepareClip(id,0,.5);assert.ok(second.size>0,'Reuse the same original without uploading again');
 const stills=await sources.prepareScreen(id,1,1);assert.equal(stills.length,1);assert.equal(stills[0].time_seconds,0);
 const still=path.join(dir,'screen.jpg');await fs.writeFile(still,Buffer.from(await stills[0].blob.arrayBuffer()));
 const screenPixel=decode(still,['-frames:v','1','-vf','scale=1:1','-f','rawvideo','-pix_fmt','rgb24','-']);assert.ok(screenPixel[1]>screenPixel[0]*3,'Screening must seek to the requested region');
 assert.ok(!(await fs.readdir(path.join(dir,'sources',id))).some(n=>n.startsWith('screen-')),'Screening temporary frames are deleted');
 const tail=await sources.prepareScreen(id,1.9,.1);assert.equal(tail.length,1,'A very short final screening interval must still produce one frame');
 for(const args of [[id,-1,1],[id,0,121],[id,1,2],['../../secret',0,1]])await assert.rejects(sources.prepareScreen(...args));
 assert.equal(events.filter(e=>e.stage==='source_upload').length,1);
 assert.equal(createHash('sha256').update(await fs.readFile(sample)).digest('hex'),originalHash);
 for(const args of [[id,-1,1],[id,0,61],[id,1,2],['../../secret',0,1]])await assert.rejects(sources.prepareClip(...args));
 const stopped=new AbortController();stopped.abort();await assert.rejects(sources.prepareClip(id,0,1,{signal:stopped.signal}),error=>error.name==='AbortError');
 assert.equal((await upload(path.join(dir,'out.mp4'))).status,201);
 const invalid=path.join(dir,'invalid.bin');await fs.writeFile(invalid,'not a video');assert.equal((await upload(invalid)).status,422);

 // The application submits the server-produced clip directly, with absolute evidence offsets.
 const form=()=>{const f=new FormData();f.set('mode','video');f.set('video_source_id',id);f.set('clip_offset','1');f.set('duration','1');return f};
 const request=()=>new Request('http://test/api/classroom/video-candidates',{method:'POST',headers:{'x-evaluation-model':'qwen3.8-flash'},body:form()});
 let modelCalls=0;
 globalThis.fetch=async(_url,options)=>{modelCalls++;const body=JSON.parse(options.body);assert.ok(body.messages[0].content.some(c=>c.type==='video_url'&&c.video_url.url.startsWith('data:video/mp4;base64,')));return Response.json({choices:[{message:{content:JSON.stringify({summary:'fixture',candidates:[{start_seconds:.1,end_seconds:.5,note:'visible green'}]})}}]})};
 const env={QWEN_API_KEY:'fixture',PREPARE_VIDEO_CLIP:(...args)=>sources.prepareClip(...args),NORMALIZE_VIDEO:()=>{throw new Error('Do not transcode the server clip twice')}};
 let response=await worker.fetch(request(),env),data=await response.json();assert.equal(response.status,200);assert.equal(data.candidates[0].start_seconds,1.1);assert.equal(data.candidates[0].end_seconds,1.5);assert.ok(Number.isFinite(data.analysis.timings.slice_ms));assert.equal(modelCalls,1);
 clock+=61000;response=await worker.fetch(request(),env);data=await response.json();assert.equal(response.status,410);assert.equal(data.failure_detail.stage,'video_slice');assert.equal(data.failure_detail.code,'VIDEO_SOURCE_EXPIRED');assert.equal(modelCalls,1,'Expired source must not call the model');await sources.cleanup();assert.equal((await fs.readdir(path.join(dir,'sources'))).length,0);
 globalThis.fetch=nativeFetch;

 if(process.argv.includes('--real-case')){
   const source=path.resolve('../test/小青蛙找家上课视频.mp4'),stat=await fs.stat(source),started=Date.now();
   const uploaded=await upload(source);assert.equal(uploaded.status,201);
   const report={case:'小青蛙找家',original_bytes:stat.size,upload_ms:Date.now()-started,duration_seconds:uploaded.data.duration_seconds,cuts:[],model_called:false};
   const screenStarted=Date.now(),screenFrames=await sources.prepareScreen(uploaded.data.source_id,120,120);
   assert.equal(screenFrames.length,30);assert.equal(screenFrames.at(-1).time_seconds,116);
   report.screening={duration_seconds:120,frames:screenFrames.length,bytes:screenFrames.reduce((n,f)=>n+f.blob.size,0),elapsed_ms:Date.now()-screenStarted};
   const tailFrames=await sources.prepareScreen(uploaded.data.source_id,1680,uploaded.data.duration_seconds-1680);
   assert.ok(tailFrames.length>0&&tailFrames.length<=Math.ceil((uploaded.data.duration_seconds-1680)/4));
   assert.ok(tailFrames.every(f=>f.time_seconds<uploaded.data.duration_seconds-1680));
   report.tail_screening={frames:tailFrames.length,expected_max:Math.ceil((uploaded.data.duration_seconds-1680)/4),last_time_seconds:tailFrames.at(-1).time_seconds};
   for(const start of [0,1320]){
     const begin=Date.now(),blob=await sources.prepareClip(uploaded.data.source_id,start,60);const elapsed=Date.now()-begin;
     assert.ok(blob.size<7500000,'One-minute clip must fit Qwen inline payload limit');
     const cut=path.join(dir,'real.mp4');await fs.writeFile(cut,Buffer.from(await blob.arrayBuffer()));decode(cut,['-map','0:v:0','-map','0:a:0','-t','1','-f','null','-']);
     report.cuts.push({start_seconds:start,duration_seconds:60,slice_ms:elapsed,bytes:blob.size});
   }
   assert.equal((await fs.stat(source)).size,stat.size);assert.equal((await fs.stat(source)).mtimeMs,stat.mtimeMs);
   const out=path.resolve('../outputs/server-slicing');await fs.mkdir(out,{recursive:true});await fs.writeFile(path.join(out,'results.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
 }
 console.log('Server slicing: upload once, exact seek, audio, reuse, validation, expiry, no double transcode and absolute evidence offsets passed');
}finally{
 globalThis.fetch=nativeFetch;sources.close();await new Promise(resolve=>server.close(resolve));
 if(path.dirname(path.resolve(dir))!==path.resolve(os.tmpdir())||!path.basename(dir).startsWith('video-source-test-'))throw new Error('Unsafe test cleanup path');
 await fs.rm(dir,{recursive:true,force:true});
}

// Real browser upload helper: caching is by file object and current source identity.
const html=await fs.readFile(new URL('../frontend/classroom.html',import.meta.url),'utf8');
assert.ok(!html.includes('captureStream(')&&!html.includes('MediaRecorder('),'The primary analysis path must not re-record in the browser');
const code=html.slice(html.indexOf('  let serverVideoSource=null;'),html.indexOf("  $('#cancelClip').onclick"));
let currentFile={name:'a.mp4',size:100},calls=0,shouldFail=false;const uploadControls={files:[currentFile]};
const factory=new Function('$','fetch','window',`let videoIdentity='a';${code};return {ensure:ensureServerVideoSource,change:()=>{videoIdentity='b'},reset:()=>serverVideoSource=null}`);
const helper=factory(selector=>selector==='#videoFile'?uploadControls:{textContent:''},async(_url,options)=>{if(options.method==='GET')return Response.json({available_bytes:15*1024**3});calls++;if(shouldFail)throw new Error('network');return Response.json({source_id:'fixture',bytes:100})},{evaluationVideoFingerprint:async()=> 'a'.repeat(64)});
await helper.ensure(new AbortController().signal,'trace');await helper.ensure(new AbortController().signal,'trace');assert.equal(calls,1);
helper.change();currentFile={name:'b.mp4',size:200};uploadControls.files=[currentFile];await helper.ensure(new AbortController().signal,'trace');assert.equal(calls,2);
helper.reset();shouldFail=true;await assert.rejects(helper.ensure(new AbortController().signal,'trace'),/network/);shouldFail=false;await helper.ensure(new AbortController().signal,'trace');assert.equal(calls,4,'Upload failure must not poison the cache');
console.log('Browser source cache: upload reuse, changed-video isolation and failed-upload recovery passed');
