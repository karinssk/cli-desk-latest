// `clideck team create <preset>`: opens a full agent team (one teamId, roles, parent = Orchestrator) in one call.
// Long-running specialists get their own CliDeck sessions; short jobs (planning, review, test) run as the
// Orchestrator's Claude Code subagents, which start fresh and return only a summary (cheaper).
const crypto = require('crypto');
const { sendJson, isLoopback } = require('./http-util');

const fs = require('fs');
const { join } = require('path');

// Members with a persona get it as an appended system prompt (personas copied from the AI Agency bot).
const PRESETS = {
  coding: [
    { name: 'Orchestrator', role: 'Orchestrator', model: 'opus' },
    { name: 'Dev', role: 'Dev', model: 'sonnet' },
    { name: 'Dev 2', role: 'Dev', model: 'sonnet' },
  ],
  hardware: [
    { name: 'Orchestrator', role: 'Orchestrator', model: 'opus' },
    { name: 'Volt', role: 'Electronics', model: 'fable', effort: 'high', persona: 'engineering-electronics-pcb-engineer',
      note: 'Before delivering a schematic or PCB meant for fabrication: run KiCad ERC/DRC, then have a fresh reviewer subagent (model fable) check it, and fix what it finds (at most 2 rounds). Check every part number and pinout against its datasheet.' },
    { name: 'Forge', role: 'Mechanical', model: 'sonnet', persona: 'engineering-mechanical-3d-designer' },
  ],
  marketing: [
    { name: 'Orchestrator', role: 'Orchestrator', model: 'opus' },
    { name: 'Growth', role: 'Growth', model: 'sonnet', persona: 'marketing-growth-hacker' },
    { name: 'Content', role: 'Content', model: 'sonnet', persona: 'marketing-content-creator' },
    { name: 'Social', role: 'Social', model: 'sonnet', persona: 'marketing-social-media-strategist' },
    { name: 'SEO', role: 'SEO', model: 'sonnet', persona: 'marketing-seo-specialist' },
    { name: 'TikTok', role: 'TikTok', model: 'sonnet', persona: 'marketing-tiktok-strategist' },
  ],
};
const MEMBER_NOTE = 'You are a member of a CliDeck team. Take tasks from your Orchestrator (your parent session), do only the brief, save deliverables as files in the working folder, and report what you made with ATTACH lines. Ask the Orchestrator if the brief is unclear. Never publish, post, send messages or spend money unless the brief says the user approved it.';
const persona = name => fs.readFileSync(join(__dirname, 'team-personas', `${name}.md`), 'utf8').replace(/\r\n/g, '\n').replace(/^---\n[\s\S]*?\n---\n/, '').trim();

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
    const r = sessionsApi.createProgrammatic({ presetId: 'claude-code', name, projectId, cwd, args: ['--model', m.model, ...(m.effort ? ['--effort', m.effort] : []), ...(m.persona ? ['--append-system-prompt', [MEMBER_NOTE, m.note, persona(m.persona)].filter(Boolean).join('\n\n')] : [])], env: TEAM_ENV,
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
    const cfg = getConfig();
    let where;
    if (p.project) { // --project <name-or-id>: open in that CliDeck project's folder, from anywhere
      const project = require('./session-ask').resolveProject(Array.isArray(cfg.projects) ? cfg.projects : [], p.project);
      if (!project.path) throw Object.assign(new Error(`Project "${project.name}" has no folder`), { status: 400 });
      where = { projectId: project.id, cwd: project.path };
    } else {
      const caller = sessionsApi.getSessions().get(String(p.callerSessionId || ''));
      if (!caller) throw Object.assign(new Error('Caller session is not active. Run inside a CliDeck session or pass --project <name>.'), { status: 404 });
      where = { projectId: caller.projectId || null, cwd: caller.cwd };
    }
    sendJson(res, 200, createTeam({ preset: p.preset || 'coding', ...where }, sessionsApi, cfg));
  } catch (e) { sendJson(res, e.status || 500, { error: e.message }); }
}

module.exports = { PRESETS, createTeam, handleHttp };
