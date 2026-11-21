const assert = require('node:assert/strict');
const { roster, artifactMembers, mergeArtifacts } = require('../native-team');
const root = '01a040f2-c142-7d10-b835-04ce2075041c';
const now = Date.now();
const member = { id: 'worker', name: 'Status Checker', role: 'Reviewer', nativeThreadId: 'native-id',
  membershipType: 'reviewer', status: 'working', nativeState: 'running', nativeObservedAt: new Date(now).toISOString(), lastHeartbeatAt: new Date(now).toISOString(),
  profileAttestation: { status: 'VERIFIED', observed: { model: 'gpt-6-sol', reasoningEffort: 'high' } } };
const team = { id: 'team', sessionId: root, members: { member, lead: { membershipType: 'lead' } },
  tasks: { task: { ownerId: 'worker', status: 'in_progress', title: 'Check statuses' } }, messages: ['private'], security: { token: 'private' } };
const state = { teams: { team, other: { ...team, sessionId: 'another-root' } } };
let result = roster(state, root, now);
assert.equal(result.length, 1);
assert.equal(result[0].members.length, 1);
assert.equal(result[0].members[0].status, 'Working');
member.nativeObservedAt = new Date(now - 400000).toISOString();
assert.equal(roster(state, root, now)[0].members[0].status, 'Unknown', 'Fresh heartbeat must not revive an old native observation');
member.nativeObservedAt = new Date(now).toISOString();
assert.ok(!JSON.stringify(result).includes('private'));
assert.deepEqual(roster(state, '../bad-root'), []);
team.tasks.task.status = 'completed';
assert.equal(roster(state, root, now)[0].members[0].status, 'Working');
member.nativeState = 'waiting';
assert.equal(roster(state, root, now)[0].members[0].status, 'Idle');
member.nativeState = null;
assert.equal(roster(state, root, now)[0].members[0].status, 'Unknown');
member.lastHeartbeatAt = new Date(now - 400000).toISOString();
assert.equal(roster(state, root, now)[0].members[0].status, 'Unknown');
member.status = 'failed';
assert.equal(roster(state, root, now)[0].members[0].status, 'Failed');
member.status = 'working';
member.profileAttestation.status = 'PENDING';
assert.equal(roster(state, root, now)[0].members[0].status, 'Unverified');
const { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
let DatabaseSync;
try { ({ DatabaseSync } = require('node:sqlite')); }
catch (err) { if (err.code !== 'ERR_UNKNOWN_BUILTIN_MODULE') throw err; }
if (DatabaseSync) {
const dir = mkdtempSync(join(tmpdir(), 'clideck-native-'));
try {
  const child = '01a148f5-5e27-7d90-be82-1dd544dc38fa';
  const grandchild = '01a148f5-7bf0-7601-8965-bbac28b150b8';
  const db = new DatabaseSync(join(dir, 'state_5.sqlite'));
  db.exec('CREATE TABLE thread_spawn_edges (parent_thread_id TEXT, child_thread_id TEXT, status TEXT); CREATE TABLE threads (id TEXT, agent_nickname TEXT, agent_role TEXT, agent_path TEXT, model TEXT, reasoning_effort TEXT, updated_at_ms INTEGER, first_user_message TEXT, rollout_path TEXT);');
  const insert = db.prepare('INSERT INTO thread_spawn_edges VALUES (?, ?, ?)');
  insert.run(root, child, 'open');
  insert.run(child, grandchild, 'closed');
  insert.run(grandchild, child, 'open'); // Cycle must terminate.
  insert.run('unrelated-root', 'other-child', 'open');
  const sessionsDir = join(dir, 'sessions');
  mkdirSync(sessionsDir);
  const rollout = join(sessionsDir, `${child}.jsonl`);
  const event = (type, timestamp = new Date().toISOString()) => JSON.stringify({ timestamp, type: 'event_msg', payload: { type } }) + '\n';
  writeFileSync(rollout, event('task_started'));
  db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(child, 'Coder', null, '/root/checker', 'recorded-model', 'high', now, 'PRIVATE PROMPT', rollout);
  db.close();
  mkdirSync(join(dir, 'sqlite'));
  const rows = artifactMembers(root, dir);
  assert.equal(rows.length, 2, 'Includes closed/history, nested and metadata-less children');
  assert.equal(rows.find(row => row.id === child).status, 'Working');
  assert.equal(rows.find(row => row.id === grandchild).status, 'Unknown');
  utimesSync(rollout, new Date(now - 60000), new Date(now - 60000));
  assert.equal(artifactMembers(root, dir).find(row => row.id === child).status, 'Unknown', 'Old activity cannot imply Working');
  writeFileSync(rollout, event('task_started') + event('task_complete'));
  assert.equal(artifactMembers(root, dir).find(row => row.id === child).status, 'Finished');
  assert.equal(rows.find(row => row.id === child).name, 'checker');
  assert.ok(!JSON.stringify(rows).includes('PRIVATE'));
  assert.deepEqual(artifactMembers('../bad', dir), []);
  const merged = mergeArtifacts([{members:[{id:child}]}], rows);
  assert.equal(merged[1].members.length, 1, 'Registered native IDs are deduplicated');
  const recorded = artifactMembers(root, dir);
  const registered = [{members:[{id:child,status:'Unknown'}]}];
  mergeArtifacts(registered, recorded);
  assert.equal(registered[0].members[0].status, 'Finished', 'Recorded completion resolves stale team status');
  const unmatched = [{members:[{id:'unmatched',status:'Unknown'}]}];
  mergeArtifacts(unmatched, recorded);
  assert.equal(unmatched[0].members[0].status, 'Unknown', 'Missing rollout cannot erase Unknown');
} finally { rmSync(dir, { recursive: true, force: true }); }
} else console.log('Native SQLite history checks skipped: this Node runtime has no node:sqlite');
console.log('native team checks passed');
