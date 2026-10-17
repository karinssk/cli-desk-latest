import { state, send } from './state.js';
import { showToast } from './toast.js';
import { randomUUID } from './utils.js';

const panel = document.getElementById('session-monitor');
const toggle = document.getElementById('monitor-toggle');
const form = document.getElementById('monitor-assignment-form');
const field = (name, value) => { document.getElementById(`monitor-${name}`).textContent = value ?? 'Not reported'; };
const number = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
let formSession = null;
let requestedSession = null;
let pendingRoleDefaults = null;
let nativeRequest = false;
const defaultsForm = document.getElementById('monitor-role-defaults-form');

function roleRecommendation(role) {
  const preset = state.cfg.teamRoles?.find(item => item.role.toLowerCase() === (role || '').toLowerCase());
  return preset ? `${preset.model}${preset.reasoning ? ' · ' + preset.reasoning : ''}` : 'No default for this role';
}

export function refreshRoleDefaults() {
  const list = document.getElementById('monitor-roles');
  list.replaceChildren();
  for (const preset of state.cfg.teamRoles || []) list.appendChild(new Option(preset.model, preset.role));
  if (pendingRoleDefaults && JSON.stringify(pendingRoleDefaults.rows) === JSON.stringify(state.cfg.teamRoles)) {
    pendingRoleDefaults = null;
    document.getElementById('monitor-role-defaults-message').textContent = 'Role defaults saved.';
  }
  renderSessionMonitor();
}

function sessionName(id, entry = state.terms.get(id)) {
  return entry?.name || document.querySelector(`.group[data-id="${CSS.escape(id)}"] .name`)?.textContent || id.slice(0, 8);
}

function sessionStatus(entry) {
  if (!entry) return 'Closed';
  if (entry.recovery?.failed) return 'Failed / awaiting recovery';
  if (entry.menu?.length) return 'Waiting for input';
  return entry.statusKnown ? (entry.working ? 'Working' : 'Idle') : 'Unknown';
}

function initials(name) {
  return name.trim().split(/\s+/).slice(0, 2).map(part => Array.from(part)[0]).join('').toUpperCase();
}

export function setSessionMonitor(id, monitor = {}, cwd, statusKnown) {
  const entry = state.terms.get(id);
  if (!entry) return;
  entry.monitor = monitor;
  if (cwd !== undefined) entry.cwd = cwd;
  if (statusKnown !== undefined) entry.statusKnown = statusKnown;
  renderSessionMonitor();
}

export function setSessionDetails(id, details, branch, assignmentDelivery) {
  const entry = state.terms.get(id);
  if (!entry) return;
  if (details) entry.details = details;
  if (assignmentDelivery !== undefined) entry.assignmentDelivery = assignmentDelivery;
  if (branch !== undefined) entry.branch = branch || 'Not reported';
  renderSessionMonitor();
}

export function assignmentResult(msg, error = false) {
  if (error && msg.requestId && pendingRoleDefaults?.requestId === msg.requestId) {
    pendingRoleDefaults = null;
    document.getElementById('monitor-role-defaults-message').textContent = msg.message;
    return;
  }
  if (!msg.requestId || form.dataset.requestId !== msg.requestId) return;
  delete form.dataset.requestId;
  document.getElementById('monitor-assignment-message').textContent = error ? msg.message : 'Assignment saved.';
}

function parentOptions(id, teamId, selected) {
  const list = document.getElementById('monitor-edit-parent');
  list.replaceChildren(new Option('Not assigned', ''));
  if (teamId) for (const [peerId, peer] of state.terms) {
    if (peerId !== id && peer.details?.teamId === teamId) list.add(new Option(`${sessionName(peerId, peer)} · ${peerId.slice(0, 8)}`, peerId));
  }
  if (selected && ![...list.options].some(option => option.value === selected)) list.add(new Option(`Saved session · ${selected.slice(0, 8)}`, selected));
  list.value = selected || '';
}

function fillAssignment(id, entry) {
  formSession = id;
  const details = entry?.details || {};
  form.elements.teamId.value = details.teamId || '';
  form.elements.role.value = details.role || '';
  form.elements.currentTask.value = details.currentTask || '';
  parentOptions(id, details.teamId, details.parentSessionId);
  document.getElementById('monitor-assignment-message').textContent = '';
  delete form.dataset.requestId;
}

