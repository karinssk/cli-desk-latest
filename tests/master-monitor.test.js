const assert = require('node:assert/strict');
const http = require('http');
const { spawn } = require('child_process');
const { WebSocketServer } = require('ws');
const master = require('../clideck-master-cli');

const opts = master.parseArgs(['--recover', '--session', 'one', '--session', 'two']);
assert.deepEqual(opts.sessions, ['one', 'two']);
assert.throws(() => master.parseArgs(['--recover']), /requires --session/);
assert.throws(() => master.parseArgs(['--recover', '--all', '--session', 'one']), /Choose --all/);
assert.deepEqual(master.classifyLine('■ {"detail":"Bad Request"}'), { kind: 'bad-request' });
assert.equal(master.classifyLine('log: ■ {"detail":"Bad Request"}'), null);
assert.deepEqual(master.classifyLine('[CLIDECK:DONE]'), { kind: 'marker', value: 'DONE' });
assert.equal(master.classifyLine('The marker is [CLIDECK:DONE]'), null);
const eofError = master.newEvidence();
master.observeOutput(eofError, '■ {"detail":"Bad Request"}');
assert.equal(eofError.error, true);
assert.equal(master.classifyLine('"[CLIDECK:DONE]"'), null);
assert.equal(master.safeSnippet('\x1b[31mtoken=abc123\x1b[0m\n'), 'token=[redacted]');
const split = master.newEvidence();
master.observeOutput(split, '■ {"detail":"Bad ', Date.now());
assert.equal(split.error, false);
master.observeOutput(split, 'Request"}\r\n', Date.now());
assert.equal(split.error, true);
const redraw = master.newEvidence();
master.observeOutput(redraw, '\x1b[51;1H■ {"detail":"Bad Request"}\r\n\x1b[54;1H› \r\n\x1b[60;1H? for shortcuts');
assert.equal(redraw.error, false);

const now = Date.now();
const outputAt = new Date(now - 6000).toISOString();
const session = { id: 'one', working: false, statusKnown: true, menu: undefined, lastInputAt: null, lastOutputAt: outputAt };
const ev = master.newEvidence();
master.observeOutput(ev, '■ {"detail":"Bad Request"}\r\n› ', now - 6000);
const state = { attempts: 0, lastAttemptAt: -Infinity, attemptedOutputAt: null, pending: false };
const policy = { recover: true, all: false, sessions: ['one'], live: true };
assert.equal(master.recoveryDecision({ ...session, statusKnown: false, recoverableError: true }, ev, state, policy, now), 'recover');
assert.equal(master.recoveryDecision(session, ev, state, policy, now), 'recover');
assert.equal(master.recoveryDecision({ ...session, working: true }, ev, state, policy, now), 'not-idle');
assert.equal(master.recoveryDecision({ ...session, working: true, recoverableError: true }, master.newEvidence(), state, policy, now), 'recover');
assert.equal(master.recoveryDecision({ ...session, working: true, recoverableError: false }, ev, state, policy, now), 'not-idle');
assert.equal(master.recoveryDecision({ ...session, working: true, recoverableError: true, menu: ['Approve'] }, ev, state, policy, now), 'menu-active');
assert.equal(master.recoveryDecision({ ...session, working: true, recoverableError: true, lastInputAt: outputAt }, ev, state, policy, now), 'input-after-error');
assert.equal(master.recoveryDecision({ ...session, working: true, recoverableError: true, lastOutputAt: new Date(now).toISOString() }, ev, state, policy, now), 'waiting-to-settle');
assert.equal(master.recoveryDecision({ ...session, statusKnown: false }, ev, state, policy, now), 'not-idle');
assert.equal(master.recoveryDecision({ ...session, menu: ['Approve'] }, ev, state, policy, now), 'menu-active');
assert.equal(master.recoveryDecision(session, ev, state, { ...policy, live: false }, now), 'live-feed-unavailable');
state.attempts = 3;
state.progress = 'same-tool';
assert.equal(master.recoveryDecision({ ...session, recoveryEpoch: 'new-session' }, ev, state, policy, now), 'recover');
assert.equal(state.attempts, 0);
state.attempts = 3;
state.progress = 'same-tool';
assert.equal(master.recoveryDecision({ ...session, recoveryProgress: 'same-tool' }, ev, state, policy, now), 'retry-limit');
assert.equal(master.recoveryDecision({ ...session, recoveryProgress: 'new-tool' }, ev, state, policy, now), 'recover');
assert.equal(state.attempts, 0);
state.attempts = 3;
assert.equal(master.recoveryDecision(session, ev, state, policy, now), 'retry-limit');
state.attempts = 0;
master.observeOutput(ev, 'Working again\n', now);
assert.equal(master.recoveryDecision(session, ev, state, policy, now), 'no-current-error');

async function integration() {
  const posts = [];
  const fake = { ...session, working: true, recoverableError: true, name: 'Verified', presetId: 'codex', startedAt: new Date().toISOString() };
  const busy = { ...fake, id: 'two', recoverableError: false, name: 'Unverified' };
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/master/sessions') return res.end(JSON.stringify({ sessions: [fake, busy] }));
    if (req.url === '/api/master/continue') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        posts.push(JSON.parse(body));
        res.end('{"ok":true}');
      });
      return;
    }
    res.statusCode = 404;
    res.end('{}');
  });
  const wss = new WebSocketServer({ server });
  wss.on('connection', ws => {
    ws.send(JSON.stringify({ type: 'sessions', list: [fake, busy] }));
    ws.send(JSON.stringify({ type: 'output', id: 'one', data: '\x1b[51;1H■ {"detail":"Bad Request"}\r\n\x1b[54;1H› \r\n\x1b[60;1H? for shortcuts', replay: true }));
    ws.send(JSON.stringify({ type: 'output', id: 'two', data: '■ {"detail":"Bad Request"}\r\n› ', replay: true }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const child = spawn(process.execPath, ['-e', 'require("./clideck-master-cli").run(process.argv.slice(1))', '--', '--recover', '--session', 'one', '--session', 'two', '--url', `http://127.0.0.1:${server.address().port}`], { cwd: require('path').join(__dirname, '..'), stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  try {
    const deadline = Date.now() + 8000;
    while (!stdout.includes('recovery accepted by server') && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
    await new Promise(resolve => setTimeout(resolve, 250));
    assert.deepEqual(posts, [{ id: 'one', expectedOutputAt: outputAt }], `expected only verified recovery; stdout=${stdout} stderr=${stderr}`);
    assert.match(stdout, /failed\/recoverable \(working flag stale\)/);
    assert.match(stdout, /recovery accepted by server/);
  } finally {
    child.kill('SIGTERM');
    await new Promise(resolve => child.once('exit', resolve));
    await new Promise(resolve => wss.close(resolve));
    await new Promise(resolve => server.close(resolve));
  }
}

integration().then(() => console.log('master monitor check passed')).catch(error => { console.error(error); process.exitCode = 1; });
