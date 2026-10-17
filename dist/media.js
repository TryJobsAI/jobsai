// Decorative media never carries the only copy or a clickable surface.
(() => {
 const reduce=matchMedia('(prefers-reduced-motion: reduce)');
 const entries=[...document.querySelectorAll('video[data-decorative]')].map(video=>({video,stage:video.closest('.media-stage'),button:video.closest('.media-stage').querySelector('[data-video-toggle]'),visible:false,localPaused:false,failed:false,manual:false}));
 const globallyPaused=()=>document.body.classList.contains('motion-paused');
 function sync(entry){
  const {video,stage,button}=entry;
  const stopped=entry.localPaused||globallyPaused()||(reduce.matches&&!entry.manual);
  const play=entry.visible&&!document.hidden&&!stopped&&!entry.failed;
  stage.classList.toggle('media-active',play);
  button.setAttribute('aria-pressed',String(stopped));
  const action=stopped?'Play':'Pause';
  button.setAttribute('aria-label',button.getAttribute('aria-label').replace(/^(Play|Pause)/,action));
  button.firstElementChild.textContent=stopped?'▶':'Ⅱ';
  if(play){
   if(!video.getAttribute('src')){video.src=video.dataset.src;video.load();}
   video.muted=true;
   video.play().catch(()=>{if(!video.paused)return;stage.classList.remove('media-active');button.firstElementChild.textContent='▶';button.setAttribute('aria-label',button.getAttribute('aria-label').replace(/^Pause/,'Play'));});
  }else video.pause();
 }
 function syncAll(){entries.forEach(sync);}
 entries.forEach(entry=>{
  entry.button.addEventListener('click',()=>{
   const shouldPlay=entry.video.paused||globallyPaused();
   if(globallyPaused())document.querySelector('#motion-toggle').click();
   entry.manual=true;
   entry.localPaused=!shouldPlay;
   sync(entry);
  });
  entry.video.addEventListener('error',()=>{entry.failed=true;entry.stage.classList.remove('media-active');entry.button.hidden=true;});
 });
 if('IntersectionObserver' in window){
  const byVideo=new Map(entries.map(entry=>[entry.video,entry]));
  const observer=new IntersectionObserver(changes=>changes.forEach(change=>{const entry=byVideo.get(change.target);entry.visible=change.isIntersecting;sync(entry);}),{threshold:.08});
  entries.forEach(entry=>observer.observe(entry.video));
 }else{entries.forEach(entry=>entry.visible=true);syncAll();}
 document.addEventListener('visibilitychange',syncAll);
 document.addEventListener('jobsai:motion',syncAll);
 reduce.addEventListener('change',()=>{entries.forEach(entry=>entry.manual=false);syncAll();});
 window.addEventListener('pagehide',()=>entries.forEach(entry=>entry.video.pause()));
 window.addEventListener('pageshow',syncAll);
})();
