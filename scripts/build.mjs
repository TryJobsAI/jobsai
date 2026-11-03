import {execFileSync} from 'node:child_process';
import {cp,mkdir,readdir,readFile,rm,writeFile} from 'node:fs/promises';
import {dirname,relative,resolve} from 'node:path';
await rm(resolve('dist/wallet'),{recursive:true,force:true});
execFileSync('bun',['run','build:wallet'],{stdio:'inherit'});
const publicGuideSource=resolve('public/docs');
const publicGuideOutput=resolve('dist/docs');
await rm(publicGuideOutput,{recursive:true,force:true});
await mkdir(publicGuideOutput,{recursive:true});
await cp(publicGuideSource,publicGuideOutput,{recursive:true});
await import('./build-guides.mjs');
const distRoot=resolve('dist');
async function addAnalytics(dir){for(const entry of await readdir(dir,{withFileTypes:true})){const file=resolve(dir,entry.name);if(entry.isDirectory()){await addAnalytics(file);continue;}if(!entry.name.endsWith('.html'))continue;let html=await readFile(file,'utf8');html=html.replace(/<script src="[^"]*analytics\.js(?:\?[^\"]*)?" defer><\/script>\r?\n?/,'');const scriptPath=relative(dirname(file),resolve(distRoot,'wallet/analytics.js')).split('\\').join('/');html=html.replace('</head>',`<script src="${scriptPath}" defer></script></head>`);await writeFile(file,html);}}
await addAnalytics(distRoot);
await import('./version-assets.mjs');
await import('./check.mjs');
