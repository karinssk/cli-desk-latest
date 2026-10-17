const { sendJson, isLoopback } = require('./http-util');
const { stripAnsi } = require('./ansi-utils');
const { Terminal } = require('@xterm/xterm');
const { createHash } = require('node:crypto');

const recoveries = new Map();
const QUIET_MS = 5000;
const COOLDOWN_MS = 30000;
const MAX_ATTEMPTS = 3;

function failedScreen(lines) {
  const text = lines.map(line => line.trim()).filter(Boolean);
  const error = text.findLastIndex(line => /^■\s*\{\s*"detail"\s*:\s*"Bad Request"\s*\}$/.test(line));
  if (error < 0) return false;
  const after = text.slice(error + 1);
  const emptyPrompt = line => /^›(?: Ask Codex to do anything)?$/.test(line);
  if (!after.some(emptyPrompt)) return false;
  return after.every(line => emptyPrompt(line) || /^\? for shortcuts\b/.test(line)
    || /^⚠\s*\d+ warnings?\b/.test(line) || /^Copied \d+ chars/.test(line)
    || /^GPT-[\w.-]+\s+(?:low|medium|high|xhigh|max|ultra)\s*·\s*Context\b/i.test(line));
}

function progressKey(lines) {
  const text = lines.map(line => line.trim()).filter(Boolean);
  const error = text.findLastIndex(line => /^■\s*\{\s*"detail"\s*:\s*"Bad Request"\s*\}$/.test(line));
  if (error < 0) return '';
  const before = text.slice(0, error);
  const tool = before.findLastIndex(line => /^[•●]\s+(?:Ran|Viewed image|Edited|Added|Updated|Deleted|Explored)\b/.test(line));
  // ponytail: visible tool-block heuristic; use structured tool events if screen truncation changes signatures.
  const block = before.slice(tool).filter(line => !/esc to interrupt|^\? for shortcuts|^⚠|^GPT-|^›|^Copied \d+ chars/i.test(line));
  return tool < 0 ? '' : createHash('sha256').update(block.join('\n')).digest('hex');
}

async function refreshScreen(session) {
  if (!session || session.presetId !== 'codex') return;
  if (!session._masterScreen) {
    session._masterScreen = new Terminal({ cols: session.pty?.cols || 220, rows: session.pty?.rows || 60, scrollback: 0 });
    session._masterScreenVersion = 0;
  }
  const screen = session._masterScreen;
  const cols = session.pty?.cols || 220, rows = session.pty?.rows || 60;
  if (screen.cols !== cols || screen.rows !== rows) screen.resize(cols, rows);
  const chunks = session.chunks;
  const version = session.outputVersion ?? chunks.length;
  const count = version - session._masterScreenVersion;
  if (count > chunks.length) screen.reset();
  const pending = count > 0 ? chunks.slice(-count) : [];
  if (pending.length) {
    await new Promise(resolve => screen.write(pending.join(''), resolve));
    session._masterScreenVersion = version;
  }
  const lines = [];
  const buffer = screen.buffer.active;
  for (let i = 0; i < buffer.length; i++) lines.push(buffer.getLine(i).translateToString(true));
  session._masterFailedScreen = failedScreen(lines);
  if (session._masterFailedScreen) session._masterProgress = progressKey(lines);
}

