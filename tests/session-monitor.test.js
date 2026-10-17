const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const { join } = require('path');
const monitor = require('../session-monitor');
const bridge = require('../opencode-bridge');

const messages = [];
const broadcast = value => messages.push(value);
const open = {};
const event = (id, input, output, modelID = 'provider/model-a') => ({
  event: 'message.updated', info: { id, role: 'assistant', modelID, variant: 'high', tokens: { input, output, cache: { read: 5, write: 2 } } },
});
monitor.openCode(open, 'oc', event('one', 10, 3), broadcast);
monitor.openCode(open, 'oc', event('one', 12, 4), broadcast);
monitor.openCode(open, 'oc', event('two', 20, 5), broadcast);
assert.equal(open.monitor.contextTokens, 32);
assert.equal(open.monitor.observedTokens, 55); // 23 + 32, no repeated-message double count
assert.equal(open.monitor.contextWindow, null);
assert.equal(open.monitor.cost, undefined);
monitor.openCode(open, 'oc', event('three', 2, 1, 'provider/model-b'), broadcast);
assert.equal(open.monitor.model, 'provider/model-b');
assert.equal(open.monitor.contextTokens, 10);
assert.equal(open.monitor.contextWindow, null);
monitor.openCode(open, 'oc', { event: 'message.updated', info: { id: 'bad', role: 'assistant', tokens: { input: -1, output: 'garbage' } } }, broadcast);
assert.equal(open.monitor.observedTokens, 65);

const bridged = new Map([['ui-session', {}]]);
bridge.init(broadcast, () => bridged);
bridge.watchSession('ui-session', '/tmp/project');
bridge.handleEvent({ event: 'session.created', clideckSessionId: 'ui-session', info: { id: 'oc-parent', directory: '/tmp/project' } });
bridge.handleEvent({ ...event('parent-message', 8, 2), clideckSessionId: 'ui-session', info: { ...event('parent-message', 8, 2).info, sessionID: 'oc-parent', parentID: 'user-message' } });
const beforeSubagent = bridged.get('ui-session').monitor.observedTokens;
bridge.handleEvent({ event: 'session.created', clideckSessionId: 'ui-session', info: { id: 'oc-child', parentID: 'oc-parent' } });
bridge.handleEvent({ ...event('child-message', 100, 100), clideckSessionId: 'ui-session', info: { ...event('child-message', 100, 100).info, sessionID: 'oc-child' } });
assert.equal(bridged.get('ui-session').monitor.observedTokens, beforeSubagent);
bridge.handleEvent({ event: 'session.created', clideckSessionId: 'ui-session', info: { id: 'oc-new', directory: '/tmp/project' } });
assert.equal(bridged.get('ui-session').sessionToken, 'oc-new');
assert.deepEqual(bridged.get('ui-session').monitor, {});
assert.equal(bridged.get('ui-session')._monitorMessages.size, 0);
assert.equal(messages.at(-1).statusKnown, false);
bridge.handleEvent({ event: 'session.updated', clideckSessionId: 'ui-session', info: { id: 'oc-parent' } });
assert.equal(bridged.get('ui-session').sessionToken, 'oc-new');
bridge.handleEvent({ ...event('parent-message', 3, 1), clideckSessionId: 'ui-session', info: { ...event('parent-message', 3, 1).info, sessionID: 'oc-new' } });
assert.equal(bridged.get('ui-session').monitor.observedTokens, 11);
bridge.clear('ui-session');
bridged.set('ui-session', {});
bridge.watchSession('ui-session', '/tmp/project');
bridge.handleEvent({ event: 'session.created', info: { id: 'oc-untagged', directory: '/tmp/project' } });
assert.equal(bridged.get('ui-session').sessionToken, 'oc-untagged');
bridge.handleEvent({ event: 'session.created', clideckSessionId: 'ui-session', info: { id: 'oc-parent-2', directory: '/tmp/project' } });
assert.equal(bridged.get('ui-session').sessionToken, 'oc-parent-2');
bridge.handleEvent({ ...event('corrected', 3, 2), clideckSessionId: 'ui-session', info: { ...event('corrected', 3, 2).info, sessionID: 'oc-parent-2' } });
assert.equal(bridged.get('ui-session').monitor.model, 'provider/model-a');
bridge.clear('ui-session');

const root = fs.mkdtempSync(join(os.tmpdir(), 'clideck-monitor-'));
const token = '12345678-1234-1234-1234-123456789abc';
const dir = join(root, 'sessions', '2026', '10', '16');
fs.mkdirSync(dir, { recursive: true });
const path = join(dir, `rollout-test-${token}.jsonl`);
const line = value => JSON.stringify(value) + '\n';
try {
  fs.writeFileSync(path, line({ type: 'turn_context', payload: { model: 'gpt-6-sol', effort: 'high', user_instructions: 'never surface this' } })
    + line({ type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 45000, total_tokens: 45200 }, total_token_usage: { total_tokens: 120000 }, model_context_window: 258400 }, rate_limits: { primary: { used_percent: 26 } } } }));
  const codex = { _codexHome: root, sessionToken: token };
  monitor.codex(codex, 'cx', broadcast);
  assert.deepEqual([codex.monitor.model, codex.monitor.reasoning, codex.monitor.contextTokens, codex.monitor.contextWindow, codex.monitor.cumulativeTokens],
    ['gpt-6-sol', 'high', 45200, 258400, 120000]);
  assert.equal(codex.monitor.quota, '26% used');
  fs.appendFileSync(path, line({ type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 12000, total_tokens: 12100 }, total_token_usage: { total_tokens: 132000 }, model_context_window: 258400 } } }));
  monitor.codex(codex, 'cx', broadcast);
  assert.equal(codex.monitor.contextTokens, 12100); // compaction lowers occupancy
  assert.equal(codex.monitor.cumulativeTokens, 132000);
  assert.equal(JSON.stringify(messages).includes('never surface this'), false);
  const nextToken = '12345678-1234-1234-1234-123456789abd';
  fs.writeFileSync(join(dir, `rollout-test-${nextToken}.jsonl`), line({ type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { total_tokens: 7 }, total_token_usage: { total_tokens: 7 }, model_context_window: 100 } } }));
  codex.sessionToken = nextToken;
  monitor.codex(codex, 'cx', broadcast);
  assert.equal(codex.monitor.contextTokens, 7);
  assert.equal(codex.monitor.cumulativeTokens, 7);
  assert.equal(codex.monitor.model, undefined);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
console.log('session monitor check passed');
