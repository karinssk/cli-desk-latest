const http = require('http');
const https = require('https');
const WebSocket = require('ws');
const { stripAnsi } = require('./ansi-utils');

const POLL_MS = 5000;
const COOLDOWN_MS = 30000;
const MAX_RETRIES = 3;
const BAD_REQUEST = /^■\s*\{\s*"detail"\s*:\s*"Bad Request"\s*\}$/;
const MARKER = /^\[CLIDECK:(DONE|BLOCKED|FAILED)\]$/;

function usage() {
  return [
    'Usage: clideck master [--today] [--recover (--session <id> ... | --all)] [--url <url>]',
    '',
    'Observe today\'s sessions in real time. Recovery is off by default.',
    'Recovery only retries a settled Bad Request at an empty prompt, including',
    'a stale working flag when the server verifies the rendered terminal screen.',
    '',
    '  --today        Show sessions started or active today (Asia/Bangkok).',
    '  --recover      Permit bounded recovery; requires --session or --all.',
    '  --session ID   Select one session ID for recovery; repeatable.',
    '  --all          Select all today\'s sessions for recovery.',
    '  --url URL      CliDeck URL (default: CLIDECK_URL or localhost port).',
    '  --timezone TZ  IANA timezone for today/log timestamps (default: Asia/Bangkok).',
    '  -h, --help     Show this help.',
  ].join('\n');
}

function parseArgs(args) {
  const port = process.env.CLIDECK_PORT || process.env.PORT || '4000';
  const out = { today: true, recover: false, all: false, sessions: [], url: process.env.CLIDECK_URL || `http://127.0.0.1:${port}`, timezone: 'Asia/Bangkok', live: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--today') out.today = true;
    else if (arg === '--recover') out.recover = true;
    else if (arg === '--all') out.all = true;
    else if (arg === '--session') {
      const id = args[++i];
      if (!id || id.startsWith('--')) throw new Error('--session requires an ID');
      out.sessions.push(id);
    } else if (arg === '--url' || arg === '--timezone') {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      out[arg === '--url' ? 'url' : 'timezone'] = value;
    } else if (arg === '--help' || arg === '-h') out.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (out.help) return out;
  if (out.recover && !out.all && !out.sessions.length) throw new Error('--recover requires --session <id> or --all');
  if (out.all && out.sessions.length) throw new Error('Choose --all or --session, not both');
  const url = new URL(out.url);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('--url must be HTTP or HTTPS');
  new Intl.DateTimeFormat('en-CA', { timeZone: out.timezone });
  return out;
}

function dayKey(value, timezone) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

function classifyLine(line) {
  const clean = stripAnsi(line).trim();
  if (BAD_REQUEST.test(clean)) return { kind: 'bad-request' };
  const marker = clean.match(MARKER);
  return marker ? { kind: 'marker', value: marker[1] } : null;
}

function safeSnippet(value) {
  const clean = stripAnsi(String(value || '')).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').replace(/\s+/g, ' ').trim()
    .replace(/\b(Bearer\s+)[^\s]+/gi, '$1[redacted]')
    .replace(/\b(token|password|api[_-]?key|secret)\s*[:=]\s*\S+/gi, '$1=[redacted]')
    .replace(/\b[A-Za-z0-9+/_=-]{48,}\b/g, '[redacted]');
  return clean.length > 160 ? clean.slice(0, 159) + '…' : clean;
}

function newEvidence() { return { tail: '', latestLine: '', error: false, marker: null, markerAt: 0, lastOutputAt: 0, lastActivityLogAt: 0 }; }

function observeOutput(evidence, data, now = Date.now()) {
  if (!data) return [];
  const lines = (evidence.tail + String(data).replace(/\r/g, '\n')).split('\n');
  evidence.tail = lines.pop().slice(-4096);
  evidence.lastOutputAt = now;
  const signals = [];
  for (const line of lines) {
    const clean = stripAnsi(line).trim();
    if (!clean) continue;
    const signal = classifyLine(clean);
    if (signal?.kind === 'bad-request') { evidence.error = true; evidence.latestLine = clean; }
    else if (/[\p{L}\p{N}]/u.test(clean)) { evidence.error = false; evidence.latestLine = clean; }
    if (signal?.kind === 'marker') { evidence.marker = signal.value; evidence.markerAt = now; }
    if (signal) signals.push(signal);
  }
  // Prompt chrome (e.g. "› ") is not progress; a partial word is.
  if (classifyLine(evidence.tail)?.kind === 'bad-request') evidence.error = true;
  else if (/[\p{L}\p{N}]/u.test(stripAnsi(evidence.tail))) evidence.error = false;
  return signals;
}

function recoveryDecision(session, evidence, state, opts, now = Date.now()) {
  if (session.recoveryEpoch && state.epoch !== session.recoveryEpoch) {
    state.epoch = session.recoveryEpoch;
    state.attempts = 0;
    state.progress = '';
    state.attemptedOutputAt = null;
    state.lastAttemptAt = -Infinity;
  }
  if (!opts.recover) return 'observe-only';
  if (!opts.all && !opts.sessions.includes(session.id)) return 'not-selected';
  if (!opts.live) return 'live-feed-unavailable';
  if (session.recoverableError !== true && (!session.statusKnown || session.working)) return 'not-idle';
  if (session.menu && (!Array.isArray(session.menu) || session.menu.length)) return 'menu-active';
  if (evidence.marker && Date.parse(session.lastInputAt || '') > evidence.markerAt) evidence.marker = null;
  if (evidence.marker) return `terminal-${evidence.marker.toLowerCase()}`;
  if (session.recoverableError !== true && !evidence.error) return 'no-current-error';
  const outputAt = Date.parse(session.lastOutputAt || '');
  if (!Number.isFinite(outputAt) || now - outputAt < POLL_MS) return 'waiting-to-settle';
  const inputAt = Date.parse(session.lastInputAt || '');
  if (Number.isFinite(inputAt) && inputAt >= outputAt) return 'input-after-error';
  if (session.recoveryProgress && state.progress && session.recoveryProgress !== state.progress) {
    state.attempts = 0;
    state.progress = session.recoveryProgress;
  }
  if (state.attempts >= MAX_RETRIES) return 'retry-limit';
  if (state.pending) return 'request-pending';
  if (now - state.lastAttemptAt < COOLDOWN_MS) return 'cooldown';
  if (state.attemptedOutputAt === session.lastOutputAt) return 'already-attempted';
  return 'recover';
}

function requestJson(base, path, method = 'GET', body, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const payload = body === undefined ? null : JSON.stringify(body);
    const client = url.protocol === 'https:' ? https : http;
    const req = client.request(url, { method, timeout: 5000, headers: { ...headers, ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}) } }, res => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { raw += chunk; if (raw.length > 1024 * 1024) req.destroy(new Error('CliDeck response too large')); });
      res.on('end', () => {
        if (res.statusCode === 404) return reject(new Error('Master API unavailable; restart CliDeck with the updated server'));
        let parsed;
        try { parsed = JSON.parse(raw); } catch { return reject(new Error('CliDeck returned invalid JSON')); }
        if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error(parsed.error || `HTTP ${res.statusCode}`));
        resolve(parsed);
      });
    });
    req.on('timeout', () => req.destroy(new Error('CliDeck request timed out')));
    req.on('error', reject);
    req.end(payload || undefined);
  });
}

