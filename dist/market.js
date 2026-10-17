/* Shared public-job preview. Provider/user values render as text, never HTML. */
(() => {
  const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
  const make=(tag,text,cls)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(cls)e.className=cls;return e;};
  const link=(text,url,cls)=>{const a=make('a',text,cls);a.href=url;return a;};
  const {roles,load,toggle}=JobsAIData;
  let toastTimer;
  function toast(text){$('#market-toast').textContent=text;$('#market-toast').classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('#market-toast').classList.remove('show'),2600);}
  function saveButton(role,cls='market-save'){
    const b=make('button',undefined,cls), saved=!!load().applications[role.id];
    b.textContent=saved?'✓ On your board':'＋ Save role';b.setAttribute('aria-pressed',String(saved));b.setAttribute('aria-label',`${saved?'Remove':'Save'} ${role.title} ${saved?'from':'to'} your board`);
    b.addEventListener('click',()=>{toggle(role.id);const isSaved=!!load().applications[role.id];toast(isSaved?'Saved to your board. No application was sent.':'Removed from your board.');if(document.body.dataset.view==='feed')renderFeed();else renderDetail();});return b;
  }
  function roleCard(r){
    const a=make('article',undefined,'market-card');const top=make('div',undefined,'market-card-top'),company=make('div',undefined,'market-company');company.append(make('strong',r.company),make('small',`${r.sector} · Sample employer`));top.append(make('span',r.letter,'market-company-mark'),company);
    const title=make('h2');title.append(link(r.title,`role.html?id=${r.id}`));
    const meta=make('div',undefined,'market-tags');[r.location,r.type,r.level].forEach(t=>meta.append(make('span',t)));
    const bottom=make('div',undefined,'market-card-bottom');bottom.append(link('View role ↗',`role.html?id=${r.id}`,'pill outline small'),saveButton(r));
    const fit=make('div',undefined,'market-fit');fit.append(make('strong',`${r.fit}%`),make('span',`${r.met.length} of ${r.met.length+r.missing.length} requirements matched`),make('span','↗'));
    a.append(top,title,make('p',r.summary),meta,fit,make('small','Salary not supplied · Fictional posting','salary-note'),bottom);return a;
  }
  function selected(name){return $$(`input[name="${name}"]:checked`).map(e=>e.value);}
  function syncQuery(){const u=new URL(location.href);for(const [key,value]of [['q',$('#market-query').value.trim()],['location',$('#market-location').value.trim()],['mode',selected('mode').join(',')],['type',selected('type').join(',')],['strong',$('#strong-only').checked?'1':''],['saved',$('#saved-only').checked?'1':''],['sort',$('#market-sort').value]]){if(value&&value!=='recommended')u.searchParams.set(key,value);else u.searchParams.delete(key);}history.replaceState(null,'',u);}
  function renderFeed(){
    const q=$('#market-query').value.trim().toLowerCase(),locationQuery=$('#market-location').value.trim().toLowerCase(),modes=selected('mode'),types=selected('type'),s=load();
    let filtered=roles.filter(r=>!r.closed&&(!modes.length||modes.includes(r.mode))&&(!types.length||types.includes(r.type))&&(!$ ('#strong-only').checked||r.fit>=80)&&(!$('#saved-only').checked||s.applications[r.id])&&[r.title,r.company,...r.met,...r.missing].join(' ').toLowerCase().includes(q)&&r.location.toLowerCase().includes(locationQuery));
    const sort=$('#market-sort').value;if(sort==='fit')filtered.sort((a,b)=>b.fit-a.fit);if(sort==='title')filtered.sort((a,b)=>a.title.localeCompare(b.title));
    $('#result-count').textContent=String(filtered.length);$('#market-results').replaceChildren(...filtered.map(roleCard));$('.feed-end').hidden=!filtered.length;
    if(!filtered.length){const empty=make('div',undefined,'market-empty');const b=make('button','Clear filters','pill primary');b.addEventListener('click',clearFilters);empty.append(make('span','⌕'),make('h2','A little room to widen your search.'),make('p','Try another title, skill, or location. This preview has four fictional roles.'),b);$('#market-results').append(empty);}
    syncQuery();
  }
  function clearFilters(){$('#market-query').value='';$('#market-location').value='';$$('.market-filters input').forEach(e=>e.checked=false);$('#market-sort').value='recommended';renderFeed();}
  function list(items){const ul=make('ul');items.forEach(t=>ul.append(make('li',t)));return ul;}
  function section(title,content){const s=make('section',undefined,'role-copy-section');s.append(make('h2',title),content);return s;}
  let currentRole;
  const sampleLetter=r=>`SAMPLE LETTER — fictional profile and vacancy\n\nAlex Lee\n${r.title} · ${r.company}\n\nI’m interested in the ${r.title.toLowerCase()} role. My sample profile includes designing an onboarding flow, conducting user interviews, and building prototypes in Figma. I have collaborated with product and engineering partners and presented design decisions.\n\nI would welcome the chance to discuss how this experience relates to your team’s needs.\n\nPreview only. Review every claim before using real documents. This has not been submitted.`;
  function renderDetail(){
    const id=new URLSearchParams(location.search).get('id');currentRole=roles.find(r=>r.id===id);const root=$('#role-page');root.replaceChildren();
    if(!currentRole){const error=make('div',undefined,'market-empty');error.append(make('h1','That role isn’t here.'),make('p','It may have moved or the link may be incomplete.'),link('Explore the Job Market','market.html','pill primary'));root.append(error);return;}
    const r=currentRole;document.title=`${r.title} at ${r.company} · JobsAI`;
    const header=make('header',undefined,'role-hero'),top=make('div',undefined,'role-company-row');top.append(make('span',r.letter,'market-company-mark'),make('span',`${r.company} · ${r.sector}`),make('span','SAMPLE ROLE','sample-label'));header.append(top,make('h1',r.title),make('p',r.summary));const tags=make('div',undefined,'market-tags');[r.location,r.type,r.level,'Salary not supplied'].forEach(t=>tags.append(make('span',t)));header.append(tags);
    const layout=make('div',undefined,'role-detail-layout'),body=make('article',undefined,'role-copy');
    body.append(section('The opportunity',make('p',r.summary+' This fictional vacancy shows the information that an employer-source role page will contain.')),
      section('What you’ll work on',list(r.responsibilities)),section('What you bring',list([...r.met,...r.missing])),section('About the team',make('p',r.about)),section('What’s in the posting',list(r.benefits)));
    const source=make('div',undefined,'role-source');source.append(make('span','↗'),make('h2','A clear source. An honest status.'),make('p',`${r.ats} is the illustrative source type for this sample. This role has no real source ID or application URL and has not been fetched or verified.`),make('p','Live roles will show the employer’s original posting, its latest check time, and salary only when the posting supplies it. Closed roles will be hidden from search.'));
    body.append(source);
    const aside=make('aside',undefined,'role-action-rail'),match=make('div',undefined,'role-match-panel'),score=make('div',undefined,'role-big-score');score.append(make('strong',`${r.fit}%`),make('span','SAMPLE FIT'));match.append(score,make('h2','See the fit. Know the gaps.'),make('p',`${r.met.length} of ${r.met.length+r.missing.length} sample requirements matched.`),make('h3','In the sample profile'),list(r.met.map(t=>'✓ '+t)),make('h3','Still a gap'),list(r.missing.map(t=>'○ '+t)),make('small','Illustrative skill overlap, not a probability of getting hired. The live score uses posting requirements and your profile.'));
    const action=make('div',undefined,'role-action-card'),preview=make('button','Preview tailored letter ↗','pill primary');preview.addEventListener('click',openApplication);action.append(make('h2','Your next move.'),make('p','Build from your own facts. Review the wording. You stay in control.'),preview,saveButton(r,'pill outline'),link('Practise for an interview','workspace.html?tab=interviews','role-text-link'),link('Open your application board','workspace.html?tab=tracker','role-text-link'));
    const employer=make('button','Employer application unavailable','pill outline');employer.disabled=true;action.append(employer,make('small','This fictional role has no employer URL. In the live product, you open the official application and submit it yourself.'));
    aside.append(match,action);layout.append(body,aside);root.append(header,layout);
  }
  function openApplication(){if(!currentRole)return;$('#application-body').replaceChildren(make('p',sampleLetter(currentRole),'sample-letter'),make('div','✓ Sample claims map to the six profile facts.','document-fact'),make('div','“Led a team of eight” is unsupported and removed.','document-fact'),make('p','This static example demonstrates the fact lock. No AI was called. Live documents need entailment checks, formatting checks and your review before they count toward an application credit.','fine-print'));$('#application-dialog').showModal();}
  if(document.body.dataset.view==='feed'){
    const params=new URLSearchParams(location.search);$('#market-query').value=params.get('q')||'';$('#market-location').value=params.get('location')||'';
    for(const name of ['mode','type']){const values=(params.get(name)||'').split(',');$$(`input[name="${name}"]`).forEach(e=>e.checked=values.includes(e.value));}
    $('#strong-only').checked=params.get('strong')==='1';$('#saved-only').checked=params.get('saved')==='1';if(['recommended','fit','title'].includes(params.get('sort')))$('#market-sort').value=params.get('sort');
    $('.market-search').addEventListener('submit',e=>{e.preventDefault();renderFeed();$('.market-toolbar').scrollIntoView({behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'});});
    for(const id of ['market-query','market-location'])$('#'+id).addEventListener('input',renderFeed);$$('.market-filters input').forEach(e=>e.addEventListener('change',renderFeed));$('#market-sort').addEventListener('change',renderFeed);$('#clear-filters').addEventListener('click',clearFilters);
    $('#filters-toggle').addEventListener('click',()=>{const show=$('#filters-toggle').getAttribute('aria-expanded')!=='true';$('#filters-toggle').setAttribute('aria-expanded',String(show));$('#market-filters').classList.toggle('open',show);});renderFeed();
  }else{
    renderDetail();for(const selector of ['.dialog-close','#close-application'])$(selector).addEventListener('click',()=>$('#application-dialog').close());
    $('#application-dialog').addEventListener('click',e=>{if(e.target===e.currentTarget){const r=e.currentTarget.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)e.currentTarget.close();}});
    $('#download-application').addEventListener('click',()=>{if(!currentRole)return;const url=URL.createObjectURL(new Blob([sampleLetter(currentRole)],{type:'text/plain;charset=utf-8'})),a=link('Download',url);a.download='jobsai-sample-letter.txt';document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);toast('Sample letter downloaded. Nothing was submitted.');});
  }
  window.addEventListener('storage',e=>{if(e.key==='jobsai-demo-v1')document.body.dataset.view==='feed'?renderFeed():renderDetail();});
})();
