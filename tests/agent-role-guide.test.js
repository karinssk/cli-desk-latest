const assert = require('node:assert/strict');
const { parse } = require('smol-toml');
const { withCliDeckGuide, assignmentText, GUIDE } = require('../agent-session-guide');
const { listProjectAgents } = require('../session-agents');
const { formatAgents } = require('../clideck-agents-cli');

const sessions = new Map([
  ['lead-id', { name: 'Lead', projectId: 'p', details: { teamId: 'alpha', role: 'Planning', parentSessionId: null, currentTask: 'Plan work' } }],
  ['child-id', { name: 'Coder', projectId: 'p', working: false, details: { teamId: 'alpha', role: 'Main Coding', parentSessionId: 'lead-id', currentTask: 'Fix parser\nthen test' } }],
]);
const assignment = assignmentText('child-id', sessions.get('child-id'), sessions, {
  teamRoles: [{ role: 'Main Coding', model: 'GPT-6 Luna', reasoning: 'medium' }],
});
for (const value of ['child-id', 'alpha', 'Main Coding', 'lead-id', 'Fix parser', 'recommendation only', 'does not switch']) assert.ok(assignment.includes(value));
assert.ok(assignmentText('plain', {}, sessions).includes('No role is assigned'));

const claude = withCliDeckGuide(['claude', '--system-prompt', 'User custom'], 'claude-code', assignment);
assert.deepEqual(claude.slice(-2), ['--system-prompt', 'User custom']);
assert.ok(claude[claude.indexOf('--append-system-prompt') + 1].includes(assignment));
const claudeAppend = withCliDeckGuide(['claude', '--append-system-prompt', 'Existing'], 'claude-code', assignment);
assert.ok(claudeAppend[2].startsWith('Existing\n\n'));
assert.equal(claudeAppend.filter(x => x === '--append-system-prompt').length, 1);
assert.deepEqual(withCliDeckGuide(['claude', '--append-system-prompt'], 'claude-code', assignment).slice(0, 2), ['claude', '--append-system-prompt']);
assert.ok(withCliDeckGuide(['claude', '--append-system-prompt'], 'claude-code', assignment).injectionUnsupported);

const codex = withCliDeckGuide(['codex', '-c', 'developer_instructions="User custom"'], 'codex', assignment);
assert.ok(parse(codex[2]).developer_instructions.startsWith('User custom\n\n' + GUIDE));
assert.ok(parse(codex[2]).developer_instructions.includes(assignment));
const quoted = withCliDeckGuide(['codex', '--config=developer_instructions=\'Keep # and =\''], 'codex');
assert.ok(parse(quoted[1].slice('--config='.length)).developer_instructions.startsWith('Keep # and =\n\n'));
const invalid = ['codex', '-c', 'developer_instructions=not valid toml'];
const retained = withCliDeckGuide(invalid, 'codex', assignment);
assert.deepEqual([...retained], invalid);
assert.match(retained.injectionUnsupported, /valid TOML/);

const rows = listProjectAgents('child-id', { getSessions: () => sessions }, { projects: [{ id: 'p', name: 'Project' }] });
assert.equal(rows.find(row => row.caller).id, 'child-id');
assert.equal(rows.find(row => row.caller).details.currentTask, 'Fix parser\nthen test');
assert.equal(rows.find(row => row.caller).statusKnown, true);
assert.equal(rows.find(row => !row.caller).statusKnown, false);
const human = formatAgents(rows);
for (const value of ['role="Main Coding"', 'team="alpha"', 'parent=lead-id', 'task="Fix parser then test"', 'unknown']) assert.ok(human.includes(value));
console.log('agent role guide checks passed');
