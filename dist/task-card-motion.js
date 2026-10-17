/* JobsAI-specific vanilla DOM adaptation of React Bits MagicBento.
 * Copyright (c) 2026 David Haz. MIT + Commons Clause; see licenses/react-bits.txt.
 * Retains pointer spotlight, neighboring edge light, and an interruptible click wave.
 * No React migration, demo visuals, third-party icon runtime, tilt, or particle canvas.
 */
(() => {
 const grid=document.querySelector('.jobs-grid');if(!grid)return;
 const cards=[...grid.querySelectorAll('.job-card')];
 const reduce=matchMedia('(prefers-reduced-motion: reduce)'),fine=matchMedia('(hover:hover) and (pointer:fine)');
 const pointer={x:-1e5,y:-1e5,inside:false},wave={x:0,y:0,t:-1,duration:1.1,reach:800};
 let raf=0,last=0,visible=true;
 const allowed=()=>!reduce.matches&&!document.hidden&&!document.body.classList.contains('motion-paused')&&visible;
 cards.forEach(card=>{for(const name of ['mb-light','mb-border']){const layer=document.createElement('span');layer.className=name;layer.setAttribute('aria-hidden','true');card.append(layer);}});
 function frame(now){
  raf=0;if(!allowed())return;
  const dt=Math.min(.05,(now-last)/1000||0);last=now;
  let radius=0,alpha=0;
  if(wave.t>=0){wave.t+=dt;const progress=Math.min(1,wave.t/wave.duration);radius=wave.reach*(1-Math.pow(1-progress,2.2));alpha=Math.pow(1-progress,1.3);if(progress>=1)wave.t=-1;}
  for(const card of cards){const r=card.getBoundingClientRect();const x=pointer.x-r.left,y=pointer.y-r.top;const inside=pointer.inside&&x>=0&&y>=0&&x<=r.width&&y<=r.height;const near=pointer.inside&&x>-160&&y>-160&&x<r.width+160&&y<r.height+160;
   for(const [k,v]of Object.entries({'--mb-x':`${x}px`,'--mb-y':`${y}px`,'--mb-hot':inside?1:0,'--mb-near':near ? .8 : 0,'--mb-wx':`${wave.x-r.left}px`,'--mb-wy':`${wave.y-r.top}px`,'--mb-wr':`${radius}px`,'--mb-wa':alpha}))card.style.setProperty(k,String(v));
  }
  if(wave.t>=0)raf=requestAnimationFrame(frame);
 }
 const wake=()=>{if(!raf&&allowed()){last=performance.now();raf=requestAnimationFrame(frame);}};
 grid.addEventListener('pointermove',e=>{if(!fine.matches)return;pointer.x=e.clientX;pointer.y=e.clientY;pointer.inside=true;wake();},{passive:true});
 grid.addEventListener('pointerleave',()=>{pointer.inside=false;wake();});
 grid.addEventListener('click',e=>{const card=e.target.closest('.job-card');if(!card||!allowed())return;const r=card.getBoundingClientRect(),bounds=grid.getBoundingClientRect();wave.x=e.detail?e.clientX:r.left+r.width/2;wave.y=e.detail?e.clientY:r.top+r.height/2;wave.t=0;wave.reach=Math.max(Math.hypot(wave.x-bounds.left,wave.y-bounds.top),Math.hypot(wave.x-bounds.right,wave.y-bounds.bottom))+140;wake();});
 const stop=()=>{cancelAnimationFrame(raf);raf=0;wave.t=-1;pointer.inside=false;cards.forEach(c=>{c.style.setProperty('--mb-hot','0');c.style.setProperty('--mb-near','0');c.style.setProperty('--mb-wa','0');});};
 if('IntersectionObserver'in window){const observer=new IntersectionObserver(e=>{visible=e[0].isIntersecting;if(!visible)stop();});observer.observe(grid);}
 document.addEventListener('visibilitychange',()=>{if(document.hidden)stop();});document.addEventListener('jobsai:motion',stop);reduce.addEventListener('change',stop);window.addEventListener('pagehide',stop);
})();
