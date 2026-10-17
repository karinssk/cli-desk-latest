const assert = require('node:assert/strict');
const { recoveryError, continueSession } = require('../session-master');
const { handleHttp } = require('../session-master');
const { refreshScreen, failedScreen, progressKey } = require('../session-master');
const http = require('node:http');

async function check() {
  const now = Date.now();
  const outputAt = new Date(now - 10000).toISOString();
  const session = () => ({ working: false, lastOutputAt: outputAt, lastInputAt: null,
    chunks: ['tool success\n■ {"detail":"Bad Request"}\n› '] });
  assert.equal(recoveryError(session(), outputAt, now), null);
  for (const override of [{ working: true }, { working: undefined }, { presetId: 'shell' }, { _menuKey: 'approval' },
    { lastOutputAt: new Date(now).toISOString() }, { lastInputAt: outputAt },
    { chunks: ['■ {"detail":"Bad Request"}\nNew progress'] }, { chunks: ['done'] }]) {
    assert.ok(recoveryError({ ...session(), ...override }, outputAt, now));
  }
  assert.ok(recoveryError(null, outputAt, now));
  const rendered = { ...session(), presetId: 'codex', working: true, pty: { cols: 220, rows: 60 },
    chunks: ['\x1b[49;1HViewed image overlay-gauge.jpg\x1b[51;1H■ {"detail":"Bad',
      '\x1b[51;17H Request"}\x1b[54;1H› \x1b[57;3H? for shortcuts\x1b[57;186H⚠ 4 warnings · f2 to view'] };
  await refreshScreen(rendered);
  assert.equal(rendered._masterFailedScreen, true);
  assert.equal(recoveryError(rendered, outputAt, now), null);
  assert.equal(failedScreen(['■ {"detail":"Bad Request"}', '› continue']), false);
  assert.equal(failedScreen(['■ {"detail":"Bad Request"}', '› Ask Codex to do anything',
    'GPT-6-Astra medium · Context 63% used · 258K window · weekly 67% left', '? for shortcuts']), true);
  assert.equal(failedScreen(['■ {"detail":"Bad Request"}', 'Working (5s • esc to interrupt)', '›']), false);
  assert.equal(failedScreen(['■ {"detail":"Bad Request"}', 'Approve command?', '›']), false);
  rendered.chunks.push('\x1b[51;1H\x1b[2KWorking (2s • esc to interrupt)');
  await refreshScreen(rendered);
  assert.equal(rendered._masterFailedScreen, false);
  rendered.working = false;
  assert.match(recoveryError(rendered, outputAt, now), /current Codex screen/);
  rendered._masterScreen.dispose();
  const live = session();
  const map = new Map([['test', live]]);
  const toolLines = ['• Ran ffmpeg check-one.mp4', '└ (no output)', '■ {"detail":"Bad Request"}', '›'];
  const key = progressKey(toolLines);
  assert.ok(key);
  assert.equal(progressKey([...toolLines, '? for shortcuts']), key);
  assert.equal(progressKey([...toolLines.slice(0, 2), 'Working (25s • esc to interrupt)',
    'GPT-6-Astra medium · Context 70% used', '? for shortcuts', ...toolLines.slice(2)]), key);
  assert.notEqual(progressKey(toolLines.map(line => line.replace('check-one', 'check-two'))), key);
  assert.equal(progressKey(['■ {"detail":"Bad Request"}', '›']), '');
  const progressing = { ...session(), _masterProgress: key };
  map.set('progress', progressing);
  const policyApi = { getSessions: () => map, input: () => assert.fail('test dispatch must be cancelled') };
  for (let attempt = 0; attempt < 3; attempt++) {
    progressing.lastOutputAt = new Date(now - 10000 + attempt * 40000).toISOString();
    assert.equal(continueSession({ id: 'progress', expectedOutputAt: progressing.lastOutputAt }, policyApi, now + attempt * 40000).attempt, attempt + 1);
  }
  progressing.lastOutputAt = new Date(now + 110000).toISOString();
  assert.throws(() => continueSession({ id: 'progress', expectedOutputAt: progressing.lastOutputAt }, policyApi, now + 120000), /without new tool progress/);
  progressing._masterProgress = progressKey(toolLines.map(line => line.replace('check-one', 'check-two')));
  assert.equal(continueSession({ id: 'progress', expectedOutputAt: progressing.lastOutputAt }, policyApi, now + 120000).attempt, 1);
  progressing.sessionToken = 'new-agent-session';
  assert.equal(continueSession({ id: 'progress', expectedOutputAt: progressing.lastOutputAt }, policyApi, now + 120000).attempt, 1);
  progressing._menuKey = 'cancel timers';
  const sent = [];
  const api = { getSessions: () => map, input: msg => {
    sent.push(msg.data);
    live.lastInputAt = new Date().toISOString();
    // Real PTYs echo input before the delayed Enter.
    live.lastOutputAt = new Date().toISOString();
  } };
  assert.deepEqual(continueSession({ id: 'test', expectedOutputAt: outputAt }, api, now), { ok: true, attempt: 1 });
  assert.throws(() => continueSession({ id: 'test', expectedOutputAt: outputAt }, api, now));
  await new Promise(resolve => setTimeout(resolve, 550));
  assert.deepEqual(sent, ['\x1b[200~continue\x1b[201~\r']);

  const guarded = session();
  map.set('menu', guarded);
  const guardedSent = [];
  const guardedApi = { getSessions: () => map, input: msg => guardedSent.push(msg.data) };
  continueSession({ id: 'menu', expectedOutputAt: outputAt }, guardedApi, now);
  guarded._menuKey = 'approval';
  const manual = session();
  map.set('manual', manual);
  continueSession({ id: 'manual', expectedOutputAt: outputAt }, guardedApi, now);
  manual.lastInputAt = new Date(now).toISOString();
  const newOutput = session();
  map.set('new-output', newOutput);
  continueSession({ id: 'new-output', expectedOutputAt: outputAt }, guardedApi, now);
  newOutput.lastOutputAt = new Date(now).toISOString();
  await new Promise(resolve => setTimeout(resolve, 550));
  assert.equal(guardedSent.length, 0); // Approval, manual input, and new output cancel dispatch.
  const events = [];
  const server = http.createServer((req, res) => handleHttp(req, res, { ...api, broadcast: message => events.push(message), list: () => [
    { id: 'test', presetId: 'codex', startedAt: new Date().toISOString() },
    { id: 'old', presetId: 'codex', startedAt: '2020-01-01T00:00:00Z' },
    { id: 'shell', presetId: 'shell', startedAt: new Date().toISOString() },
  ] }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}`;
    const snapshot = await (await fetch(url + '/api/master/sessions')).json();
    assert.equal(snapshot.sessions[0].id, 'test');
    assert.equal(snapshot.sessions[0].recoverableError, false);
    const header = { 'X-CliDeck-Master': JSON.stringify({ recover: true, all: true, ids: [], timezone: 'Asia/Bangkok' }) };
    assert.equal((await fetch(url + '/api/master/sessions', { headers: header })).status, 200);
    assert.deepEqual(events.find(message => message.type === 'master.status').monitor.sessionIds, ['test']);
    const recovery = events.find(message => message.type === 'session.recovery' && message.id === 'test').recovery;
    assert.deepEqual([recovery.attempts, recovery.limit, recovery.lastError], [1, 3, 'Bad Request']);
    assert.equal((await fetch(url + '/api/master/sessions', { headers: { 'X-CliDeck-Master': 'invalid' } })).status, 400);
    assert.equal((await fetch(url + '/api/master/sessions', { headers: { Origin: 'http://example.com' } })).status, 403);
    assert.equal((await fetch(url + '/api/master/continue', { method: 'POST', body: '{' })).status, 400);
    assert.equal((await fetch(url + '/api/master/continue', { method: 'POST', body: 'null' })).status, 400);
    assert.equal((await fetch(url + '/api/master/continue', { method: 'POST', body: JSON.stringify({ id: 'closed' }) })).status, 409);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
  console.log('session master checks passed');
}
check().catch(error => { console.error(error); process.exitCode = 1; });
