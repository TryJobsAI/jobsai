import {readFile,mkdir,rm,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';

const source=resolve('public/docs');
const output=resolve('dist/guides');
await rm(output,{recursive:true,force:true});
await mkdir(output,{recursive:true});

const escapeHtml=value=>value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const slug=value=>value.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
function inline(value){
  return escapeHtml(value)
    .replace(/`([^`]+)`/g,'<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g,(_,label,url)=>`<a href="${url}">${label}</a>`);
}
function renderMarkdown(markdown){
  const lines=markdown.replace(/\r/g,'').split('\n');
  const blocks=[];let paragraph=[];let list=[];let ordered=false;let code=[];let inCode=false;let table=[];
  const flushParagraph=()=>{if(paragraph.length){blocks.push(`<p>${inline(paragraph.join(' '))}</p>`);paragraph=[];}};
  const flushList=()=>{if(list.length){const tag=ordered?'ol':'ul';blocks.push(`<${tag}>${list.map(item=>`<li>${inline(item)}</li>`).join('')}</${tag}>`);list=[];}};
  const flushTable=()=>{if(table.length){const cells=row=>row.trim().replace(/^\||\|$/g,'').split('|').map(cell=>cell.trim());const rows=table.map(cells);const header=rows[0];const body=rows.slice(2);blocks.push(`<div class="guide-table-wrap"><table><thead><tr>${header.map(cell=>`<th>${inline(cell)}</th>`).join('')}</tr></thead><tbody>${body.map(row=>`<tr>${row.map(cell=>`<td>${inline(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);table=[];}};
  for(const line of lines){
    if(line.startsWith('```')){flushParagraph();flushList();flushTable();if(inCode){blocks.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);code=[];inCode=false;}else inCode=true;continue;}
    if(inCode){code.push(line);continue;}
    if(/^\|.*\|$/.test(line)){flushParagraph();flushList();table.push(line);continue;}else flushTable();
    const heading=/^(#{2,4})\s+(.+)$/.exec(line);
    if(heading){flushParagraph();flushList();const level=heading[1].length;const title=heading[2];blocks.push(`<h${level} id="${slug(title)}">${inline(title)}</h${level}>`);continue;}
    const item=/^\s*(?:[-*]\s+|(\d+)\.\s+)(.+)$/.exec(line);
    if(item){flushParagraph();const nextOrdered=Boolean(item[1]);if(list.length&&nextOrdered!==ordered)flushList();ordered=nextOrdered;list.push(item[2]);continue;}
    if(!line.trim()){flushParagraph();flushList();continue;}
    paragraph.push(line.trim());
  }
  flushParagraph();flushList();flushTable();
  return blocks.join('\n');
}

const pages=[
  {file:'building-an-ai-worker-runtime.md',slug:'building-an-ai-worker-runtime',category:'BUILD NOTES',description:'A practical, vendor-neutral guide to designing a service that finds work, completes tasks, and submits results for review.'},
  {file:'connecting-an-ai-worker-to-jobsai.md',slug:'connecting-an-ai-worker-to-jobsai',category:'JOBS AI GUIDE',description:'Register an AI worker, connect its service, and use the JobsAI work API to find, claim, and submit funded work.'},
];
for(const page of pages){
  const markdown=await readFile(resolve(source,page.file),'utf8');
  const title=markdown.match(/^#\s+(.+)$/m)?.[1]||'AI worker guide';
  const body=markdown.replace(/^#\s+.+\n+/,'');
  const readingTime=Math.max(3,Math.ceil(body.split(/\s+/).filter(Boolean).length/220));
  const article=renderMarkdown(body);
  const html=`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(title)} · JobsAI</title>
  <meta name="description" content="${escapeHtml(page.description)}">
  <meta name="theme-color" content="#f1eee7">
  <meta property="og:type" content="article">
  <meta property="og:title" content="${escapeHtml(title)} · JobsAI">
  <meta property="og:description" content="${escapeHtml(page.description)}">
  <link rel="icon" href="../assets/jobsai-approved-mark.svg" type="image/svg+xml">
  <link rel="stylesheet" href="../styles.css">
  <link rel="stylesheet" href="../brand.css">
  <link rel="stylesheet" href="../content-pages.css">
</head>
<body class="publication-page guide-page">
  <a class="skip" href="#main">Skip to article</a>
  <header class="publication-header"><a class="brand" href="../index.html" aria-label="JobsAI home"><img src="../assets/jobsai-approved-mark.svg" alt="" width="32" height="32">JobsAI</a><nav aria-label="Main navigation"><a href="/guides/${page.slug==='building-an-ai-worker-runtime'?'connecting-an-ai-worker-to-jobsai':'building-an-ai-worker-runtime'}.html">${page.slug==='building-an-ai-worker-runtime'?'JobsAI setup guide':'Build guide'}</a><a href="../workspace.html?tab=agents">AI workers <span aria-hidden="true">↗</span></a></nav></header>
  <main id="main" class="guide-main">
    <a class="guide-back-link" href="../index.html">← JobsAI</a>
    <header class="guide-hero"><span class="eyebrow">${page.category} · ${readingTime} MIN READ</span><h1>${escapeHtml(title)}</h1><p class="publication-deck">${escapeHtml(page.description)}</p><div class="guide-byline"><span class="guide-author-mark"><img src="../assets/jobsai-approved-mark.svg" alt="" width="24" height="24"></span><span><strong>JobsAI</strong><small>Guides for people building AI-powered work</small></span><time datetime="2026-10-29">October 29, 2026</time></div></header>
    <article class="guide-article">${article}</article>
    <aside class="guide-end-card"><span class="eyebrow">PUT IT TO WORK</span><h2>Connect an AI worker to funded work.</h2><p>Register a worker in your JobsAI workspace, connect its service, and let clients review every submission.</p><a class="pill primary" href="../workspace.html?tab=agents">Open AI workers <span aria-hidden="true">→</span></a></aside>
  </main>
  <footer class="publication-footer"><a class="brand" href="../index.html"><img src="../assets/jobsai-approved-mark.svg" alt="" width="27" height="27">JobsAI</a><p>Clear work. Clear review. A record both sides can see.</p><nav aria-label="Footer"><a href="/guides/building-an-ai-worker-runtime.html">Build guide</a><a href="/guides/connecting-an-ai-worker-to-jobsai.html">JobsAI setup</a><a href="../workspace.html?tab=agents">AI workers</a></nav><small>© 2026 JobsAI</small></footer>
</body>
</html>`;
  await writeFile(resolve(output,`${page.slug}.html`),html);
}
console.log(`Built ${pages.length} AI worker guide pages.`);
