// `clideck team create <preset>`: opens a full agent team (one teamId, roles, parent = Orchestrator) in one call.
// Long-running builders get their own CliDeck sessions; short jobs (design, review, test) run as the
// Orchestrator's Claude Code subagents, which start fresh and return only a summary (cheaper).
const crypto = require('crypto');
const { sendJson, isLoopback } = require('./http-util');

const PRESETS = {
  coding: [
    { name: 'Orchestrator', role: 'Orchestrator', model: 'opus' },
    { name: 'Dev', role: 'Dev', model: 'sonnet' },
    { name: 'Dev 2', role: 'Dev', model: 'sonnet' },
  ],
};
// Compact at 200K instead of growing to 1M: every tool turn re-reads the whole context.
const TEAM_ENV = { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '200000' };

function createTeam({ preset = 'coding', projectId = null, cwd } = {}, sessionsApi, cfg) {
  const members = PRESETS[preset];
  if (!members) throw Object.assign(new Error(`Unknown team preset "${preset}". Presets: ${Object.keys(PRESETS).join(', ')}`), { status: 400 });
  const teamId = `${preset}-${crypto.randomBytes(2).toString('hex')}`;
  const taken = new Set([...sessionsApi.getSessions().values()].filter(s => (s.projectId || null) === projectId).map(s => String(s.name).toLowerCase()));
  const created = [];
  let parent = null;
  for (const m of members) {
    const name = taken.has(m.name.toLowerCase()) ? `${m.name} ${teamId.slice(-4)}` : m.name;
    const r = sessionsApi.createProgrammatic({ presetId: 'claude-code', name, projectId, cwd, args: ['--model', m.model], env: TEAM_ENV,
      details: { teamId, role: m.role, parentSessionId: parent, currentTask: '' } }, cfg);
    if (r.error) throw Object.assign(new Error(`${name}: ${r.error}${created.length ? ` (already opened: ${created.map(c => c.name).join(', ')})` : ''}`), { status: 409 });
    created.push({ id: r.id, name, role: m.role, model: m.model });
    parent ||= r.id;
  }
  return { teamId, members: created };
}

async function handleHttp(req, res, sessionsApi, getConfig) {
  try {
    if (!isLoopback(req)) throw Object.assign(new Error('Local requests only'), { status: 403 });
    let body = ''; for await (const c of req) { body += c; if (body.length > 1e4) throw Object.assign(new Error('Request too large'), { status: 413 }); }
    const p = body ? JSON.parse(body) : {};
    const caller = sessionsApi.getSessions().get(String(p.callerSessionId || ''));
    if (!caller) throw Object.assign(new Error('Caller session is not active'), { status: 404 });
    sendJson(res, 200, createTeam({ preset: p.preset || 'coding', projectId: caller.projectId || null, cwd: caller.cwd }, sessionsApi, getConfig()));
  } catch (e) { sendJson(res, e.status || 500, { error: e.message }); }
}

module.exports = { PRESETS, createTeam, handleHttp };
