// Task log for `clideck ask`: who asked whom, the task, the final report, VERDICT and ATTACH files.
// Stored as JSON lines in ~/.clideck/tasks.jsonl (one line per state change; the last line per id wins).
const fs = require('fs');
const os = require('os');
const { join, resolve, extname, basename } = require('path');
const { randomUUID } = require('crypto');
const { DATA_DIR } = require('./paths');

const FILE = join(DATA_DIR, 'tasks.jsonl');
const KEEP = 500, MAX_FILES = 12, MAX_FILE_MB = 25;
const tasks = new Map();
try {
  for (const line of fs.readFileSync(FILE, 'utf8').split('\n')) {
    try { const t = JSON.parse(line); if (t.id) tasks.set(t.id, t); } catch {}
  }
} catch {}
// ponytail: the log only grows; trimmed to the newest KEEP tasks at startup.
if (tasks.size > KEEP) {
  const keep = [...tasks.values()].slice(-KEEP);
  tasks.clear(); keep.forEach(t => tasks.set(t.id, t));
  try { fs.writeFileSync(FILE, keep.map(t => JSON.stringify(t)).join('\n') + '\n'); } catch {}
}

let broadcast = () => {};
const setBroadcast = fn => { broadcast = fn; };
function save(t) {
  tasks.set(t.id, t);
  try { fs.appendFileSync(FILE, JSON.stringify(t) + '\n'); } catch (e) { console.error('[tasks] save failed:', e.message); }
  broadcast({ type: 'task.update', task: publicTask(t) });
  return t;
}
// Files are served by index (/task-files/<id>/<n>), so paths never leave the server.
const publicTask = t => ({ ...t, files: (t.files || []).map(f => ({ name: f.name, size: f.size, image: f.image })) });

// Pulls "ATTACH: path", "VERDICT: X" and [CLIDECK:STATE] lines out of the report text.
// Files must exist inside the target's working folder.
function parseReport(text, cwd) {
  const files = [], notes = [];
  let verdict = null, marker = null;
  let root = null; try { root = cwd ? fs.realpathSync(cwd) + '/' : null; } catch {}
  const kept = [];
  for (const line of String(text || '').split('\n')) {
    const a = /^\s*[-*]?\s*ATTACH:\s*`?(.+?)`?\s*$/i.exec(line);
    const v = /^\s*\**VERDICT:\s*(PASS|CHANGES_NEEDED|FAIL(?:ED)?)\**\s*$/i.exec(line);
    const m = /^\s*\[CLIDECK:(DONE|BLOCKED|FAILED)\]\s*$/.exec(line);
    if (v) { verdict = v[1].toUpperCase().replace('FAILED', 'FAIL'); continue; }
    if (m) { marker = m[1]; continue; }
    if (!a) { kept.push(line); continue; }
    const raw = a[1].replace(/^~(?=\/)/, os.homedir());
    const path = root ? resolve(root, raw) : null;
    let real = null; try { real = fs.realpathSync(path); } catch {}
    const st = real && fs.statSync(real);
    if (!root || !real || !real.startsWith(root)) notes.push(`Not attached: ${a[1]} (outside the project folder or missing)`);
    else if (!st.isFile()) notes.push(`Not attached: ${a[1]} (not a file)`);
    else if (st.size > MAX_FILE_MB * 1048576) notes.push(`Not attached: ${a[1]} (over ${MAX_FILE_MB} MB)`);
    else if (files.length >= MAX_FILES) notes.push(`Not attached: ${a[1]} (more than ${MAX_FILES} files)`);
    else files.push({ path: real, name: basename(real), size: st.size, image: /^\.(png|jpe?g|gif|webp|svg)$/i.test(extname(real)) });
  }
  return { report: kept.join('\n').trim(), verdict, marker, files, notes };
}

// Last 2 MiB of a Claude Code transcript as lines (the end is what matters; big files would block the server).
function transcriptTail(sessionToken) {
  if (!/^[0-9a-f-]{36}$/i.test(sessionToken || '')) return [];
  const root = join(os.homedir(), '.claude', 'projects');
  let file = null;
  try { for (const d of fs.readdirSync(root)) { const f = join(root, d, `${sessionToken}.jsonl`); if (fs.existsSync(f)) { file = f; break; } } } catch {}
  if (!file) return [];
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size, n = Math.min(size, 2 << 20), buf = Buffer.alloc(n);
    fs.readSync(fd, buf, 0, n, size - n);
    const tail = buf.toString('utf8');
    return (n < size ? tail.slice(tail.indexOf('\n') + 1) : tail).split('\n');
  } finally { fs.closeSync(fd); }
}

// The last assistant text in a Claude Code session after `sinceTs`, read from its own transcript:
// clean markdown, unlike text scraped from the terminal screen.
function claudeReplySince(sessionToken, sinceTs) {
  let last = '';
  for (const line of transcriptTail(sessionToken)) {
    if (!line.includes('"assistant"')) continue;
    let j; try { j = JSON.parse(line); } catch { continue; }
    if (j.type !== 'assistant' || Date.parse(j.timestamp) < sinceTs) continue;
    const text = (j.message?.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n').trim();
    if (text) last = text;
  }
  return last;
}

// Background jobs (Bash run_in_background, async subagents) started after `sinceTs` with no completion
// notification yet. An Orchestrator ends its turn while Devs work; its real answer comes after these finish.
function claudePendingBackground(sessionToken, sinceTs) {
  const started = new Set(), ended = new Set();
  for (const line of transcriptTail(sessionToken)) {
    const launched = line.match(/running in background with ID: ([A-Za-z0-9_-]+)|agentId: ([A-Za-z0-9_-]+)/g);
    const done = line.match(/<task-id>[A-Za-z0-9_-]+<\/task-id>/g);
    if (!launched && !done) continue;
    let ts; try { ts = Date.parse(JSON.parse(line).timestamp); } catch { continue; }
    if (launched && ts >= sinceTs) for (const m of launched) started.add(m.split(/: /).pop());
    if (done) for (const m of done) ended.add(m.slice(9, -10));
  }
  return [...started].filter(id => !ended.has(id)).length;
}

function start({ fromId, fromName, toId, toName, project, task }) {
  return save({ id: randomUUID(), fromId, fromName, toId, toName, project: project || null, task: String(task).slice(0, 20000), status: 'working', startedAt: Date.now() });
}

function finish(id, { text, error, cwd, sessionToken, sinceTs }) {
  const t = tasks.get(id);
  if (!t) return null;
  if (error) return save({ ...t, status: /timed out/i.test(error) ? 'timeout' : 'failed', error, endedAt: Date.now() });
  const full = claudeReplySince(sessionToken, sinceTs) || text || '';
  const p = parseReport(full, cwd);
  const status = p.marker === 'BLOCKED' ? 'blocked' : p.marker === 'FAILED' ? 'failed' : 'done';
  return save({ ...t, status, report: p.report.slice(0, 100000), verdict: p.verdict, files: p.files, notes: p.notes, endedAt: Date.now() });
}

const list = sessionId => [...tasks.values()].filter(t => !sessionId || t.fromId === sessionId || t.toId === sessionId).slice(-100).reverse().map(publicTask);
const filePath = (id, n) => tasks.get(id)?.files?.[n]?.path || null;

module.exports = { start, finish, list, filePath, parseReport, setBroadcast, claudeReplySince, claudePendingBackground };
