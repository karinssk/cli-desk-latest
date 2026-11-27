// Fable team members switch to Opus while the Fable weekly limit is at or past 80% (the last 20% is kept for
// final reviews before fabrication), and switch back once the limit resets. At 95% reviews stop using Fable too.
const FALLBACK_AT = 80, NO_FABLE_AT = 95;

const fablePercent = usage => usage?.limits?.find(l => /fable/i.test(l.name))?.percent ?? null;
const launchModel = s => { const a = s?.launch?.args || []; const i = a.indexOf('--model'); return i >= 0 ? a[i + 1] : null; };
const isFableMember = s => /claude/.test(s?.presetId || '') && launchModel(s) === 'fable';
const wantedModel = pct => (pct !== null && pct >= FALLBACK_AT ? 'opus' : 'fable');

// Types `/model <x>` into idle Fable members whose live model differs. Returns ids switched.
function syncFableModel(sessionsApi, usage, onlyId) {
  const pct = fablePercent(usage);
  if (pct === null) return [];
  const want = wantedModel(pct), switched = [];
  for (const [id, s] of sessionsApi.getSessions()) {
    if ((onlyId && id !== onlyId) || s.working || !isFableMember(s) || (s._liveModel || 'fable') === want) continue;
    sessionsApi.input({ id, data: `/model ${want}` });
    setTimeout(() => sessionsApi.input({ id, data: '\r' }), 400);
    s._liveModel = want;
    switched.push(id);
    console.log(`[fable] ${s.name}: Fable weekly ${pct}% -> /model ${want}`);
  }
  return switched;
}

// Line added to an ask sent to a Fable member while the limit is high, so its review subagents follow the same rule.
function quotaNote(usage) {
  const pct = fablePercent(usage);
  if (pct === null || pct < FALLBACK_AT) return '';
  return pct >= NO_FABLE_AT
    ? `(Fable weekly limit at ${pct}%: you are on Opus until it resets. Do not use Fable, including subagents; run reviews on Opus.)`
    : `(Fable weekly limit at ${pct}%: you are on Opus until it resets. Use a Fable subagent only for the final review before fabrication.)`;
}

module.exports = { FALLBACK_AT, NO_FABLE_AT, fablePercent, isFableMember, wantedModel, syncFableModel, quotaNote };
