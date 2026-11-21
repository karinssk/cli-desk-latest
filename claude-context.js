// Context breakdown for a Claude Code session, like its /context screen.
// Runs `/context` on a fork of the session (--fork-session), so the live session is never touched,
// then deletes the fork's transcript so it doesn't show up in `claude --resume`.
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const { join } = require('path');

const num = s => { const m = /^([\d.]+)\s*([km]?)$/i.exec(String(s).trim()); return m ? Math.round(+m[1] * ({ k: 1e3, m: 1e6 }[m[2].toLowerCase()] || 1)) : null; };
const cells = line => line.split('|').slice(1, -1).map(c => c.trim());

// Parses the markdown /context prints in print mode.
function parseContext(md) {
  const model = /\*\*Model:\*\*\s*(\S+)/.exec(md)?.[1] || null;
  const t = /\*\*Tokens:\*\*\s*([\d.]+\s*[km]?)\s*\/\s*([\d.]+\s*[km]?)\s*\((\d+)%\)/i.exec(md);
  const out = { model, used: t ? num(t[1]) : null, window: t ? num(t[2]) : null, percent: t ? +t[3] : null, categories: [], lists: [] };
  let section = null;
  const lines = md.split('\n');
  for (const [i, line] of lines.entries()) {
    const h = /^###\s+(.+)/.exec(line);
    if (h) { section = h[1].trim(); if (!/usage by category/i.test(section)) out.lists.push({ name: section, items: [] }); continue; }
    const sep = l => /^\|[\s\-:|]+\|$/.test(l || '');
    if (!section || !line.startsWith('|') || sep(line) || sep(lines[i + 1])) continue; // skip separators and header rows
    const c = cells(line);
    if (/usage by category/i.test(section)) out.categories.push({ name: c[0], tokens: num(c[1]), percent: parseFloat(c[2]) || 0 });
    else out.lists.at(-1).items.push(/memory/i.test(section) ? c[1] : c[0]);
  }
  out.lists = out.lists.filter(l => l.items.length);
  return out;
}

const running = new Map();
function claudeContext(sessionId, cwd) {
  if (!/^[0-9a-f-]{36}$/i.test(sessionId || '')) return Promise.reject(new Error('No Claude session ID captured yet'));
  if (running.has(sessionId)) return running.get(sessionId);
  const p = new Promise((resolve, reject) => {
    execFile('claude', ['-p', '--resume', sessionId, '--fork-session', '--output-format', 'json', '/context'],
      { cwd, timeout: 60000, maxBuffer: 8 << 20, env: { ...process.env, CLIDECK_SESSION_ID: '' } }, (err, stdout) => {
        let j; try { j = JSON.parse(stdout); } catch { return reject(new Error(err?.message?.slice(0, 200) || 'claude returned no JSON')); }
        if (j.session_id !== sessionId) removeFork(j.session_id);
        if (j.is_error || typeof j.result !== 'string') return reject(new Error(String(j.result || 'context failed').slice(0, 200)));
        const data = parseContext(j.result);
        data.categories.length ? resolve(data) : reject(new Error('Could not read /context output'));
      });
  }).finally(() => running.delete(sessionId));
  running.set(sessionId, p);
  return p;
}

function removeFork(forkId) {
  if (!/^[0-9a-f-]{36}$/i.test(forkId || '')) return;
  const root = join(os.homedir(), '.claude', 'projects');
  try { for (const dir of fs.readdirSync(root)) fs.rmSync(join(root, dir, `${forkId}.jsonl`), { force: true }); } catch {}
}

// Plan limits from `/usage` (account-wide, free: no model call).
function parseUsage(text) {
  const limits = [], tips = [];
  for (const line of text.split('\n')) {
    const m = /^Current (session|week \((.+)\)):\s*(\d+)% used(?:\s*·\s*resets (.+?))?\s*(?:\([^)]*\))?$/.exec(line.trim());
    if (/^Last 7d/.test(line.trim())) break; // tips: last 24h only
    if (m) limits.push({ name: m[1] === 'session' ? '5-hour limit' : `Weekly · ${m[2]}`, percent: +m[3], resets: m[4] || null });
    else if (/^\d+%\s{2,}/.test(line.trim()) && tips.length < 5) tips.push(line.trim().replace(/\s{2,}/, ' '));
  }
  return { limits, tips };
}

let usageCache = null;
function claudeUsage() {
  if (usageCache && Date.now() - usageCache.at < 60000) return usageCache.p;
  const p = new Promise((resolve, reject) => {
    execFile('claude', ['-p', '--output-format', 'json', '/usage'], { cwd: os.homedir(), timeout: 30000, env: { ...process.env, CLIDECK_SESSION_ID: '' } }, (err, stdout) => {
      let j; try { j = JSON.parse(stdout); } catch { return reject(new Error(err?.message?.slice(0, 200) || 'claude returned no JSON')); }
      removeFork(j.session_id);
      const u = parseUsage(String(j.result || ''));
      u.limits.length ? resolve(u) : reject(new Error('No plan limits reported (API key login?)'));
    });
  });
  usageCache = { at: Date.now(), p };
  p.catch(() => { usageCache = null; });
  return p;
}

module.exports = { parseContext, claudeContext, parseUsage, claudeUsage };
