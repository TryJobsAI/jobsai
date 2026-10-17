import http from 'node:http';
import {readFile,stat} from 'node:fs/promises';
import {resolve,extname,sep} from 'node:path';
const root=resolve('dist');
const port=Number(process.env.PORT||4174);
const mime={'.html':'text/html; charset=utf-8','.css':'text/css','.js':'text/javascript','.svg':'image/svg+xml','.webp':'image/webp','.png':'image/png','.jpg':'image/jpeg','.mp4':'video/mp4','.webm':'video/webm','.woff2':'font/woff2','.txt':'text/plain; charset=utf-8','.json':'application/json'};
http.createServer(async(req,res)=>{
  try {
    const path=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
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