export function renderSessionMonitor() {
  if (panel.hidden) return;
  const id = state.active;
  const entry = state.terms.get(id);
  const details = entry?.details || {};
  const m = entry?.monitor || {};
  field('name', entry ? sessionName(id, entry) : 'No session selected');
  field('status', sessionStatus(entry));
  document.getElementById('monitor-status').dataset.status = sessionStatus(entry);
  field('avatar', entry ? initials(sessionName(id, entry)) : '—');
  field('role', details.role || 'Not assigned');
  field('recommendation', details.role ? roleRecommendation(details.role) : 'Assign a role to see its default');
  field('task', details.currentTask || 'Not assigned');
  field('assignment-delivery', entry?.assignmentDelivery || 'Not reported');
  field('activity', entry?.lastPreviewText || 'Not reported');
  field('team-name', details.teamId || 'Not assigned');
  field('parent', details.parentSessionId ? sessionName(details.parentSessionId) : 'Not assigned');
  field('project', state.cfg.projects?.find(project => project.id === entry?.projectId)?.name || 'Not assigned');
  field('id', id || 'Not reported');
  document.getElementById('monitor-copy-id').disabled = !entry;
  field('model', m.model);
  field('reasoning', m.reasoning);
  const used = number(m.contextTokens);
  const window = number(m.contextWindow);
  const percent = used !== null && window > 0 ? Math.min(100, used / window * 100) : null;
  field('context', used === null ? 'Not reported' : `${used.toLocaleString()} / ${window ? window.toLocaleString() : 'Not reported'}${percent === null ? '' : ` · ${percent.toFixed(1)}%`}`);
  const bar = document.getElementById('monitor-progress');
  bar.querySelector('span').style.width = `${percent || 0}%`;
  if (percent === null) bar.removeAttribute('aria-valuenow');
  else bar.setAttribute('aria-valuenow', String(Math.round(percent)));
  bar.setAttribute('aria-valuemin', '0');
  bar.setAttribute('aria-valuemax', '100');
  document.getElementById('monitor-tokens-label').textContent = m.cumulativeTokens == null && m.observedTokens != null ? 'Observed tokens (since attached)' : 'Cumulative tokens';
  field('cumulative', number(m.cumulativeTokens ?? m.observedTokens)?.toLocaleString());
  field('quota', m.quota);
  field('cost', m.cost);
  field('cwd', entry?.cwd);
  field('branch', entry?.branch ?? m.branch);

  const nativeSection = document.getElementById('monitor-native-team');
  const nativeMembers = document.getElementById('monitor-native-members');
  nativeMembers.replaceChildren();
  nativeSection.hidden = !entry?.nativeTeams?.length && !entry?.nativeTeamError;
  document.getElementById('monitor-native-summary').textContent = entry?.nativeTeamError || 'Native helpers, including history · unknown means runtime not observed · refreshes every 5s';
  for (const nativeTeam of entry?.nativeTeams || []) {
    const heading = document.createElement('h4');
    heading.className = 'monitor-section';
    heading.textContent = nativeTeam.name;
    nativeMembers.append(heading);
    for (const member of nativeTeam.members) {
      const row = document.createElement('div');
      row.className = 'monitor-team-agent';
      row.dataset.nativeId = member.id;
      row.title = `${nativeTeam.name}\n${member.role}\n${member.model} ${member.reasoning}\n${member.id}\n${member.source || 'Reported team metadata'}\nLast reported: ${member.lastSeenAt || 'Unknown'}`;
      const avatar = document.createElement('span');
      avatar.className = 'monitor-avatar';
      avatar.setAttribute('aria-hidden', 'true');
      avatar.textContent = initials(member.name);
      const info = document.createElement('span');
      info.className = 'agent-info';
      const name = document.createElement('span');
      name.className = 'agent-title';
      name.textContent = member.name;
      const role = document.createElement('small');
      role.textContent = `${member.role} · ${member.model || 'Model not reported'}${member.reasoning ? ' / ' + member.reasoning : ''} · ${member.id.slice(0, 8)}`;
      info.append(name, role);
      const status = document.createElement('span');
      status.className = 'agent-state monitor-state';
      status.dataset.status = member.status;
      status.textContent = member.status;
      row.append(avatar, info, status);
      nativeMembers.append(row);
    }
  }

  const team = document.getElementById('monitor-team');
  const focusedId = team.contains(document.activeElement) ? document.activeElement.dataset.sessionId : null;
  team.replaceChildren();
  const peers = [...state.terms].filter(([peerId, peer]) => details.teamId
    ? peer.details?.teamId === details.teamId
    : peerId === id || (entry?.projectId && peer.projectId === entry.projectId && !peer.details?.teamId));
  document.getElementById('monitor-team-heading').textContent = details.teamId ? 'Team sessions' : 'Project sessions · no team assigned';
  const counts = new Map();
  for (const [, peer] of peers) counts.set(sessionStatus(peer), (counts.get(sessionStatus(peer)) || 0) + 1);
  document.getElementById('monitor-team-summary').textContent = [...counts].map(([status, count]) => `${count} ${status.toLowerCase()}`).join(' · ');
  if (!peers.length) {
    const empty = document.createElement('p');
    empty.textContent = 'Assign a team to link its sessions here.';
    empty.style.cssText = 'font-size:12px;color:var(--color-dim);padding:8px 0';
    team.appendChild(empty);
  } else for (const [peerId, peer] of peers) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'monitor-team-agent';
    button.dataset.sessionId = peerId;
    button.setAttribute('aria-current', String(peerId === id));
    button.setAttribute('aria-label', `Open ${sessionName(peerId, peer)}, ${peer.details?.role || 'role not assigned'}, ${sessionStatus(peer)}, session ${peerId}`);
    const info = document.createElement('span');
    info.className = 'agent-info';
    const title = document.createElement('span');
    title.className = 'agent-title';
    title.textContent = sessionName(peerId, peer);
    const sub = document.createElement('small');
    sub.textContent = `${peer.details?.role || 'Not assigned'} · ${peerId.slice(0, 8)}`;
    info.append(title, sub);
    const status = document.createElement('span');
    status.className = 'agent-state monitor-state';
    status.textContent = sessionStatus(peer);
    status.dataset.status = sessionStatus(peer);
    const avatar = document.createElement('span');
    avatar.className = 'monitor-avatar';
    avatar.setAttribute('aria-hidden', 'true');
    avatar.textContent = initials(sessionName(peerId, peer));
    const open = document.createElement('span');
    open.className = 'agent-open';
    open.setAttribute('aria-hidden', 'true');
    open.textContent = '↗';
    button.append(avatar, info, status, open);
    team.appendChild(button);
    if (focusedId === peerId) button.focus({ preventScroll: true });
  }
  document.getElementById('monitor-assignment-fields').disabled = !entry;
  if (formSession !== id) fillAssignment(id, entry);
  if (entry && requestedSession !== id) {
    requestedSession = id;
    send({ type: 'session.details.get', id });
  }
  const master = state.masterMonitor;
  const live = master && Date.now() - master.seenAt < 20000;
  field('master', master ? (live ? 'Live' : 'Disconnected') : 'Not reported');
  const enabled = entry && live && master.recover && master.sessionIds?.includes(id);
  field('recovery-enabled', live ? (enabled ? 'On' : 'Off for this session') : 'Not reported');
  field('retries', entry?.recovery ? `${entry.recovery.attempts} / ${entry.recovery.limit} without progress` : 'Not reported');
  field('error', entry?.recovery?.lastError || (entry?.recovery ? 'None detected' : 'Not reported'));
}

