const { readFile } = require('node:fs/promises');
const { join, sep } = require('node:path');
const { homedir } = require('node:os');
const { existsSync, realpathSync, openSync, closeSync, fstatSync, readSync } = require('node:fs');
const { sendJson, isLoopback } = require('./http-util');

const label = value => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 200) : '';
const uuid = value => /^[0-9a-f-]{36}$/i.test(value || '');

function rolloutStatus(file, codexHome, now = Date.now()) {
  if (!file || !realpathSync(file).startsWith(realpathSync(join(codexHome, 'sessions')) + sep)) return null;
  const fd = openSync(file, 'r');
  try {
    const stat = fstatSync(fd);
    // ponytail: inspect only the latest 1 MiB; a longer silent turn stays Unknown
    // until Codex exposes a direct live status feed or a persistent event index.
    const size = Math.min(stat.size, 1024 * 1024);
    const buffer = Buffer.alloc(size);
    let read = 0;
    while (read < size) {
      const bytes = readSync(fd, buffer, read, size - read, stat.size - size + read);
      if (!bytes) break;
      read += bytes;
    }
    const lines = buffer.toString('utf8', 0, read).split('\n');
    if (size < stat.size) lines.shift();
    for (let i = lines.length - 1; i >= 0; i--) {
      let event;
      try { event = JSON.parse(lines[i]); } catch { continue; }
      if (event.type !== 'event_msg') continue;
      if (event.payload?.type === 'task_complete') return { status: 'Finished', lastSeenAt: event.timestamp };
      if (event.payload?.type === 'task_started') return {
        status: now - stat.mtimeMs <= 30000 ? 'Working' : 'Unknown',
        lastSeenAt: new Date(stat.mtimeMs).toISOString(),
      };
    }
  } finally { closeSync(fd); }
  return null;
}

function artifactMembers(rootId, codexHome = join(homedir(), '.codex')) {
  if (!uuid(rootId)) return [];
  const members = new Map();
  for (const file of [join(codexHome, 'state_5.sqlite'), join(codexHome, 'sqlite', 'state_5.sqlite')]) {
    if (!existsSync(file)) continue;
    // ponytail: Codex state_5 metadata schema only; add a schema adapter if a
    // future Codex migration changes the spawn-edge or public thread columns.
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      const rows = db.prepare(`WITH RECURSIVE children(id) AS (
        SELECT child_thread_id FROM thread_spawn_edges WHERE parent_thread_id = ?
        UNION SELECT e.child_thread_id FROM thread_spawn_edges e JOIN children c ON e.parent_thread_id = c.id
      ) SELECT c.id, t.agent_nickname, t.agent_role, t.agent_path, t.model, t.reasoning_effort, t.rollout_path
        FROM children c LEFT JOIN threads t ON t.id = c.id`).all(rootId);
      for (const row of rows) {
        if (!uuid(row.id) || row.id === rootId || members.has(row.id)) continue;
        let activity = null;
        try { activity = rolloutStatus(row.rollout_path, codexHome); } catch { /* Keep unknown when a rollout is unavailable. */ }
        members.set(row.id, { id: row.id, name: label(row.agent_path?.split('/').pop() || row.agent_nickname || row.id.slice(0, 8)),
          role: label(row.agent_role) || 'Native helper', model: label(row.model), reasoning: label(row.reasoning_effort),
          status: activity?.status || 'Unknown', task: '', source: activity ? 'Codex turn events' : 'Codex recorded metadata (not model attestation)',
          lastSeenAt: activity?.lastSeenAt || null });
      }
    } finally { db.close(); }
  }
  return [...members.values()];
}

function mergeArtifacts(teams, members) {
  const recorded = new Map(members.map(member => [member.id, member]));
  const registered = new Set(teams.flatMap(team => team.members.map(member => {
    const artifact = recorded.get(member.id);
    if (member.status === 'Unknown' && artifact && artifact.status !== 'Unknown') {
      member.status = artifact.status;
      member.lastSeenAt = artifact.lastSeenAt;
      member.source = artifact.source;
    }
    return member.id;
  })));
  const extra = members.filter(member => !registered.has(member.id));
  return extra.length ? [...teams, { id: 'native-history', name: 'Native spawn history', members: extra }] : teams;
}

function roster(state, rootId, now = Date.now()) {
  if (!uuid(rootId)) return [];
  return Object.values(state.teams || {}).filter(team => team.sessionId === rootId).map(team => ({
    id: label(team.id), name: label(team.phase?.alias || team.phase?.name || team.id),
    members: Object.values(team.members || {}).filter(member => member.membershipType !== 'lead').map(member => {
      const profile = member.profileAttestation;
      const fresh = now - Date.parse(member.lastHeartbeatAt) <= (team.settings?.heartbeatTimeoutSeconds || 300) * 1000;
      const observedAge = now - Date.parse(member.nativeObservedAt);
      const nativeFresh = observedAge >= 0 && observedAge <= (team.settings?.heartbeatTimeoutSeconds || 300) * 1000;
      const tasks = Object.values(team.tasks || {}).filter(task => task.ownerId === member.id);
      let status = 'Unknown';
      if (member.status === 'failed' || member.nativeState === 'failed') status = 'Failed';
      else if (member.status === 'stopped' || member.nativeState === 'stopped') status = 'Stopped';
      else if (profile?.status !== 'VERIFIED') status = 'Unverified';
      else if (fresh && nativeFresh) {
        if (['awaiting_decision', 'awaiting_plan_approval', 'shutdown_requested'].includes(member.status)) status = 'Waiting for input';
        else if (member.nativeState === 'waiting') status = 'Idle';
        else if (member.nativeState === 'running') status = 'Working';
      }
      return { id: label(member.nativeThreadId || member.id), name: label(member.name), role: label(member.role),
        model: label(profile?.observed?.model), reasoning: label(profile?.observed?.reasoningEffort), status,
        task: label(tasks.find(task => task.status === 'in_progress')?.title), source: 'Codex Teams reported native state', lastSeenAt: member.lastHeartbeatAt || null };
    }),
  })).filter(team => team.members.length);
}

async function handleHttp(req, res, sessionsApi) {
  if (!isLoopback(req)) { sendJson(res, 403, { error: 'Local requests only' }); return; }
  const id = new URL(req.url, 'http://127.0.0.1').searchParams.get('id');
  const session = sessionsApi.getSessions().get(id);
  if (!session) { sendJson(res, 404, { error: 'Session not active' }); return; }
  const directory = process.env.CODEX_TEAMS_DATA_DIR || (process.env.PLUGIN_DATA
    ? join(process.env.PLUGIN_DATA, 'codex-teams') : join(homedir(), '.codex', 'codex-teams'));
  let teams = [], warning = null;
  try { teams = roster(JSON.parse(await readFile(join(directory, 'state-v1.json'), 'utf8')), session.sessionToken); }
  catch (err) { if (err.code !== 'ENOENT') warning = 'Team coordination metadata unavailable'; }
  try { teams = mergeArtifacts(teams, artifactMembers(session.sessionToken, session._codexHome)); }
  catch { warning = 'Native spawn history unavailable'; }
  sendJson(res, 200, { teams, warning });
}

module.exports = { roster, artifactMembers, mergeArtifacts, handleHttp };
