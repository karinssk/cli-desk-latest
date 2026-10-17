const $ = id => document.getElementById(id);
let sessions = [], teams = [], online = false, busy = false, helperErrors = 0;
const labels = { overview: ['Overview', 'Your agents, at a glance.', 'A live view of the work happening across your workspace.'], agents: ['Agent teams', 'Good work takes a team.', 'See every native helper, linked to the chat that spawned it.'], recovery: ['Recovery', 'Keep the work moving.', 'A clear view of sessions that need your attention.'] };
const el = (tag, text, className) => { const node = document.createElement(tag); if (text != null) node.textContent = text; if (className) node.className = className; return node; };
const project = session => session.cwd?.split(/[\\/]/).filter(Boolean).pop() || 'No workspace reported';
const terminal = id => `/#session=${encodeURIComponent(id)}`;
const status = session => !online ? 'Unknown' : session.recoverableError ? 'Needs attention' : session.menu?.length ? 'Waiting for input' : session.statusKnown ? (session.working ? 'Working' : 'Idle') : 'Unknown';
function badge(value) { const node = el('span', null, 'badge'); node.dataset.status = value; node.append(el('i', null, `dot ${value === 'Working' ? 'working' : ''}`), document.createTextNode(value)); return node; }
function avatar(name) { return el('span', name.trim().split(/[\s_]+/).slice(0, 2).map(s => Array.from(s)[0]).join('').toUpperCase(), 'avatar'); }
function link(text, id) { const a = el('a', text); a.href = terminal(id); return a; }
function meta(entries) { const dl = el('dl', null, 'card-meta'); for (const [key, value] of entries) dl.append(el('dt', key), el('dd', value || 'Not reported')); return dl; }
function empty(container, text) { container.append(el('p', text, 'empty')); }
function page() {
  const key = Object.hasOwn(labels, location.hash.slice(1)) ? location.hash.slice(1) : 'overview';
  const [label, title, description] = labels[key];
  $('page-label').textContent = label; $('page-title').textContent = title; $('page-description').textContent = description;
  document.title = `CliDeck — ${label}`;
  for (const name of Object.keys(labels)) { $(`view-${name}`).hidden = key !== name; const a = document.querySelector(`[data-page="${name}"]`); if (name === key) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); }
}
function sessionCard(session, recovery = false) {
  const card = el('article', null, 'session-card'); card.dataset.sessionId = session.id;
  const name = session.name || session.id.slice(0, 8), top = el('div', null, 'card-top'), identity = el('div', null, 'identity');
  identity.append(el('h3', name), el('small', `${project(session)} · ${session.id.slice(0, 8)}`));
  top.append(avatar(name), identity, badge(status(session))); card.append(top);
  card.append(el('p', recovery ? (session.recoverableError ? 'A recoverable error is currently visible on this terminal.' : 'No recoverable error detected in the latest snapshot.') : session.details?.currentTask || 'No task assigned', 'task'));
  const m = session.monitor || {}, used = m.contextTokens, total = m.contextWindow;
  const context = Number.isFinite(used) && Number.isFinite(total) && total > 0 ? `${Math.round(used / total * 100)}% · ${used.toLocaleString()} / ${total.toLocaleString()}` : 'Not reported';
  card.append(meta(recovery ? [['Recovery attempts', session.recovery ? `${session.recovery.attempts} / ${session.recovery.limit}` : 'Not reported'], ['Last error', session.recovery?.lastError || (session.recoverableError ? 'Bad Request' : 'None reported')]] : [['Role', session.details?.role || 'Unassigned'], ['Model', m.model], ['Context', context]]));
  if (!recovery && context !== 'Not reported') { const bar = el('div', null, 'context-bar'), fill = el('span'); fill.style.width = `${Math.max(0, Math.min(100, used / total * 100))}%`; bar.append(fill); card.append(bar); }
  const footer = el('div', null, 'card-footer'); footer.append(el('span', session.presetId || 'Terminal'), link('Open terminal ↗', session.id)); card.append(footer); return card;
}
function render() {
  $('stat-sessions').textContent = sessions.length;
  $('stat-working').textContent = online ? sessions.filter(s => status(s) === 'Working').length : '—';
  $('stat-helpers').textContent = new Set(teams.flatMap(t => t.members.map(m => m.id))).size;
  $('helper-caption').textContent = helperErrors ? `${helperErrors} session roster(s) unavailable` : 'Including recorded history';
  $('stat-attention').textContent = online ? sessions.filter(s => ['Needs attention', 'Waiting for input'].includes(status(s))).length : '—';
  const search = $('search').value.trim().toLowerCase(), list = $('sessions'); list.replaceChildren();
  const shown = sessions.filter(s => [s.name, s.cwd, s.details?.currentTask, s.details?.role].some(value => value?.toLowerCase().includes(search)));
  $('session-count').textContent = shown.length;
  for (const session of shown) list.append(sessionCard(session));
  if (!shown.length) empty(list, search ? 'No sessions match your search.' : 'No active sessions. Open the workspace to start one.');
  const teamList = $('teams'); teamList.replaceChildren(); $('team-count').textContent = teams.length;
  for (const team of teams) {
    const block = el('article', null, 'team-block'), heading = el('div', null, 'team-heading'), title = el('div');
    title.append(el('h2', team.name), el('p', `${team.session.name} · ${project(team.session)} · ${team.members.length} helpers`)); heading.append(title, link('Open parent chat ↗', team.session.id)); block.append(heading);
    for (const member of team.members) { const row = el('div', null, 'agent-row'), info = el('div'); row.dataset.nativeId = member.id; info.append(el('strong', member.name), el('small', `${member.role || 'Native helper'} · ${member.model || 'Model not reported'}${member.reasoning ? ' / ' + member.reasoning : ''}`), el('small', `${member.id} · ${member.source || 'Reported team metadata'}`)); row.append(avatar(member.name || 'Agent'), info, badge(online ? member.status : 'Unknown')); block.append(row); }
    teamList.append(block);
  }
  if (!teams.length) empty(teamList, helperErrors ? 'Agent rosters are unavailable. Retry the connection.' : 'No native helpers recorded for the active sessions.');
  const recovery = $('recovery'); recovery.replaceChildren();
  for (const session of sessions) recovery.append(sessionCard(session, true));
  if (!sessions.length) empty(recovery, 'No active sessions to monitor.');
}
export async function refresh() {
  if (busy) return;
  busy = true; $('refresh').disabled = true;
  try {
    const response = await fetch('/api/master/sessions', { cache: 'no-store', signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error('unavailable');
    const data = await response.json(); if (!Array.isArray(data.sessions)) throw new Error('invalid snapshot');
    sessions = data.sessions; helperErrors = 0;
    const rosters = await Promise.all(sessions.map(async session => {
      try { const r = await fetch(`/api/session/native-team?id=${encodeURIComponent(session.id)}`, { cache: 'no-store', signal: AbortSignal.timeout(4000) }); if (!r.ok) throw new Error('unavailable'); const d = await r.json(); if (!Array.isArray(d.teams)) throw new Error('invalid roster'); if (d.warning) helperErrors++; return d.teams.map(t => ({ ...t, session })); }
      catch { helperErrors++; return []; }
    }));
    teams = rosters.flat(); online = true; $('error').hidden = false; $('error').textContent = helperErrors ? 'Some helper rosters are unavailable. Session information is current.' : ''; $('error').hidden = !helperErrors;
    $('connection').textContent = 'Live · every 5s'; $('connection-dot').className = 'dot working'; $('updated').textContent = `Updated ${new Date().toLocaleTimeString()}`;
  } catch { online = false; $('connection').textContent = 'Disconnected'; $('connection-dot').className = 'dot attention'; $('error').hidden = false; $('error').textContent = 'Connection lost. Displayed records are from the last snapshot; activity status is unknown.'; }
  finally { busy = false; $('refresh').disabled = false; render(); }
}
$('refresh').addEventListener('click', refresh); $('search').addEventListener('input', render); window.addEventListener('hashchange', page);
page(); refresh(); setInterval(() => { if (!document.hidden) refresh(); }, 5000);
