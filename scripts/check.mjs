import {readFile,readdir,access} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {execFileSync} from 'node:child_process';
const root=resolve('dist');let checked=0;const errors=[];
async function walk(dir){const out=[];for(const e of await readdir(dir,{withFileTypes:true})){const p=resolve(dir,e.name);if(e.isDirectory())out.push(...await walk(p));else out.push(p);}return out;}
for(const file of await walk(root)){
 if(file.endsWith('.js')){const code=await readFile(file,'utf8');if(typeof Bun!=='undefined')new Bun.Transpiler({loader:'js'}).transformSync(code);else execFileSync(process.execPath,['--check',file]);if(/innerHTML|eval\(|new Function|XMLHttpRequest|document\.write/.test(code))errors.push(`Review dynamic content surface in ${file}`);if(/fetch\s*\(/.test(code)&&!file.endsWith('/jobsai-api.js'))errors.push(`Network requests must use the same-origin JobsAI proxy in ${file}`);if(file.endsWith('/jobsai-api.js')&&(!code.includes("const API_PREFIX = '/api/jobsai';")||!/fetch\(`\$\{API_PREFIX\}/.test(code)))errors.push('JobsAI browser API must use the same-origin /api/jobsai proxy.');}
 if(!file.endsWith('.html'))continue;
 const source=await readFile(file,'utf8');
 for(const m of source.matchAll(/(?:src|href|poster)="([^"]+)"/g)){
   const url=m[1];if(/^(?:https?:|mailto:|tel:|data:)/.test(url))continue;
   const [pathname,fragment]=url.split('#');const clean=pathname.split('?')[0];
   const target=clean?resolve(dirname(file),clean):file;
   try{await access(target);}catch{errors.push(`Missing asset or route: ${url} in ${file}`);continue;}
   if(fragment&&target.endsWith('.html')){const html=target===file?source:await readFile(target,'utf8');if(!html.includes(`id="${fragment}"`))errors.push(`Missing anchor ${url}`);}
   checked++;
 }
 if(/on(?:click|error|load)=|javascript:|<iframe/i.test(source))errors.push(`Unsafe inline behavior in ${file}`);
 const ids=[...source.matchAll(/\bid="([^"]+)"/g)].map(m=>m[1]);if(new Set(ids).size!==ids.length)errors.push(`Duplicate IDs in ${file}`);
}
const app=await readFile(resolve(root,'app.js'),'utf8');const workspace=await readFile(resolve(root,'workspace.js'),'utf8');
for(const [name,code] of [['app',app],['workspace',workspace]])if(/innerHTML|eval\(|new Function|XMLHttpRequest|document\.write/.test(code))errors.push(`Review dynamic content surface in ${name}`);
const home=await readFile(resolve(root,'index.html'),'utf8');
for(const phrase of ['Go after the','Pay only after it passes','14-day full refund','Unused credits refunded','not independent of JobsAI'])if(!home.includes(phrase))errors.push(`Missing revised requirement: ${phrase}`);
if(/Land the job|Pay only when it passes|Skill-proof/.test(home))errors.push('Superseded copy found');
if(errors.length){console.error(errors.join('\n'));process.exit(1);}
console.log(`PASS: JavaScript syntax, ${checked} local asset/route/anchor references, revised copy requirements, and focused client security checks.`);
