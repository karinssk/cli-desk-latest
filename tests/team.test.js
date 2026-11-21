// team.js: one teamId, parent = Orchestrator, per-member model, name collisions, unknown preset.
const assert = require('node:assert/strict');
const { createTeam } = require('../team');
const { assignmentText } = require('../agent-session-guide');

const sessions = new Map([['x', { name: 'Dev', projectId: 'p1' }]]);
const calls = [];
const api = { getSessions: () => sessions, createProgrammatic: o => { calls.push(o); const id = `id${calls.length}`; sessions.set(id, { name: o.name, projectId: o.projectId }); return { id }; } };

const r = createTeam({ preset: 'coding', projectId: 'p1', cwd: '/tmp' }, api, {});
assert.equal(r.members.length, 3);
assert.ok(calls.every(c => c.details.teamId === r.teamId && c.cwd === '/tmp' && c.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW === '200000'));
assert.equal(calls[0].details.parentSessionId, null);
assert.ok(calls.slice(1).every(c => c.details.parentSessionId === 'id1'));
assert.deepEqual(calls.map(c => c.args[1]), ['opus', 'sonnet', 'sonnet']);
assert.equal(r.members[1].name, `Dev ${r.teamId.slice(-4)}`); // "Dev" already taken in p1
assert.equal(r.members[2].name, 'Dev 2');
assert.throws(() => createTeam({ preset: 'nope' }, api, {}), /Unknown team preset/);
assert.match(assignmentText('id1', { details: calls[0].details }), /Role guidance: You lead this team/);
assert.match(assignmentText('id2', { details: calls[1].details }), /Role guidance: Builder on this team/);
// Specialist presets: persona appended to the system prompt, frontmatter stripped; Orchestrator has none.
calls.length = 0;
const hw = createTeam({ preset: 'hardware', projectId: 'p2', cwd: '/tmp' }, api, {});
assert.deepEqual(hw.members.map(m => `${m.name}/${m.model}`), ['Orchestrator/opus', 'Volt/fable', 'Forge/sonnet']);
assert.ok(!calls[0].args.includes('--append-system-prompt'));
const sp = calls[1].args[calls[1].args.indexOf('--append-system-prompt') + 1];
assert.match(sp, /member of a CliDeck team/);
assert.ok(!sp.includes('\n---\n') && !sp.startsWith('---'));
assert.equal(createTeam({ preset: 'marketing', projectId: 'p3', cwd: '/tmp' }, api, {}).members.length, 6);
console.log('team tests passed');
