import { state } from './state.js';

const panel = document.getElementById('session-monitor');
const toggle = document.getElementById('monitor-toggle');
const field = (name, value) => { document.getElementById(`monitor-${name}`).textContent = value ?? 'Unknown'; };
const number = value => Number.isSafeInteger(value) && value >= 0 ? value : null;

export function setSessionMonitor(id, monitor = {}, cwd, statusKnown) {
  const entry = state.terms.get(id);
  if (!entry) return;
  entry.monitor = monitor;
  if (cwd !== undefined) entry.cwd = cwd;
  if (statusKnown !== undefined) entry.statusKnown = statusKnown;
  if (id === state.active) renderSessionMonitor();
}

export function renderSessionMonitor() {
  const entry = state.terms.get(state.active);
  const m = entry?.monitor || {};
  field('name', state.active ? document.querySelector(`.group[data-id="${state.active}"] .name`)?.textContent : '');
  field('status', entry?.statusKnown ? (entry.working ? 'Working' : 'Idle') : 'Unknown');
  field('model', m.model);
  field('reasoning', m.reasoning);
  const used = number(m.contextTokens);
  const window = number(m.contextWindow);
  const percent = used !== null && window > 0 ? Math.min(100, used / window * 100) : null;
  field('context', used === null ? 'Unknown' : `${used.toLocaleString()} / ${window ? window.toLocaleString() : 'Unknown'}${percent === null ? '' : ` · ${percent.toFixed(1)}%`}`);
  const bar = document.getElementById('monitor-progress');
  bar.querySelector('span').style.width = `${percent || 0}%`;
  if (percent === null) bar.removeAttribute('aria-valuenow');
  else bar.setAttribute('aria-valuenow', String(Math.round(percent)));
  document.getElementById('monitor-tokens-label').textContent = m.cumulativeTokens == null && m.observedTokens != null
    ? 'Observed tokens (since attached)' : 'Cumulative tokens';
  field('cumulative', number(m.cumulativeTokens ?? m.observedTokens)?.toLocaleString());
  field('quota', m.quota);
  field('cost', m.cost);
  field('cwd', entry?.cwd);
  field('branch', m.branch);
}

toggle.addEventListener('click', () => {
  const open = panel.hidden;
  panel.hidden = !open;
  document.body.classList.toggle('monitor-open', open);
  toggle.setAttribute('aria-expanded', String(open));
  toggle.setAttribute('aria-label', open ? 'Hide session details' : 'Show session details');
  if (open) renderSessionMonitor();
});

document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !panel.hidden && document.activeElement?.closest('#session-monitor, #monitor-toggle')) {
    toggle.click();
    toggle.focus();
  }
});
