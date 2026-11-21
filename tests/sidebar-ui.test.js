const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const { join, resolve } = require('node:path');
const { tmpdir } = require('node:os');
const { spawn } = require('node:child_process');
const { DEFAULT_TEAM_ROLES } = require('../session-details');

const chrome = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
if (!fs.existsSync(chrome)) {
  console.log('Sidebar browser check skipped; set CHROME_BIN to run it.');
  process.exit(0);
}
const root = resolve(__dirname, '..', 'public');
const fixture = `
import { state } from '/js/state.js';
import * as sidebar from '/js/monitor-sidebar.js';
const check = (value, message) => { if (!value) throw new Error(message); };
try {
  const sent = [];
  state.ws = { readyState: WebSocket.OPEN, send: raw => sent.push(JSON.parse(raw)) };
  state.cfg.projects = [{id:'project',name:'Example project'}];
  state.cfg.teamRoles = ${JSON.stringify(DEFAULT_TEAM_ROLES)};
  sidebar.refreshRoleDefaults();
  const peer = role => ({name:'Same name',projectId:'project',statusKnown:true,working:false,
    details:{teamId:'test-team',role,parentSessionId:null,currentTask:'Task'},monitor:{model:'Test model',contextTokens:25,contextWindow:100}});
  state.terms.set('one',peer('Developer'));
  state.terms.set('two',peer('Reviewer'));
  state.active = 'one';
  sidebar.initializeSessionMonitor(id => { state.active = id; sidebar.renderSessionMonitor(); });
  document.getElementById('monitor-toggle').click();
  check(document.getElementById('monitor-role').textContent === 'Developer','role belongs to selected session');
  check(document.querySelectorAll('#monitor-team button').length === 2,'team renders duplicate names as two sessions');
  state.terms.get('one').nativeTeams = [{name:'Actual chat team',members:[{id:'native-child',name:'Status Checker',role:'Reviewer',model:'gpt-6-sol',reasoning:'high',status:'Working'}]}];
  sidebar.renderSessionMonitor();
  check(!document.getElementById('monitor-native-team').hidden,'native helpers visible');
  check(document.querySelector('[data-native-id="native-child"] .agent-state').textContent === 'Working','native helper real status');
  state.terms.get('one').nativeTeams[0].members.push({id:'done-child',name:'UI Reviewer',role:'Reviewer',status:'Finished',lastSeenAt:'2026-10-17T08:49:09Z'});
  sidebar.renderSessionMonitor();
  check([...document.querySelectorAll('.monitor-native-group')].map(row => row.textContent).join(' ').includes('History · 1'),'finished helper is separated into history');
  check(document.querySelector('[data-native-id="done-child"] .agent-info').textContent.includes('Last report:'),'helper report time is visible');
  check(!document.querySelector('#monitor-native-members button'),'native helpers do not fake terminal links');
  state.terms.get('one').working = true;
  sidebar.renderSessionMonitor();
  check(document.querySelector('#monitor-team [data-session-id="one"] .agent-state').dataset.status === 'Working','working teammate has live colored state');
  check(document.querySelector('#monitor-team [data-session-id="two"] .agent-state').textContent === 'Idle','idle teammate state');
  check(document.getElementById('monitor-team-summary').textContent.includes('1 working'),'team working count');
  check(document.getElementById('monitor-status').dataset.status === 'Working','selected card live state');
  state.terms.get('one').working = false;
  state.terms.get('two').statusKnown = false;
  sidebar.renderSessionMonitor();
  check(document.querySelector('#monitor-team [data-session-id="two"] .agent-state').textContent === 'Unknown','unknown is not invented idle');
  state.terms.get('two').statusKnown = true;
  for (const entry of state.terms.values()) entry.details.teamId = '';
  state.terms.set('unrelated',{...peer('Developer'),projectId:'other',details:{teamId:''}});
  sidebar.renderSessionMonitor();
  check(document.getElementById('monitor-team-heading').textContent.includes('no team assigned'),'project fallback labeled honestly');
  check(document.querySelectorAll('#monitor-team button').length === 2,'unassigned project sessions visible without unrelated projects');
  state.terms.delete('unrelated');
  for (const entry of state.terms.values()) entry.details.teamId = 'test-team';
  sidebar.renderSessionMonitor();
  document.querySelector('#monitor-team [data-session-id="two"]').click();
  check(state.active === 'two','teammate opens exact ID');
  if (matchMedia('(max-width: 700px)').matches) check(document.activeElement.dataset.sessionId === 'two','mobile team navigation keeps sidebar focus');
  check(document.getElementById('monitor-role').textContent === 'Reviewer','role changes on selection');
  check(document.getElementById('monitor-context').textContent.includes('25.0%'),'context percent');
  check(document.getElementById('monitor-master').textContent === 'Not reported','no invented master state');
  const form = document.getElementById('monitor-assignment-form');
  form.elements.currentTask.value = '<img src=x onerror=alert(1)>\\nKeep multiline';
  form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
  const update = sent.find(message => message.type === 'session.details.update');
  check(update.id === 'two' && update.details.parentSessionId === null,'save targets exact session with no parent');
  sidebar.setSessionDetails('two',update.details,'main');
  check(document.getElementById('monitor-assignment-message').textContent === 'Saving…','GET cannot acknowledge save');
  sidebar.assignmentResult({requestId:'wrong'});
  check(document.getElementById('monitor-assignment-message').textContent === 'Saving…','wrong ack ignored');
  sidebar.assignmentResult({requestId:update.requestId});
  check(document.getElementById('monitor-assignment-message').textContent === 'Assignment saved.','correlated ack');
  check(document.getElementById('monitor-task').textContent.startsWith('<img'),'task text preserved');
  check(!document.querySelector('#monitor-task img'),'task text cannot inject HTML');
  state.masterMonitor = {seenAt:Date.now(),recover:true,sessionIds:['two']};
  state.terms.get('two').recovery = {attempts:1,limit:3,lastError:'Bad Request'};
  sidebar.renderSessionMonitor();
  check(document.getElementById('monitor-recovery-enabled').textContent === 'On','actual monitor assignment');
  check(document.getElementById('monitor-retries').textContent.startsWith('1 / 3'),'actual retry count');
  state.masterMonitor.seenAt -= 30000;
  sidebar.renderSessionMonitor();
  check(document.getElementById('monitor-master').textContent === 'Disconnected','heartbeat expires');
  state.terms.get('two').details.role = 'Main Coding';
  sidebar.renderSessionMonitor();
  check(document.getElementById('monitor-recommendation').textContent === 'GPT-6 Luna · medium','default role recommendation');
  check(document.getElementById('monitor-model').textContent === 'Test model','recommendation does not change actual model');
  document.getElementById('monitor-role-defaults').open = true;
  await new Promise(resolve => setTimeout(resolve,0));
  check(document.querySelectorAll('#monitor-role-default-rows fieldset').length === 4,'four editable role steps');
  document.querySelector('#monitor-role-default-rows [name="model"]').value = 'Custom model';
  document.getElementById('monitor-role-defaults-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
  const defaultsUpdate = sent.find(message => message.type === 'config.update');
  check(defaultsUpdate.config.teamRoles[0].model === 'Custom model','edited model saved');
  check(Object.keys(defaultsUpdate.config).length === 1,'defaults do not overwrite unrelated settings');
  state.cfg.teamRoles = defaultsUpdate.config.teamRoles;
  sidebar.refreshRoleDefaults();
  check(document.getElementById('monitor-role-defaults-message').textContent === 'Role defaults saved.','save confirmed by server config');
  document.getElementById('monitor-toggle').click();
  check(document.getElementById('session-monitor').hidden,'panel collapses');
  await fetch('/result',{method:'POST',body:JSON.stringify({ok:true})});
} catch(error) { await fetch('/result',{method:'POST',body:JSON.stringify({error:error.message})}); }
`;