function recoveryError(session, expectedOutputAt, now = Date.now()) {
  if (!session) return 'Session is closed';
  if (session.presetId === 'shell') return 'Shell sessions cannot be recovered';
  if (session.presetId === 'codex' && !session._masterFailedScreen) return 'No recoverable error on the current Codex screen';
  if (session.working !== false && !session._masterFailedScreen) return 'Session is working or status is unknown';
  if (session._menuKey) return 'Session is waiting for user input';
  if (!expectedOutputAt || session.lastOutputAt !== expectedOutputAt) return 'Session output changed';
  const outputAt = Date.parse(session.lastOutputAt);
  if (!Number.isFinite(outputAt) || now - outputAt < QUIET_MS) return 'Session output has not settled';
  if (Date.parse(session.lastInputAt) >= outputAt) return 'Session already received input';
  if (session._masterFailedScreen) return null;
  const tail = stripAnsi(session.chunks.join('').slice(-16000));
  const lines = tail.split('\n').map(line => line.trim()).filter(Boolean);
  const errorIndex = lines.findLastIndex(line => /^■\s*\{\s*"detail"\s*:\s*"Bad Request"\s*\}$/.test(line));
  if (errorIndex < 0) return 'No recoverable terminal error';
  if (lines.slice(errorIndex + 1).some(line => /[\p{L}\p{N}]/u.test(line))) return 'New output followed the error';
  return null;
}

function continueSession(payload, sessionsApi, now = Date.now()) {
  const id = String(payload.id || '');
  const session = sessionsApi.getSessions().get(id);
  const error = recoveryError(session, payload.expectedOutputAt, now);
  if (error) throw Object.assign(new Error(error), { status: 409 });
  const saved = recoveries.get(id);
  const previous = saved?.token === session.sessionToken ? saved : null;
  if (previous && (previous.outputAt === payload.expectedOutputAt || now - previous.at < COOLDOWN_MS)) {
    throw Object.assign(new Error('Recovery is already pending or cooling down'), { status: 409 });
  }
  const progress = session._masterProgress || '';
  const progressed = progress && previous?.progress && progress !== previous.progress;
  const attempts = progressed ? 0 : previous?.attempts || 0;
  if (attempts >= MAX_ATTEMPTS) throw Object.assign(new Error('Recovery attempt limit reached without new tool progress'), { status: 409 });
  const record = { at: now, outputAt: payload.expectedOutputAt, token: session.sessionToken, progress, attempts: attempts + 1 };
  recoveries.set(id, record);
  const inputAt = session.lastInputAt;
  setTimeout(() => {
    const current = sessionsApi.getSessions().get(id);
    if (current !== session || current.sessionToken !== record.token || (current.working !== false && !current._masterFailedScreen) || current._menuKey
      || current.lastInputAt !== inputAt || current.lastOutputAt !== record.outputAt) return;
    sessionsApi.input({ id, data: '\x1b[200~continue\x1b[201~\r' });
  }, 500);
  return { ok: true, attempt: record.attempts };
}

async function handleHttp(req, res, sessionsApi) {
  try {
    if (!isLoopback(req) || req.headers.origin) throw Object.assign(new Error('Master accepts local CLI requests only'), { status: 403 });
    if (req.method === 'GET' && req.url === '/api/master/sessions') {
      for (const session of sessionsApi.getSessions().values()) await refreshScreen(session);
      return sendJson(res, 200, { sessions: sessionsApi.list().map(row => {
        const session = sessionsApi.getSessions().get(row.id);
        const error = recoveryError(session, row.lastOutputAt);
        const recoveryEpoch = createHash('sha256').update(`${row.startedAt || ''}:${session?.sessionToken || ''}`).digest('hex');
        return { ...row, recoverableError: !error, recoveryError: error, recoveryProgress: session?._masterProgress || '', recoveryEpoch };
      }) });
    }
    if (req.method !== 'POST' || req.url !== '/api/master/continue') return sendJson(res, 405, { error: 'Method not allowed' });
    let body = '';
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 4096) return sendJson(res, 413, { error: 'Request too large' });
    }
    let payload;
    try { payload = JSON.parse(body); } catch { return sendJson(res, 400, { error: 'Invalid JSON' }); }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return sendJson(res, 400, { error: 'Invalid payload' });
    sendJson(res, 200, continueSession(payload, sessionsApi));
  } catch (error) {
    sendJson(res, error.status || 500, { error: error.message });
  }
}

module.exports = { handleHttp, continueSession, recoveryError, refreshScreen, failedScreen, progressKey };
