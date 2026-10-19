import {execFileSync} from 'node:child_process';
import {rm} from 'node:fs/promises';
import {resolve} from 'node:path';
await rm(resolve('dist/wallet'),{recursive:true,force:true});
execFileSync('bun',['run','build:wallet'],{stdio:'inherit'});
await import('./version-assets.mjs');
await import('./check.mjs');