async function run(args) {
  let opts;
  try { opts = parseArgs(args); } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; return; }
  if (opts.help) { process.stdout.write(usage() + '\n'); return; }
  const day = dayKey(Date.now(), opts.timezone);
  const clock = new Intl.DateTimeFormat('en-GB', { timeZone: opts.timezone, dateStyle: 'short', timeStyle: 'medium', hour12: false });
  const log = (id, message) => process.stdout.write(`[${clock.format(new Date())}] ${id ? `${id} ` : ''}${message}\n`);
  const evidence = new Map();
  const states = new Map();
  const visible = new Map();
  const selected = session => [session.startedAt, session.lastInputAt, session.lastOutputAt]
    .some(value => value && dayKey(value, opts.timezone) === dayKey(Date.now(), opts.timezone));
  const stateFor = id => { if (!states.has(id)) states.set(id, { attempts: 0, lastAttemptAt: -Infinity, attemptedOutputAt: null, pending: false, lastDecision: null }); return states.get(id); };
  let polling = false;
  let stopped = false;
  let connected = false;
  const poll = async () => {
    if (polling || stopped) return;
    polling = true;
    try {
      const data = await requestJson(opts.url, '/api/master/sessions', 'GET', undefined,
        { 'X-CliDeck-Master': JSON.stringify({ recover: opts.recover, all: opts.all, ids: opts.sessions, timezone: opts.timezone }) });
      if (!Array.isArray(data.sessions)) throw new Error('CliDeck returned no sessions list');
      const seen = new Set();
      for (const session of data.sessions.filter(selected)) {
        seen.add(session.id);
        const prior = visible.get(session.id);
        visible.set(session.id, session);
        const status = !session.statusKnown ? 'unknown' : session.working && session.recoverableError === true
          ? 'failed/recoverable (working flag stale)' : session.working ? 'working' : 'idle';
        if (!prior) log(session.id, `${session.name || 'session'} joined; ${status}`);
        else if (prior.working !== session.working || prior.statusKnown !== session.statusKnown || prior.recoverableError !== session.recoverableError) log(session.id, `status ${status}`);
        const ev = evidence.get(session.id) || newEvidence();
        const state = stateFor(session.id);
        const lastActivityAt = Math.max(...[session.startedAt, session.lastInputAt, session.lastOutputAt].map(value => Date.parse(value || '') || 0));
        const suspectedStuck = session.statusKnown && session.working && session.recoverableError !== true && Date.now() - lastActivityAt >= 120000;
        if (suspectedStuck && !state.stuck) log(session.id, 'suspected stuck: working but no input/output for 2m; observe only');
        state.stuck = suspectedStuck;
        const decision = recoveryDecision(session, ev, state, opts);
        if (decision !== state.lastDecision && opts.recover && (decision !== 'not-selected' || opts.sessions.includes(session.id))) {
          log(session.id, decision === 'recover' ? 'recovery eligible' : `recovery: ${decision}`);
          state.lastDecision = decision;
        }
        if (decision !== 'recover') continue;
        state.pending = true;
        state.lastAttemptAt = Date.now();
        state.attemptedOutputAt = session.lastOutputAt;
        state.progress = session.recoveryProgress || state.progress;
        state.attempts++;
        log(session.id, `recovery request ${state.attempts}/${MAX_RETRIES}`);
        try {
          await requestJson(opts.url, '/api/master/continue', 'POST', { id: session.id, expectedOutputAt: session.lastOutputAt });
          log(session.id, 'recovery accepted by server');
          ev.error = false;
        } catch (error) { log(session.id, `recovery rejected: ${safeSnippet(error.message)}`); }
        finally { state.pending = false; }
      }
      for (const [id] of visible) if (!seen.has(id)) { visible.delete(id); log(id, 'session closed or outside today; no auto-resume'); }
    } catch (error) { log('', `snapshot unavailable: ${String(error.message).replace(/[\r\n\x00-\x1f]/g, ' ').slice(0, 100)}`); }
    finally { polling = false; }
  };
  const wsUrl = new URL(opts.url);
  wsUrl.protocol = wsUrl.protocol === 'https:' ? 'wss:' : 'ws:';
  let socket;
  let reconnectTimer;
  const connect = () => {
    if (stopped) return;
    socket = new WebSocket(wsUrl);
    socket.on('open', () => { connected = true; opts.live = true; log('', 'live feed connected'); });
    socket.on('message', raw => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      if (msg.type === 'sessions' && Array.isArray(msg.list)) {
        for (const session of msg.list.filter(selected)) visible.set(session.id, session);
      } else if (msg.type === 'created' && msg.id) {
        visible.set(msg.id, { ...msg, startedAt: new Date().toISOString(), statusKnown: false, working: false });
        log(msg.id, `${msg.name || 'session'} created; waiting for status`);
      } else if (msg.type === 'output' && msg.id) {
        const ev = evidence.get(msg.id) || newEvidence();
        evidence.set(msg.id, ev);
        const signals = observeOutput(ev, msg.data);
        if (msg.replay) ev.marker = null;
        if (!msg.replay && visible.has(msg.id)) {
          for (const signal of signals) log(msg.id, signal.kind === 'marker' ? `[CLIDECK:${signal.value}]` : 'Bad Request (terminal error)');
          if (!signals.length && Date.now() - ev.lastActivityLogAt >= 2000) {
            const snippet = safeSnippet(msg.data);
            if (snippet) log(msg.id, snippet);
            ev.lastActivityLogAt = Date.now();
          }
        }
      } else if (msg.type === 'closed' && msg.id) {
        visible.delete(msg.id);
        evidence.delete(msg.id);
        log(msg.id, 'session closed; no auto-resume');
      } else if (msg.type === 'session.status' && visible.has(msg.id)) {
        log(msg.id, `live status ${msg.working ? 'working' : 'idle'}`);
      }
    });
    socket.on('error', error => { log('', `live feed error: ${String(error.message).slice(0, 100)}`); });
    socket.on('close', () => {
      if (connected) log('', 'live feed disconnected');
      connected = false;
      opts.live = false;
      if (!stopped) reconnectTimer = setTimeout(connect, POLL_MS);
    });
  };
  log('', `monitoring ${day} ${opts.timezone}; ${opts.recover ? 'recovery enabled' : 'observe-only'}`);
  await poll();
  connect();
  const interval = setInterval(poll, POLL_MS);
  const stop = () => { stopped = true; clearInterval(interval); clearTimeout(reconnectTimer); socket?.close(); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

module.exports = { run, parseArgs, dayKey, classifyLine, safeSnippet, newEvidence, observeOutput, recoveryDecision };