export function initializeSessionMonitor(selectSession) {
  document.getElementById('monitor-team').addEventListener('click', event => {
    const id = event.target.closest('button[data-session-id]')?.dataset.sessionId;
    if (id && state.terms.has(id)) {
      selectSession(id);
      if (window.matchMedia('(max-width: 700px)').matches) {
        document.querySelector(`#monitor-team button[data-session-id="${CSS.escape(id)}"]`)?.focus({ preventScroll: true });
      }
    }
  });
}

toggle.addEventListener('click', () => {
  const open = panel.hidden;
  panel.hidden = !open;
  document.body.classList.toggle('monitor-open', open);
  toggle.setAttribute('aria-expanded', String(open));
  toggle.setAttribute('aria-label', open ? 'Hide session details' : 'Show session details');
  localStorage.setItem('clideck.monitorOpen', String(open));
  requestedSession = null;
  if (open) renderSessionMonitor();
});

form.elements.teamId.addEventListener('input', () => parentOptions(state.active, form.elements.teamId.value.trim(), ''));
document.getElementById('monitor-role-defaults').addEventListener('toggle', event => {
  if (!event.target.open) return;
  const rows = document.getElementById('monitor-role-default-rows');
  rows.replaceChildren();
  for (const [index, preset] of (state.cfg.teamRoles || []).entries()) {
    const group = document.createElement('fieldset');
    group.className = 'monitor-row';
    const legend = document.createElement('legend');
    legend.textContent = `Step ${index + 1}`;
    group.appendChild(legend);
    for (const key of ['role', 'model', 'reasoning']) {
      const label = document.createElement('label');
      label.textContent = key === 'model' ? 'Recommended model' : key === 'reasoning' ? 'Reasoning level' : 'Role';
      const input = document.createElement(key === 'reasoning' ? 'select' : 'input');
      if (key === 'reasoning') for (const level of ['', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']) input.add(new Option(level || 'Not specified', level));
      else { input.maxLength = 80; input.required = true; }
      input.name = key;
      input.value = preset[key];
      label.appendChild(input);
      group.appendChild(label);
    }
    rows.appendChild(group);
  }
  document.getElementById('monitor-role-defaults-message').textContent = '';
});

defaultsForm.addEventListener('submit', event => {
  event.preventDefault();
  const rows = [...document.querySelectorAll('#monitor-role-default-rows fieldset')].map(group =>
    Object.fromEntries([...group.querySelectorAll('[name]')].map(input => [input.name, input.value.trim()])));
  if (!rows.length) return;
  const requestId = randomUUID();
  pendingRoleDefaults = { requestId, rows };
  const sent = send({ type: 'config.update', config: { teamRoles: rows }, requestId });
  if (!sent) pendingRoleDefaults = null;
  document.getElementById('monitor-role-defaults-message').textContent = sent ? 'Saving…' : 'Disconnected. Reconnect before saving.';
});

document.getElementById('monitor-assignment').addEventListener('toggle', event => {
  if (event.target.open) fillAssignment(state.active, state.terms.get(state.active));
});

form.addEventListener('submit', event => {
  event.preventDefault();
  const id = formSession;
  if (!id || id !== state.active || !state.terms.has(id)) return;
  const details = Object.fromEntries(new FormData(form));
  details.parentSessionId ||= null;
  const requestId = randomUUID();
  const sent = send({ type: 'session.details.update', id, details, requestId });
  if (sent) form.dataset.requestId = requestId;
  document.getElementById('monitor-assignment-message').textContent = sent ? 'Saving…' : 'Disconnected. Reconnect before saving.';
});

document.getElementById('monitor-copy-id').addEventListener('click', async () => {
  if (!state.active) return;
  try { await navigator.clipboard.writeText(state.active); showToast('Session ID copied.'); }
  catch { showToast('Could not copy session ID.', { type: 'error' }); }
});

document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !panel.hidden && document.activeElement?.closest('#session-monitor, #monitor-toggle')) { toggle.click(); toggle.focus(); }
});

if (localStorage.getItem('clideck.monitorOpen') === 'true') {
  panel.hidden = false;
  document.body.classList.add('monitor-open');
  toggle.setAttribute('aria-expanded', 'true');
  toggle.setAttribute('aria-label', 'Hide session details');
}
async function refreshNativeTeam() {
  const id = state.active;
  if (panel.hidden || !id || nativeRequest) return;
  nativeRequest = true;
  try {
    const response = await fetch(`/api/session/native-team?id=${encodeURIComponent(id)}`, { cache: 'no-store', signal: AbortSignal.timeout(4000) });
    if (!response.ok) throw new Error('unavailable');
    const data = await response.json();
    const entry = state.terms.get(id);
    if (entry) { entry.nativeTeams = data.teams; entry.nativeTeamError = data.warning || null; }
  } catch {
    const entry = state.terms.get(id);
    if (entry) { entry.nativeTeams = []; entry.nativeTeamError = 'Chat agent status unavailable'; }
  } finally { nativeRequest = false; renderSessionMonitor(); }
}
setInterval(() => { if (!panel.hidden) { renderSessionMonitor(); refreshNativeTeam(); } }, 5000);
