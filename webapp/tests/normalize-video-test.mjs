import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import ffmpeg from 'ffmpeg-static';
import {normalizeVideo} from '../backend/normalize-video.mjs';
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'clip-test-'));
try {
 const source=path.join(dir,'source.webm');
 execFileSync(ffmpeg,['-f','lavfi','-i','testsrc2=size=160x90:rate=10','-f','lavfi','-i','sine=frequency=440','-t','1','-c:v','libvpx','-c:a','libopus',source],{stdio:'ignore',windowsHide:true});
 const converted=await normalizeVideo(new Blob([await fs.readFile(source)],{type:'video/webm'}));
 assert.equal(converted.type,'video/mp4');
 const output=path.join(dir,'converted.mp4');await fs.writeFile(output,Buffer.from(await converted.arrayBuffer()));
 execFileSync(ffmpeg,['-v','error','-i',output,'-map','0:v:0','-map','0:a:0','-f','null','-'],{stdio:'pipe',windowsHide:true});
 await assert.rejects(normalizeVideo(new Blob(['invalid video'])));
 console.log('WebM to MP4 conversion preserves readable video and audio; invalid input rejected');
}finally{await fs.rm(dir,{recursive:true,force:true})}