async function main() {
  let finish;
  const result = new Promise(resolve => { finish = resolve; });
  const server = http.createServer(async (req, res) => {
    if (req.url === '/result') {
      let body = '';
      for await (const chunk of req) body += chunk;
      finish(JSON.parse(body));
      res.end('ok');
      return;
    }
    if (req.url === '/js/app.js') { res.setHeader('Content-Type','application/javascript'); res.end(fixture); return; }
    const file = resolve(root, '.' + (req.url === '/' ? '/index.html' : req.url));
    if (!file.startsWith(root + '/') || !fs.existsSync(file)) { res.writeHead(404).end(); return; }
    res.setHeader('Content-Type',file.endsWith('.js') ? 'application/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html');
    res.end(fs.readFileSync(file));
  });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  const profile = fs.mkdtempSync(join(tmpdir(),'clideck-sidebar-ui-'));
  const browser = spawn(chrome,['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check',
    '--user-data-dir=' + profile,process.argv.includes('--mobile') ? '--window-size=600,900' : '--window-size=1440,1000',`http://127.0.0.1:${server.address().port}`],{stdio:['ignore','ignore','pipe']});
  let browserErrors = '';
  browser.stderr.on('data', chunk => { browserErrors = (browserErrors + chunk).slice(-4000); });
  let timer;
  try {
    const response = await Promise.race([result,new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Sidebar browser check timed out: ' + browserErrors)),30000); })]);
    assert.equal(response.ok,true,response.error);
    console.log('sidebar browser checks passed');
  } finally {
    clearTimeout(timer);
    browser.kill('SIGTERM');
    await new Promise(resolve => browser.once('exit',resolve));
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await fs.promises.rm(profile,{recursive:true,force:true,maxRetries:10,retryDelay:200});
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
