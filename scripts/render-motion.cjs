// Transparent, deterministic website loops. Original approved mark is preserved.
const fs=require('fs');
const path=require('path');
const {spawn}=require('child_process');
const {once}=require('events');
const sharp=require('sharp'); // Optional authoring dependency; the website itself needs no packages.
const brand=require('./brand-motion-source.cjs');
const out=path.resolve(__dirname,'../dist/assets');
const ffmpeg=process.env.JOBSAI_FFMPEG;
if(!ffmpeg)throw Error('Set JOBSAI_FFMPEG to an FFmpeg executable with libvpx-vp9.');
const duration=6,fps=24,size=640;
const C={blue:'#0061FE',ink:'#212833',cream:'#FFFDFA',pale:'#DDE8FF'};
function roadmap(t){
 const q=(((t%duration)+duration)%duration)/duration*Math.PI*2;
 const lift=(phase,amount=6)=>(Math.sin(q+phase)-Math.sin(phase))*amount;
 const g=(x,y,body)=>`<g transform="translate(${x} ${y})">${body}</g>`;
 const rect=(x,y,w,h,fill=C.cream,r=17)=>`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}" stroke="${C.ink}" stroke-width="5"/>`;
 const check=(x,y,s=1)=>`<path d="m${x} ${y} ${9*s} ${9*s} ${19*s} ${-23*s}" fill="none" stroke="${C.blue}" stroke-width="${6*s}" stroke-linecap="round" stroke-linejoin="round"/>`;
 const lines=(x,y,width)=>`<path d="M${x} ${y}h${width}m-${width} 17h${width*.7}" fill="none" stroke="${C.pale}" stroke-width="7" stroke-linecap="round"/>`;
 const body=`<path d="M170 365C70 465 240 540 376 460S580 260 458 170" stroke="${C.blue}" stroke-width="3" stroke-dasharray="8 10" fill="none" opacity=".35"/>
 ${g(0,lift(0),rect(155,130,245,330)+`<circle cx="278" cy="215" r="42" fill="${C.pale}"/><circle cx="278" cy="205" r="13" fill="${C.blue}"/><path d="M251 238c0-30 54-30 54 0" fill="${C.blue}"/>`+lines(205,292,146)+lines(205,343,146)+check(205,406)+`<path d="M249 401h92" stroke="${C.pale}" stroke-width="8" stroke-linecap="round"/>`)}
 ${g(0,lift(1),rect(360,220,165,180)+`<path d="M386 255h112" stroke="${C.blue}" stroke-width="8" stroke-linecap="round"/>`+[0,1,2].map(i=>rect(382,275+i*33,120,24,i===1?C.pale:C.cream,6)).join('')+check(480,289,.5))}
 ${g(0,lift(2),rect(88,355,110,104,C.blue,20)+`<rect x="117" y="397" width="53" height="36" rx="8" fill="${C.cream}"/><path d="M129 397v-12a15 15 0 0130 0v12" stroke="${C.cream}" stroke-width="7" fill="none"/><circle cx="144" cy="413" r="4" fill="${C.blue}"/>`)}
 ${g(0,lift(3,4),`<circle cx="422" cy="142" r="36" fill="${C.cream}" stroke="${C.ink}" stroke-width="5"/>`+check(407,143))}
 <g stroke="${C.blue}" stroke-width="5" stroke-linecap="round" opacity="${.55+.45*Math.pow(Math.sin(q/2),2)}"><path d="M454 93l8-13M472 111l16-4M125 263l-14-6"/></g>`;
 return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 640 640">${body}</svg>`);
}
const makers={cta:t=>brand.frame(t,{size,transparent:true}),roadmap};
async function main(){
 fs.mkdirSync(out,{recursive:true});
 const report=[];
 for(const [name,frame]of Object.entries(makers)){
  await sharp(frame(0)).png().toFile(path.join(out,`${name}-transparent-poster.png`));
  const file=path.join(out,`${name}-transparent.webm`);
  const proc=spawn(ffmpeg,['-y','-hide_banner','-loglevel','error','-f','rawvideo','-pixel_format','rgba','-video_size',`${size}x${size}`,'-framerate',String(fps),'-i','pipe:0','-an','-c:v','libvpx-vp9','-pix_fmt','yuva420p','-auto-alt-ref','0','-b:v','0','-crf','28','-deadline','good','-cpu-used','3',file],{stdio:['pipe','ignore','pipe'],windowsHide:true});
  let err='';proc.stderr.on('data',d=>err+=d);const closed=once(proc,'close');
  for(let i=0;i<duration*fps;i++){
   const buf=await sharp(frame(i/fps)).ensureAlpha().raw().toBuffer();
   if(!proc.stdin.write(buf))await once(proc.stdin,'drain');
  }
  proc.stdin.end();const [code]=await closed;if(code)throw Error(err);
  const seamIdentical=frame(0).equals(frame(duration));
  report.push({name,width:size,height:size,fps,duration,frames:duration*fps,seamIdentical,bytes:fs.statSync(file).size});
 }
 const reportDir=path.resolve(__dirname,'../validation');fs.mkdirSync(reportDir,{recursive:true});
 fs.writeFileSync(path.join(reportDir,'native-motion-validation.json'),JSON.stringify(report,null,2));
 console.log(JSON.stringify(report,null,2));
}
main().catch(e=>{console.error(e);process.exit(1)});
