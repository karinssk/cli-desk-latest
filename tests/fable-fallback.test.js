// fable-fallback.js: Fable members go to Opus at >=80% weekly Fable use, back after reset; idle only.
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
process.env.CLAUDE_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-'));
const settings = path.join(process.env.CLAUDE_CONFIG_DIR, 'settings.json');
fs.writeFileSync(settings, JSON.stringify({ model: 'claude-opus-5-5', other: 1 }));
const f = require('../fable-fallback');

const usage = pct => ({ limits: [{ name: 'Weekly · all models', percent: 10 }, { name: 'Weekly · Fable', percent: pct }] });
const sessions = new Map([
  ['volt', { name: 'Volt', presetId: 'claude-code', launch: { args: ['--model', 'fable', '--effort', 'high'] } }],
  ['forge', { name: 'Forge', presetId: 'claude-code', launch: { args: ['--model', 'sonnet'] } }],
  ['busy', { name: 'Busy', presetId: 'claude-code', working: true, launch: { args: ['--model', 'fable'] } }],
]);
const typed = [];
const api = { getSessions: () => sessions, input: m => typed.push(m) };

assert.equal(f.fablePercent(usage(82)), 82);
assert.equal(f.fablePercent({ limits: [] }), null);
assert.deepEqual(f.syncFableModel(api, usage(50)), []);                 // under 80%: stays on Fable
assert.deepEqual(f.syncFableModel(api, usage(80)), ['volt']);           // only the idle Fable member
assert.deepEqual(typed[0], { id: 'volt', data: '/model opus' });
assert.deepEqual(f.syncFableModel(api, usage(90)), []);                 // already switched
assert.deepEqual(f.syncFableModel(api, usage(3)), ['volt']);            // limit reset: back to Fable
assert.equal(typed.at(-1).data, '/model fable');
assert.deepEqual(f.syncFableModel(api, { limits: [] }), []);            // no Fable limit reported: leave alone

assert.equal(f.quotaNote(usage(50)), '');
assert.match(f.quotaNote(usage(85)), /Fable subagent only for the final review/);
assert.match(f.quotaNote(usage(96)), /Do not use Fable/);
fs.writeFileSync(settings, JSON.stringify({ model: 'fable', other: 1 })); // what `/model fable` saves
setTimeout(() => { // default for new sessions put back, other settings kept
  assert.deepEqual(JSON.parse(fs.readFileSync(settings, 'utf8')), { model: 'claude-opus-5-5', other: 1 });
  console.log('fable-fallback tests passed');
  process.exit(0);
}, 3500);
