import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import ffmpeg from 'ffmpeg-static';

// Browser recordings can be WebM; the model accepts MP4. Keep audio when present.
export async function normalizeVideo(file) {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'teaching-clip-'));
  try {
    const input=path.join(dir,'source.media'),output=path.join(dir,'clip.mp4');
    await fs.writeFile(input,Buffer.from(await file.arrayBuffer()));
    await promisify(execFile)(process.env.FFMPEG_PATH||ffmpeg,['-hide_banner','-loglevel','error','-nostdin','-i',input,'-t','60','-map','0:v:0','-map','0:a:0?','-c:v','libx264','-preset','veryfast','-crf','24','-pix_fmt','yuv420p','-c:a','aac','-movflags','+faststart',output],{windowsHide:true,timeout:60000});
    const bytes=await fs.readFile(output);
    if(bytes.length>20*1024*1024)throw new Error('转换后的片段超过 20MB，请缩短片段。');
    return new Blob([bytes],{type:'video/mp4'});
  } finally {
    if(path.dirname(dir)===path.resolve(os.tmpdir())&&path.basename(dir).startsWith('teaching-clip-'))await fs.rm(dir,{recursive:true,force:true});
  }
}
