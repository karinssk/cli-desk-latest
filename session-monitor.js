// Only copy known, bounded metadata from agent events into session state.
// Prompts, message parts, and provider credentials never enter this object.
const fs = require('fs');
const { join } = require('path');
function count(value) {
  const n = typeof value === 'number' ? value : (typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

function label(value) {
  return typeof value === 'string' && /^[^\x00-\x1f\x7f]{1,100}$/u.test(value) ? value : null;
}

function publish(session, id, broadcast, patch) {
  if (!Object.keys(patch).some(key => patch[key] !== session.monitor?.[key])) return;
  session.monitor = { ...session.monitor, ...patch };
  broadcast?.({ type: 'session.monitor', id, monitor: session.monitor });
}

function openCode(session, id, payload, broadcast) {
  if (payload.event !== 'message.updated' || payload.info?.role !== 'assistant') return;
  const info = payload.info;
  const patch = {};
  const model = label(info.modelID);
  const reasoning = label(info.variant);
  if (model && model !== session.monitor?.model) {
    patch.contextTokens = null;
    patch.contextWindow = null;
    patch.quota = null;
    patch.reasoning = null;
  }
  if (model) patch.model = model;
  if (reasoning) patch.reasoning = reasoning;

  const tokens = info.tokens;
  if (tokens && typeof tokens === 'object') {
    const input = count(tokens.input);
    const output = count(tokens.output);
    const reasoningTokens = count(tokens.reasoning) || 0;
    const read = count(tokens.cache?.read) || 0;
    const write = count(tokens.cache?.write) || 0;
    const total = count(tokens.total) ?? (input !== null && output !== null ? count(input + read + write + output + reasoningTokens) : null);
    if (total !== null) {
      patch.contextTokens = total;
      const window = count(info.model?.limit?.context);
      if (window > 0) patch.contextWindow = window;
    }
    if (total !== null && typeof info.id === 'string') {
      const seen = session._monitorMessages ||= new Map();
      seen.set(info.id, total); // repeated updates replace the same message's count
      patch.observedTokens = count([...seen.values()].reduce((sum, n) => sum + n, 0));
    }
  }
  publish(session, id, broadcast, patch);
}

function telemetry(session, id, attrs, broadcast) {
  const patch = {};
  const model = label(attrs.model || attrs['model.name'] || attrs['gen_ai.request.model']);
  const reasoning = label(attrs.reasoning_effort || attrs['reasoning.effort']);
  if (model && model !== session.monitor?.model) {
    patch.contextTokens = null;
    patch.contextWindow = null;
    patch.quota = null;
    patch.reasoning = null;
  }
  if (model) patch.model = model;
  if (reasoning) patch.reasoning = reasoning;
  publish(session, id, broadcast, patch);
}

function findCodexRollout(root, token) {
  if (!/^[0-9a-f-]{36}$/i.test(token || '')) return null;
  const base = join(root, 'sessions');
  try {
    for (const year of fs.readdirSync(base).sort().reverse()) {
      if (!/^\d{4}$/.test(year)) continue;
      for (const month of fs.readdirSync(join(base, year)).sort().reverse()) {
        if (!/^\d{2}$/.test(month)) continue;
        for (const day of fs.readdirSync(join(base, year, month)).sort().reverse()) {
          if (!/^\d{2}$/.test(day)) continue;
          const dir = join(base, year, month, day);
          const file = fs.readdirSync(dir).find(name => name.endsWith(`-${token}.jsonl`));
          if (file) return join(dir, file);
        }
      }
    }
  } catch {}
  return null;
}

function codex(session, id, broadcast) {
  if (!session._codexHome || !session.sessionToken) return;
  if (session._monitorToken !== session.sessionToken) {
    if (session._monitorToken) {
      session.monitor = {};
      broadcast?.({ type: 'session.monitor', id, monitor: {} });
    }
    session._monitorToken = session.sessionToken;
    session._monitorFile = null;
    session._monitorOffset = 0;
    session._monitorRemainder = '';
    session._monitorFindAfter = 0;
  }
  if (!session._monitorFile && Date.now() < session._monitorFindAfter) return;
  const file = session._monitorFile ||= findCodexRollout(session._codexHome, session.sessionToken);
  if (!file) session._monitorFindAfter = Date.now() + 10000;
  if (!file) return;
  let size;
  try { size = fs.statSync(file).size; } catch { return; }
  if (size === session._monitorOffset) return;
  // ponytail: 256 KiB per poll is enough for recent metadata; a turn that writes
  // more between polls skips older events and resumes at the newest tail.
  const previous = session._monitorOffset || 0;
  const start = size < previous ? Math.max(0, size - 262144)
    : Math.max(previous, size - 262144);
  const length = Math.min(262144, size - start);
  const data = Buffer.alloc(length);
  let fd, bytesRead;
  try { fd = fs.openSync(file, 'r'); bytesRead = fs.readSync(fd, data, 0, length, start); }
  catch { return; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
  const raw = (start === previous ? session._monitorRemainder || '' : '') + data.subarray(0, bytesRead).toString('utf8');
  const lines = raw.split('\n');
  session._monitorRemainder = lines.pop().slice(-4096);
  session._monitorOffset = start + bytesRead;
  if (start > 0 && start !== previous) lines.shift();
  for (const line of lines) {
    if (line.includes('"type":"token_count"') && line.length <= 65536) {
      let payload;
      try { payload = JSON.parse(line).payload; } catch { continue; }
      const info = payload?.info;
      const patch = {};
      const used = count(info?.last_token_usage?.total_tokens);
      const window = count(info?.model_context_window);
      const total = count(info?.total_token_usage?.total_tokens);
      if (used !== null) patch.contextTokens = used;
      if (window > 0) patch.contextWindow = window;
      if (total !== null) patch.cumulativeTokens = total;
      const usedPercent = payload?.rate_limits?.primary?.used_percent;
      if (typeof usedPercent === 'number' && Number.isFinite(usedPercent) && usedPercent >= 0 && usedPercent <= 100)
        patch.quota = `${usedPercent}% used`;
      publish(session, id, broadcast, patch);
    } else if (line.includes('"type":"turn_context"')) {
      const prefix = line.slice(0, 4096);
      const model = label(prefix.match(/"model":"([^"]+)"/)?.[1]);
      const reasoning = label(prefix.match(/"effort":"([^"]+)"/)?.[1]);
      publish(session, id, broadcast, {
        ...(model && model !== session.monitor?.model && { contextTokens: null, contextWindow: null, reasoning: null, quota: null }),
        ...(model && { model }), ...(reasoning && { reasoning }),
      });
    }
  }
}

module.exports = { openCode, telemetry, codex };
