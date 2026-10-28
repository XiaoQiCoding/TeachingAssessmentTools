// Incremental SHA-256 keeps memory bounded and works over plain HTTP as well as HTTPS.
(() => {
  const K=new Uint32Array([0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2]);
  const rotate=(n,b)=>(n>>>b)|(n<<(32-b));
  class VideoSha256 {
    constructor(){this.state=new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]);this.buffer=new Uint8Array(64);this.words=new Uint32Array(64);this.length=0;this.pending=0;}
    block(bytes,offset){
      const w=this.words;
      for(let i=0;i<16;i++){const p=offset+i*4;w[i]=(bytes[p]<<24)|(bytes[p+1]<<16)|(bytes[p+2]<<8)|bytes[p+3];}
      for(let i=16;i<64;i++){const x=w[i-15],y=w[i-2];w[i]=(rotate(x,7)^rotate(x,18)^(x>>>3))+w[i-16]+(rotate(y,17)^rotate(y,19)^(y>>>10))+w[i-7];}
      const s=this.state;let a=s[0],b=s[1],c=s[2],d=s[3],e=s[4],f=s[5],g=s[6],h=s[7];
      for(let i=0;i<64;i++){
        const t1=(h+(rotate(e,6)^rotate(e,11)^rotate(e,25))+((e&f)^(~e&g))+K[i]+w[i])>>>0;
        const t2=((rotate(a,2)^rotate(a,13)^rotate(a,22))+((a&b)^(a&c)^(b&c)))>>>0;
        h=g;g=f;f=e;e=(d+t1)>>>0;d=c;c=b;b=a;a=(t1+t2)>>>0;
      }
      s[0]+=a;s[1]+=b;s[2]+=c;s[3]+=d;s[4]+=e;s[5]+=f;s[6]+=g;s[7]+=h;
    }
    update(bytes){
      this.length+=bytes.length;let offset=0;
      if(this.pending){const count=Math.min(64-this.pending,bytes.length);this.buffer.set(bytes.subarray(0,count),this.pending);this.pending+=count;offset=count;if(this.pending===64){this.block(this.buffer,0);this.pending=0;}}
      for(;offset+64<=bytes.length;offset+=64)this.block(bytes,offset);
      if(offset<bytes.length){this.buffer.set(bytes.subarray(offset),0);this.pending=bytes.length-offset;}
      return this;
    }
    hex(){
      const tail=new Uint8Array(this.pending<56?64:128);tail.set(this.buffer.subarray(0,this.pending));tail[this.pending]=128;
      const view=new DataView(tail.buffer);view.setUint32(tail.length-8,Math.floor(this.length/0x20000000));view.setUint32(tail.length-4,(this.length*8)>>>0);
      for(let offset=0;offset<tail.length;offset+=64)this.block(tail,offset);
      return [...this.state].map(n=>n.toString(16).padStart(8,'0')).join('');
    }
  }
  globalThis.VideoSha256=VideoSha256;
  if(typeof document==='undefined'){
    globalThis.onmessage=async({data:{file}})=>{
      try{const hash=new VideoSha256(),chunkSize=4*1024*1024;
        for(let offset=0;offset<file.size;offset+=chunkSize){hash.update(new Uint8Array(await file.slice(offset,offset+chunkSize).arrayBuffer()));postMessage({progress:Math.min(file.size,offset+chunkSize)/file.size});}
        postMessage({sha256:hash.hex()});
      }catch(error){postMessage({error:error.message});}
    };
  }else{
    const cache=new WeakMap();
    window.evaluationVideoFingerprint=(file,signal,onProgress=()=>{})=>{
      signal.throwIfAborted();if(cache.has(file))return Promise.resolve(cache.get(file));
      return new Promise((resolve,reject)=>{
        const worker=new Worker('/video-fingerprint.js');
        const finish=(error,value)=>{worker.terminate();signal.removeEventListener('abort',abort);if(error)reject(error);else{cache.set(file,value);resolve(value);}};
        const abort=()=>finish(signal.reason);signal.addEventListener('abort',abort,{once:true});
        worker.onerror=()=>finish(new Error('无法校验视频内容，请刷新页面后重试。'));
        worker.onmessage=({data})=>{if(data.error)finish(new Error(data.error));else if(data.sha256)finish(null,data.sha256);else onProgress(data.progress);};
        worker.postMessage({file});
      });
    };
  }
})();
