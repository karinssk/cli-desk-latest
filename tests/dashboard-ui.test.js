const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const { join, resolve } = require('node:path');
const { tmpdir } = require('node:os');
const { spawn } = require('node:child_process');
const chrome = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
if (!fs.existsSync(chrome)) { console.log('Dashboard browser check skipped; set CHROME_BIN.'); process.exit(0); }
const root = resolve(__dirname, '..', 'public');
const sessions = [
  {id:'one',name:'<img src=x onerror=alert(1)>',cwd:'/work/dashboard',presetId:'codex',working:true,statusKnown:true,details:{role:'Main Coding',currentTask:'Build dashboard'},monitor:{model:'Test model',contextTokens:25,contextWindow:100}},
  {id:'two',name:'Reviewer',cwd:'/work/review',working:false,statusKnown:true,details:{},monitor:{},recoverableError:true},
];
const fixture = `
const check = (value,message) => {if(!value)throw Error(message)};
try {
  const {refresh} = await import('/js/dashboard.js');
  for(let i=0;i<50&&!document.querySelector('.session-card');i++)await new Promise(r=>setTimeout(r,100));
  check(document.querySelectorAll('#sessions .session-card').length===2,'live session cards');
  check(document.getElementById('stat-working').textContent==='1','working count');
  check(document.getElementById('stat-attention').textContent==='1','attention count');
  check(document.getElementById('stat-helpers').textContent==='1','native helper count');
  check(!document.querySelector('#sessions img'),'session name cannot inject HTML');
  check(document.querySelector('#sessions a').getAttribute('href')==='/#session=one','terminal deep link');
  const search=document.getElementById('search'); search.value='review';search.dispatchEvent(new Event('input'));
  check(document.querySelectorAll('#sessions .session-card').length===1,'search filters sessions');
  search.value='';search.dispatchEvent(new Event('input'));
  location.hash='agents';await new Promise(r=>setTimeout(r,30));
  check(!document.getElementById('view-agents').hidden,'agent page navigation');
  check(document.querySelectorAll('[data-native-id]').length===1,'native helper visible');
  check(document.querySelector('[data-native-id] .badge').textContent==='Unknown','unknown native status honest');
  location.hash='recovery';await new Promise(r=>setTimeout(r,30));
  check(!document.getElementById('view-recovery').hidden,'recovery page navigation');
  check(document.getElementById('recovery').textContent.includes('Not reported'),'missing recovery count not invented');
  location.hash='constructor';await new Promise(r=>setTimeout(r,30));
  check(!document.getElementById('view-overview').hidden,'unknown route safely falls back');
  const originalFetch=window.fetch;
  window.fetch=()=>Promise.reject(Error('offline'));
  await refresh();
  window.fetch=originalFetch;
  check(document.getElementById('connection').textContent==='Disconnected','disconnect visible');
  check(document.querySelector('#sessions .badge').textContent==='Unknown','stale working cleared');
  check(document.getElementById('stat-working').textContent==='—','offline working count not zero');
  check(document.documentElement.scrollWidth<=innerWidth,'no horizontal overflow');
  await fetch('/result',{method:'POST',body:JSON.stringify({ok:true})});
}catch(e){await fetch('/result',{method:'POST',body:JSON.stringify({error:e.message})})}
`;
(async () => {
  let finish;
  const result = new Promise(r => { finish = r; });
  const server = http.createServer(async (req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname;
    if (path === '/result') { let body=''; for await(const chunk of req)body+=chunk; finish(JSON.parse(body)); res.end('ok'); return; }
    if (path === '/api/master/sessions') { res.setHeader('Content-Type','application/json'); res.end(JSON.stringify({sessions})); return; }
    if (path === '/api/session/native-team') { const id=new URL(req.url,'http://localhost').searchParams.get('id'); res.setHeader('Content-Type','application/json'); res.end(JSON.stringify({teams:id==='one'?[{name:'Native team',members:[{id:'child',name:'Checker',role:'Review',status:'Unknown',model:'Test model'}]}]:[]})); return; }
    const file = resolve(root, '.' + path);
    if (!file.startsWith(root + '/') || !fs.existsSync(file)) { res.writeHead(404).end(); return; }
    res.setHeader('Content-Type',file.endsWith('.js')?'application/javascript':file.endsWith('.css')?'text/css':'text/html');
    const content=fs.readFileSync(file);
    res.end(path==='/dashboard.html'?content.toString().replace('</body>',`<script type="module">${fixture}</script></body>`):content);
  });
  await new Promise(r => server.listen(0,'127.0.0.1',r));
  const profile = fs.mkdtempSync(join(tmpdir(),'clideck-dashboard-ui-'));
  const browser = spawn(chrome,['--headless=new','--disable-gpu','--no-first-run','--user-data-dir='+profile,process.argv.includes('--mobile')?'--window-size=390,844':'--window-size=1440,1000',`http://127.0.0.1:${server.address().port}/dashboard.html`],{stdio:'ignore'});
  let timer;
  try { const response=await Promise.race([result,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Dashboard browser timeout')),30000)})]); assert.equal(response.ok,true,response.error); console.log('dashboard browser checks passed'); }
  finally { clearTimeout(timer);browser.kill();await new Promise(r=>browser.exitCode!==null?r():browser.once('exit',r));server.closeAllConnections();await new Promise(r=>server.close(r));await fs.promises.rm(profile,{recursive:true,force:true,maxRetries:10,retryDelay:200}); }
})().catch(e=>{console.error(e);process.exitCode=1});
