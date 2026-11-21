const assert = require('node:assert/strict');
const { detailsOf, validateUpdate, DEFAULT_TEAM_ROLES, validateTeamRoles } = require('../session-details');
assert.equal(validateTeamRoles(DEFAULT_TEAM_ROLES)[1].reasoning, 'medium');
assert.equal(validateTeamRoles(DEFAULT_TEAM_ROLES)[2].reasoning, 'high');
assert.equal(validateTeamRoles([{ role: ' Custom ', model: 'GPT-6 Sol', reasoning: 'high' }])[0].role, 'Custom');
for (const rows of [[], [{role:'x',model:'m',reasoning:'invalid'}], [...DEFAULT_TEAM_ROLES, DEFAULT_TEAM_ROLES[0]],
  [{role:'x\n',model:'m',reasoning:''}], [{role:'x',model:'',reasoning:''}]]) assert.throws(() => validateTeamRoles(rows));

const all = new Map([
  ['root', { details: { teamId: 'team one', role: 'lead', parentSessionId: null, currentTask: '' } }],
  ['child', { details: { teamId: 'team one', role: '', parentSessionId: 'root', currentTask: '' } }],
  ['other', { details: { teamId: 'team two', role: '', parentSessionId: null, currentTask: '' } }],
]);

assert.deepEqual(detailsOf({}), { teamId: '', role: '', parentSessionId: null, currentTask: '' });
assert.equal(validateUpdate('child', { currentTask: 'implement sidebar' }, all).parentSessionId, 'root');
assert.equal(validateUpdate('other', { teamId: 'team one', parentSessionId: 'child' }, all).parentSessionId, 'child');
assert.equal(validateUpdate('root', { teamId: '  team one  ', role: ' lead ' }, all).teamId, 'team one');
assert.equal(validateUpdate('root', { currentTask: 'first\r\n\tsecond\rthird' }, all).currentTask, 'first\n\tsecond\nthird');
for (const patch of [null, [], {}, { unknown: 'x' }, { role: 3 }, { currentTask: 'x'.repeat(2001) },
  { role: 'r'.repeat(81) }, { teamId: 't'.repeat(101) }, { teamId: 'x\n' }, { currentTask: 'x\0' },
  { currentTask: 'x\x1b' }, { parentSessionId: 'x'.repeat(201) },
  { parentSessionId: 4 }, { parentSessionId: 'child' }, { parentSessionId: 'missing' },
  { parentSessionId: 'other' }]) {
  assert.throws(() => validateUpdate('child', patch, all), Error);
}
assert.throws(() => validateUpdate('root', { parentSessionId: 'child' }, all), /cycle/);
assert.throws(() => validateUpdate('root', { teamId: 'new team' }, all), /Team cannot change/);
assert.throws(() => validateUpdate('missing', { role: 'x' }, all), /not found/);
console.log('session details checks passed');

const { mkdtempSync, readFileSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const dataDir = mkdtempSync(join(tmpdir(), 'clideck-details-'));
require.cache[require.resolve('../paths')] = { exports: { DATA_DIR: dataDir } };
require.cache[require.resolve('node-pty')] = { exports: { spawn: () => ({
  writes: [], write(data) { this.writes.push(data); }, onData() {}, onExit(fn) { this.exit = fn; }, kill() { queueMicrotask(() => this.exit()); },
}) } };
const sessions = require('../sessions');
const cfg = { commands: [{ id: 'test', label: 'Test', command: '/bin/sh', canResume: true, resumeCommand: '/bin/sh' }], defaultPath: process.cwd() };
const ws = { send(message) { throw new Error(message); } };

async function lifecycle() {
  try {
    const { id } = sessions.createProgrammatic({ commandId: 'test', name: 'Lifecycle' }, cfg);
    assert.ok(id);
    sessions.startAutoSave(() => cfg);
    sessions.getSessions().get(id).sessionToken = 'resume-token';
    sessions.updateDetails(id, { teamId: 'team', role: 'lead', currentTask: 'line one\nline two' }, cfg);
    let saved = JSON.parse(readFileSync(join(dataDir, 'sessions.json'), 'utf8'));
    assert.equal(saved[0].details.currentTask, 'line one\nline two');
    sessions.restart({ id }, ws, cfg);
    await Promise.resolve(); // Old PTY exit must not remove its replacement.
    assert.equal(sessions.getSessions().get(id).details.role, 'lead');
    sessions.getSessions().get(id).pty.exit();
    assert.equal(sessions.getResumable()[0].details.role, 'lead');
    saved = JSON.parse(readFileSync(join(dataDir, 'sessions.json'), 'utf8'));
    assert.equal(saved[0].details.role, 'lead');
    sessions.loadSessions();
    sessions.resume({ id }, ws, cfg);
    assert.equal(sessions.getSessions().get(id).details.currentTask, 'line one\nline two');
    assert.equal(sessions.list()[0].details.teamId, 'team');
    const live = sessions.getSessions().get(id);
    assert.equal(live.assignmentDelivery, 'Metadata only (not an AI session)');
    live.presetId = 'codex';
    sessions.updateDetails(id, { role: 'Main Coding' }, cfg);
    assert.equal(live.pty.writes.length, 0);
    live.working = true;
    sessions.input({ id, data: '\r' });
    assert.equal(live.pty.writes.pop(), '\r');
    assert.equal(live.assignmentDelivery, 'Pending next message');
    live.working = false;
    live._menuKey = 'approval';
    sessions.input({ id, data: '\r' });
    assert.equal(live.pty.writes.pop(), '\r');
    assert.equal(live.assignmentDelivery, 'Pending next message');
    live.working = undefined;
    sessions.input({ id, data: '\r', skipAssignment: true });
    assert.equal(live.pty.writes.pop(), '\r');
    assert.equal(live.assignmentDelivery, 'Pending next message');
    sessions.updateDetails(id, { currentTask: 'Latest brief' }, cfg);
    sessions.input({ id, data: '\x1b[200~continue\x1b[201~\r' });
    const delivered = live.pty.writes.pop();
    assert.ok(delivered.startsWith('\x1b[200~continue\x1b[201~'));
    assert.ok(delivered.includes('Latest brief'));
    assert.ok(delivered.endsWith('\r'));
    assert.equal(live.assignmentDelivery, 'Submitted with message');
    sessions.input({ id, data: '\r' });
    assert.equal(live.pty.writes.pop(), '\r');
    sessions.refreshRoleNotices(cfg); // same text as already delivered: nothing pasted into the next message
    sessions.input({ id, data: '\r' });
    assert.equal(live.pty.writes.pop(), '\r');
    sessions.updateDetails(id, { role: '', currentTask: '', teamId: '' }, cfg);
    sessions.input({ id, data: '\r' });
    assert.ok(live.pty.writes.pop().includes('No role is assigned'));
  } finally {
    sessions.shutdown(cfg);
    await Promise.resolve();
    rmSync(dataDir, { recursive: true, force: true });
  }
}
lifecycle().then(() => console.log('session details lifecycle checks passed')).catch(err => { console.error(err); process.exitCode = 1; });
