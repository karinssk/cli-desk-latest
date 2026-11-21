// Tasks pane: `clideck ask` tasks this session sent or received, with report, VERDICT and attached files.
import { state, send } from './state.js';

const pane = document.getElementById('task-pane');
const toggle = document.getElementById('tasks-toggle');
const list = document.getElementById('task-list');
const scope = document.getElementById('task-scope');
const tasks = state.tasks = new Map();
let loaded = false;

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const ago = ms => { const s = Math.round((Date.now() - ms) / 1000); return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : s < 86400 ? `${Math.round(s / 3600)}h ago` : new Date(ms).toLocaleDateString(); };
const took = t => { const s = Math.round(((t.endedAt || Date.now()) - t.startedAt) / 1000); return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`; };
const STATUS = { working: 'Working', done: 'Done', blocked: 'Blocked', failed: 'Failed', timeout: 'Timed out' };

// Small markdown subset (headings, lists, bold, inline code, code blocks), built with DOM nodes so agent text can't inject HTML.
function markdown(text) {
  const root = el('div', 'task-md');
  const inline = (parent, s) => {
    for (const part of s.split(/(`[^`]+`|\*\*[^*]+\*\*)/)) {
      if (!part) continue;
      if (part.startsWith('`') && part.endsWith('`') && part.length > 2) parent.append(el('code', '', part.slice(1, -1)));
      else if (part.startsWith('**') && part.endsWith('**') && part.length > 4) parent.append(el('strong', '', part.slice(2, -2)));
      else parent.append(part);
    }
  };
  let code = null, ul = null;
  for (const line of String(text || '').split('\n')) {
    if (line.trim().startsWith('```')) { if (code) { root.append(code); code = null; } else { code = el('pre'); ul = null; } continue; }
    if (code) { code.append(line + '\n'); continue; }
    const li = /^\s*(?:[-*•]|\d+\.)\s+(.*)/.exec(line), h = /^#{1,4}\s+(.*)/.exec(line);
    if (li) { if (!ul) root.append(ul = el('ul')); const item = el('li'); inline(item, li[1]); ul.append(item); continue; }
    ul = null;
    if (h) { const e = el('h4'); inline(e, h[1]); root.append(e); }
    else if (line.trim()) { const p = el('p'); inline(p, line); root.append(p); }
  }
  if (code) root.append(code);
  return root;
}

function card(t) {
  const c = el('article', `task-card is-${t.status}`);
  const head = el('div', 'task-head');
  head.append(el('span', `task-status s-${t.status}`, STATUS[t.status] || t.status));
  if (t.verdict) head.append(el('span', `task-verdict v-${t.verdict.toLowerCase()}`, `VERDICT: ${t.verdict}`));
  head.append(el('span', 'task-time', t.status === 'working' ? `running ${took(t)}` : `${ago(t.endedAt || t.startedAt)} · ${took(t)}`));
  const title = el('div', 'task-title', String(t.task).split('\n').find(l => l.trim())?.slice(0, 140) || 'Task');
  const meta = el('div', 'task-meta', `${t.fromName || '?'} → ${t.toName || '?'}${t.project ? ` · ${t.project}` : ''}`);
  c.append(head, title, meta);
  const brief = el('details', 'task-brief'); brief.append(el('summary', '', 'Task brief'), el('pre', 'task-pre', t.task)); c.append(brief);
  if (t.report) c.append(markdown(t.report));
  if (t.error) c.append(el('p', 'task-error', t.error));
  const files = t.files || [];
  if (files.some(f => f.image)) {
    const grid = el('div', 'task-images');
    files.forEach((f, i) => {
      if (!f.image) return;
      const img = el('img'); img.src = `/task-files/${t.id}/${i}`; img.alt = f.name; img.loading = 'lazy'; img.title = f.name;
      img.addEventListener('click', () => lightbox(img.src, f.name));
      grid.append(img);
    });
    c.append(grid);
  }
  for (const [i, f] of files.entries()) if (!f.image) {
    const a = el('a', 'task-file', `📎 ${f.name} · ${(f.size / 1024).toFixed(0)} KB`); a.href = `/task-files/${t.id}/${i}`; a.download = f.name; c.append(a);
  }
  for (const n of t.notes || []) c.append(el('p', 'task-note', `⚠️ ${n}`));
  return c;
}

function lightbox(src, name) {
  const box = el('div', 'task-lightbox'), img = el('img');
  img.src = src; img.alt = name;
  box.append(img, el('span', '', name));
  box.addEventListener('click', () => box.remove());
  document.body.append(box);
}

export function renderTaskPane() {
  const working = [...tasks.values()].filter(t => t.status === 'working').length;
  toggle.dataset.count = working || '';
  if (pane.hidden) return;
  const all = scope.value === 'all', id = state.active;
  const rows = [...tasks.values()].filter(t => all || t.fromId === id || t.toId === id).sort((a, b) => b.startedAt - a.startedAt);
  list.replaceChildren(...(rows.length ? rows.map(card) : [el('p', 'task-empty', all ? 'No tasks yet. Tasks appear here when an agent uses clideck ask.' : 'No tasks for this session yet. Agents create tasks with clideck ask.')]));
}

export function setTasks(arr) { for (const t of arr || []) tasks.set(t.id, t); loaded = true; renderTaskPane(); }
export function updateTask(t) { tasks.set(t.id, t); renderTaskPane(); }

function setOpen(open) {
  pane.hidden = !open;
  document.getElementById('main').classList.toggle('tasks-open', open);
  toggle.setAttribute('aria-expanded', String(open));
  localStorage.setItem('clideck.tasksOpen', String(open));
  if (open && !loaded) send({ type: 'tasks.get' });
  renderTaskPane();
}

toggle.addEventListener('click', () => setOpen(pane.hidden));
scope.addEventListener('change', renderTaskPane);
document.addEventListener('clideck:active', renderTaskPane);
setInterval(() => { if (!pane.hidden && [...tasks.values()].some(t => t.status === 'working')) renderTaskPane(); }, 15000); // refresh "running Xm"
document.addEventListener('keydown', e => { if (e.key === 'Escape') document.querySelector('.task-lightbox')?.remove(); });
if (localStorage.getItem('clideck.tasksOpen') === 'true') setOpen(true);
