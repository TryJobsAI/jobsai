import http from 'node:http';
import {readFile,stat} from 'node:fs/promises';
import {resolve,extname,sep} from 'node:path';
import {proxyJobsAI} from './server/jobsai-proxy.js';
const root=resolve('dist');
const port=Number(process.env.PORT||4174);
const mime={'.html':'text/html; charset=utf-8','.css':'text/css','.js':'text/javascript','.svg':'image/svg+xml','.webp':'image/webp','.png':'image/png','.jpg':'image/jpeg','.mp4':'video/mp4','.webm':'video/webm','.woff2':'font/woff2','.txt':'text/plain; charset=utf-8','.json':'application/json'};
function readRequestBody(req,limit=256*1024){return new Promise((resolve,reject)=>{const chunks=[];let size=0;req.on('data',chunk=>{size+=chunk.length;if(size>limit){reject(new Error('Request body too large'));req.destroy();return;}chunks.push(chunk);});req.on('end',()=>resolve(Buffer.concat(chunks)));req.on('error',reject);});}
http.createServer(async(req,res)=>{
  try {
    const requestedPath=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
    const path=({'/whitepaper':'/whitepaper.html','/roadmap':'/roadmap.html'})[requestedPath]||requestedPath;
    if(path.startsWith('/api/jobsai/')){
      const headers=new Headers();for(const name of ['accept','authorization','cookie','content-type','content-length']){const value=req.headers[name];if(typeof value==='string')headers.set(name,value);}
      let body;if(!['GET','HEAD'].includes(req.method||'GET')){const uploadPath=new URL(req.url,'http://localhost').pathname==='/api/jobsai/v1/media/images';body=await readRequestBody(req,uploadPath?5*1024*1024:256*1024);}
      const upstreamRequest=new Request(new URL(req.url,'http://localhost:'+port),{method:req.method,headers,body:body?.length?body:undefined});
      const upstream=await proxyJobsAI(upstreamRequest);const responseBody=Buffer.from(await upstream.arrayBuffer());
      res.writeHead(upstream.status,Object.fromEntries(upstream.headers.entries()));res.end(responseBody);return;
    }
    let file=resolve(root,'.'+path);
    if(file!==root&&!file.startsWith(root+sep)){res.writeHead(403);return res.end('Forbidden');}
    if((await stat(file)).isDirectory())file=resolve(file,'index.html');
    const body=await readFile(file);const headers={'Content-Type':mime[extname(file)]||'application/octet-stream','X-Content-Type-Options':'nosniff','Accept-Ranges':'bytes'};
    const range=req.headers.range;
    if(range){const match=/^bytes=(\d*)-(\d*)$/.exec(range);let start=0,end=body.length-1;
      if(!match||(!match[1]&&!match[2])){res.writeHead(416,{'Content-Range':`bytes */${body.length}`});return res.end();}
      if(!match[1])start=Math.max(0,body.length-Number(match[2]));else{start=Number(match[1]);if(match[2])end=Math.min(end,Number(match[2]));}
      if(start> end||start>=body.length){res.writeHead(416,{'Content-Range':`bytes */${body.length}`});return res.end();}
      res.writeHead(206,{...headers,'Content-Range':`bytes ${start}-${end}/${body.length}`,'Content-Length':end-start+1});return res.end(req.method==='HEAD'?undefined:body.subarray(start,end+1));
    }
    res.writeHead(200,{...headers,'Content-Length':body.length});res.end(req.method==='HEAD'?undefined:body);
  }catch{res.writeHead(404);res.end('Not found');}
}).listen(port,'127.0.0.1',()=>console.log(`Local: http://127.0.0.1:${port}`));
