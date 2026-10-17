import {readFile,writeFile,readdir} from 'node:fs/promises';
import {resolve,dirname,extname} from 'node:path';
import {createHash} from 'node:crypto';
const root=resolve('dist');
for(const name of await readdir(root)){
 if(!name.endsWith('.html'))continue;
 const file=resolve(root,name);let html=await readFile(file,'utf8');
 const matches=[...html.matchAll(/(?:src|href|poster)="([^"]+)"/g)];
 for(const m of matches){const raw=m[1];if(/^(?:https?:|data:|#)/.test(raw))continue;const path=raw.split('?')[0];if(!['.css','.js','.mp4','.webm','.png','.webp','.svg'].includes(extname(path)))continue;
  const data=await readFile(resolve(dirname(file),path));const hash=createHash('sha256').update(data).digest('hex').slice(0,10);html=html.replaceAll('"'+raw+'"','"'+path+'?v='+hash+'"');
 }
 await writeFile(file,html);
}
console.log('Local asset URLs versioned by content hash.');
