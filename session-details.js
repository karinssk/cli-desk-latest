const EMPTY_DETAILS = Object.freeze({ teamId: '', role: '', parentSessionId: null, currentTask: '' });
const LIMITS = { teamId: 100, role: 80, currentTask: 2000 };
const DEFAULT_TEAM_ROLES = [
  { role: 'Planning', model: 'GPT-6 Astra', reasoning: '' },
  { role: 'Main Coding', model: 'GPT-6 Luna', reasoning: 'medium' },
  { role: 'Difficult Coding', model: 'GPT-6 Luna', reasoning: 'high' },
  { role: 'Hardest Bug / Review', model: 'GPT-6 Sol', reasoning: '' },
];

function validateTeamRoles(rows) {
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > 12) throw new Error('Provide between 1 and 12 role defaults');
  const names = new Set();
  return rows.map(row => {
    if (!row || typeof row !== 'object') throw new Error('Invalid role default');
    const next = {};
    for (const key of ['role', 'model', 'reasoning']) {
      if (typeof row[key] !== 'string' || row[key].length > 80 || /[\x00-\x1f\x7f-\x9f]/.test(row[key])) throw new Error('Invalid role default text');
      next[key] = row[key].trim();
    }
    if (!next.role || !next.model || names.has(next.role.toLowerCase())) throw new Error('Role names must be unique and have a model');
    if (!['', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(next.reasoning)) throw new Error('Invalid reasoning level');
    names.add(next.role.toLowerCase());
    return next;
  });
}

function detailsOf(session) {
  return { ...EMPTY_DETAILS, ...(session?.details || {}) };
}

function validateUpdate(id, patch, all) {
  if (!all.has(id)) throw new Error('Session not found');
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Invalid session details');
  const keys = Object.keys(patch);
  if (!keys.length || keys.some(key => !Object.hasOwn(EMPTY_DETAILS, key))) throw new Error('Invalid session details fields');
  const next = { ...detailsOf(all.get(id)), ...patch };
  for (const key of ['teamId', 'role']) {
    if (typeof next[key] === 'string' && /[\x00-\x1f\x7f-\x9f]/.test(next[key])) throw new Error(`${key} contains control characters`);
  }
  if (typeof next.teamId === 'string') next.teamId = next.teamId.trim();
  if (typeof next.role === 'string') next.role = next.role.trim();
  if (typeof next.currentTask === 'string') next.currentTask = next.currentTask.replace(/\r\n?/g, '\n');
  for (const [key, max] of Object.entries(LIMITS)) {
    const value = next[key];
    const forbidden = key === 'currentTask' ? /[\x00-\x08\x0b-\x1f\x7f-\x9f]/ : /[\x00-\x1f\x7f-\x9f]/;
    if (typeof value !== 'string' || value.length > max || forbidden.test(value)) {
      throw new Error(`${key} must be text of at most ${max} characters without control characters`);
    }
  }
  const parent = next.parentSessionId;
  if (parent !== null && (typeof parent !== 'string' || !parent || parent.length > 200 || /[\x00-\x1f\x7f-\x9f]/.test(parent))) {
    throw new Error('Invalid parent session ID');
  }
  if (parent) {
    if (parent === id) throw new Error('A session cannot be its own parent');
    if (!next.teamId || !all.has(parent) || detailsOf(all.get(parent)).teamId !== next.teamId) {
      throw new Error('Parent session must exist in the same team');
    }
    const seen = new Set([id]);
    let ancestor = parent;
    while (ancestor) {
      if (seen.has(ancestor)) throw new Error('Parent session cycle');
      seen.add(ancestor);
      ancestor = detailsOf(all.get(ancestor)).parentSessionId;
      if (ancestor && !all.has(ancestor)) break;
    }
  }
  for (const [otherId, session] of all) {
    if (otherId !== id && detailsOf(session).parentSessionId === id && detailsOf(session).teamId !== next.teamId) {
      throw new Error('Team cannot change while another session has this parent');
    }
  }
  return next;
}

module.exports = { EMPTY_DETAILS, detailsOf, validateUpdate, DEFAULT_TEAM_ROLES, validateTeamRoles };
