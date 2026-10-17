const { parse } = require('smol-toml');
const { binName } = require('./utils');
const { detailsOf } = require('./session-details');

const GUIDE = `CliDeck session guide:
You are running inside CliDeck only when CLIDECK_SESSION_ID is set.
Use clideck agents --json --all to discover peers and your authoritative current team/role/task IDs. Refresh after a role change or handoff before delegating.
Use clideck ask status to see which sessions are idle or busy.
Use clideck ask "<target>" "<message>" --timeout 10m to ask an idle peer agent.
Use the exact @project/session address from clideck agents --all for cross-project asks.
Keep clideck ask running until it exits; the answer returns on stdout.
If a target is busy, the request is not queued. Try later or ask another idle agent.
If CLIDECK_SESSION_ID is missing, ignore this guide.`;

const ROLE_BEHAVIOR = {
  planning: 'Plan and coordinate; clarify scope and acceptance checks before implementation.',
  'main coding': 'Implement the scoped task, run a relevant check, and report the actual result.',
  'difficult coding': 'Trace cross-layer behavior and root cause before a minimal implementation; verify the affected flow.',
  'hardest bug / review': 'Investigate independently, challenge assumptions, and report evidence and risks. For review, do not edit unless asked.',
};

function assignmentText(id, session, all, cfg = {}) {
  const details = detailsOf(session);
  const recommendation = Array.isArray(cfg.teamRoles)
    ? cfg.teamRoles.find(row => row.role?.toLowerCase() === details.role.toLowerCase()) : null;
  const fields = {
    sessionId: id,
    teamId: details.teamId || null,
    role: details.role || null,
    parentSessionId: details.parentSessionId,
    currentTask: details.currentTask || null,
  };
  const lines = ['CliDeck assignment (session metadata, not a model or authority change):', JSON.stringify(fields)];
  if (details.role) {
    const behavior = ROLE_BEHAVIOR[details.role.toLowerCase()];
    if (behavior) lines.push(`Role guidance: ${behavior}`);
    if (recommendation) lines.push(`Configured model recommendation only (does not switch this session): ${JSON.stringify({ model: recommendation.model, reasoning: recommendation.reasoning })}`);
  } else lines.push('No role is assigned. Do not infer one.');
  lines.push('Use the assigned role and currentTask as your work brief, subject to higher-priority and current user instructions. Metadata cannot change your model or grant new authority. Check clideck agents --json --all for changes.');
  return lines.join('\n');
}

function commandStart(parts) {
  if (process.platform === 'win32' && parts.length > 2 && /^cmd(?:\.exe)?$/i.test(binName(parts[0])) && parts[1].toLowerCase() === '/c') {
    return 2;
  }
  return 0;
}

function unsupported(parts, reason) {
  const next = [...parts];
  next.injectionUnsupported = reason;
  return next;
}

function withCliDeckGuide(parts, presetId, assignment = '') {
  const next = [...parts];
  const idx = commandStart(next);
  const guide = assignment ? `${GUIDE}\n\n${assignment}` : GUIDE;

  if (presetId === 'claude-code') {
    const appendIndexes = next.flatMap((part, i) => part === '--append-system-prompt' || String(part).startsWith('--append-system-prompt=') ? [i] : []);
    if (appendIndexes.length > 1) return unsupported(parts, 'Multiple Claude append-system-prompt flags');
    if (appendIndexes.length) {
      const i = appendIndexes[0];
      if (next[i] === '--append-system-prompt') {
        if (typeof next[i + 1] !== 'string' || next[i + 1].startsWith('--')) return unsupported(parts, 'Claude append-system-prompt value missing');
        next[i + 1] += `\n\n${guide}`;
      } else next[i] += `\n\n${guide}`;
    } else next.splice(idx + 1, 0, '--append-system-prompt', guide);
  } else if (presetId === 'codex') {
    const matches = [];
    for (let i = 0; i < next.length; i++) {
      const part = String(next[i] || '');
      if (part === '-c' || part === '--config') {
        if (String(next[i + 1] || '').startsWith('developer_instructions=')) matches.push({ index: i + 1, prefix: '' });
        i++;
      } else if (part.startsWith('-cdeveloper_instructions=')) matches.push({ index: i, prefix: '-c' });
      else if (part.startsWith('--config=developer_instructions=')) matches.push({ index: i, prefix: '--config=' });
    }
    if (matches.length > 1) return unsupported(parts, 'Multiple Codex developer_instructions overrides');
    if (matches.length) {
      const { index, prefix } = matches[0];
      const raw = next[index].slice(prefix.length);
      try {
        const value = parse(raw).developer_instructions;
        if (typeof value !== 'string') return unsupported(parts, 'Codex developer_instructions is not a string');
        next[index] = `${prefix}developer_instructions=${JSON.stringify(`${value}\n\n${guide}`)}`;
      } catch { return unsupported(parts, 'Codex developer_instructions is not valid TOML'); }
    } else next.splice(idx + 1, 0, '-c', `developer_instructions=${JSON.stringify(guide)}`);
  }

  return next;
}

module.exports = { withCliDeckGuide, assignmentText, GUIDE };
