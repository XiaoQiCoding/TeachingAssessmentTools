// Local-only browser fixture. No real model calls or personal footage.
import http from 'node:http';
import {fileURLToPath} from 'node:url';
import fs from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import ffmpeg from 'ffmpeg-static';
import worker from '../dist/server/index.js';
import {normalizeVideo} from '../backend/normalize-video.mjs';
import {createDiagnostics,diagnosticId} from '../backend/diagnostics.mjs';
import {createVideoSourceService} from '../backend/video-source-service.mjs';
const dir=new URL('../../outputs/automatic-flow/',import.meta.url);await fs.mkdir(dir,{recursive:true});
execFileSync(ffmpeg,['-y','-f','lavfi','-i','testsrc2=size=320x180:rate=15','-f','lavfi','-i','sine=frequency=440:sample_rate=16000','-t','12','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac',fileURLToPath(new URL('test-class.mp4',dir))],{stdio:'ignore',windowsHide:true});
await fs.writeFile(new URL('lesson.txt',dir),'测试课程：听提示拍手。学生听到提示后拍手，允许手势提示。');
const diagnostics=createDiagnostics({directory:fileURLToPath(new URL('logs/',dir)),secrets:['fixture']});
const videoSources=createVideoSourceService();
const metrics={plan:0,transcript:0,locate:0,clips:0,reports:0};
const tasks=[{task:'听提示拍手',success_criteria:'听到提示后拍手',allowed_assistance:'允许手势提示',basis:'测试教案'}];
globalThis.fetch=async(url,options)=>{
  const requestBody=JSON.parse(options.body);const hasMedia=Array.isArray(requestBody.messages?.at(-1)?.content)&&requestBody.messages.at(-1).content.some(c=>['video_url','image_url'].includes(c.type));
  if(String(url).includes('anthropic')||hasMedia){
    metrics.clips++;
    if(process.argv.includes('--diagnostic-failure'))return Response.json({error:{code:'InvalidParameter',message:'模拟诊断验证：视频参数不符合要求（不是实际千问故障）'}},{status:400,headers:{'x-request-id':'fixture-upstream-400'}});
    if(metrics.clips===2)return new Response(JSON.stringify({error:{message:'模拟单个片段失败，可重试'}}),{status:503});
    const data={summary:'测试片段已分析',candidates:[{start_seconds:0.2,end_seconds:3,phase:'tool_use',type:'response',student_id:'S01',outcome:'positive',assistance:'gesture',confidence:'medium',task:'听提示拍手',expected_response:'听到提示后拍手',actual_response:'学生在手势提示后拍手',note:'测试候选：学生在提示后拍手',completion_quality:'achieved',assistance_matches_goal:'allowed'}]};
    return Response.json(hasMedia?{choices:[{message:{content:JSON.stringify(data)},finish_reason:'stop'}]}:{content:[{type:'text',text:JSON.stringify(data)}]});
  }
  metrics.plan++;
  return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({lesson:'自动流程测试课',goals:['听提示拍手'],steps:['听提示','拍手'],instructions:['请拍手'],expected_responses:['拍手'],generalization_tasks:[],observation_tasks:tasks})}}]}));
};
const server=http.createServer(async(req,res)=>{
  try{
    const url=new URL(req.url,'http://127.0.0.1:4175');
    if(await diagnostics.handle(req,res,url))return;
    const id=diagnosticId(req.headers['x-diagnostic-id']),log=event=>diagnostics.write({diagnostic_id:id,...event});res.setHeader('x-diagnostic-id',id);
    if(await videoSources.handle(req,res,url,{log,diagnostic_id:id}))return;
    if(url.pathname==='/__test/metrics'){res.setHeader('content-type','application/json');res.end(JSON.stringify(metrics));return}
    const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=chunks.length?Buffer.concat(chunks):undefined;
    let response;
    if(url.pathname==='/api/classroom/transcription'&&req.method==='POST'){metrics.transcript++;response=Response.json({job_id:'fixture'})}
    else if(url.pathname==='/api/classroom/transcription/fixture')response=Response.json({status:'complete',duration_seconds:12,source:'test',segments:[{id:'S1',start_seconds:0,end_seconds:3,text:'请拍手'}]});
    else if(url.pathname==='/api/classroom/locate-transcript'){metrics.locate++;response=Response.json({windows:[0,4,8].map((a,i)=>({id:`W${i}`,task:'听提示拍手',start_seconds:a,end_seconds:a+4,reason:'测试定位',transcript:[],status:'pending'}))})}
    else {if(url.pathname==='/api/classroom/report')metrics.reports++;response=await worker.fetch(new Request(url,{method:req.method,headers:req.headers,body}),{MINIMAX_API_KEY:'fixture',QWEN_API_KEY:'fixture',DEFAULT_AI_MODEL:'qwen3.8-flash',NORMALIZE_VIDEO:normalizeVideo,PREPARE_VIDEO_CLIP:(...args)=>videoSources.prepareClip(...args),DIAGNOSTIC_ID:id,DIAGNOSTICS_LOG:log,DIAGNOSTICS_TIMINGS:{}})}
    res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
  }catch(error){res.writeHead(500);res.end(error.message)}
});
server.listen(4175,'127.0.0.1',()=>console.log('Browser fixture ready: http://127.0.0.1:4175/classroom?record=AUTOMATIC-TEST'));
