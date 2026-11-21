// parseContext reads the markdown Claude Code's /context prints in print mode.
const assert = require('node:assert/strict');
const { parseContext } = require('../claude-context');
const md = `## Context Usage\n\n**Model:** claude-sonnet-5-5  \n**Tokens:** 32.9k / 1m (3%)\n\n### Estimated usage by category\n\n| Category | Tokens | Percentage |\n|----------|--------|------------|\n| Messages | 17.5k | 1.7% |\n| MCP tools (deferred) | 32k | 3.2% |\n\n### Custom Agents\n\n| Agent Type | Source | Tokens |\n|------------|--------|--------|\n| a | Plugin | 110 |\n\n### Memory Files\n\n| Type | Path | Tokens |\n|------|------|--------|\n| User | /x/CLAUDE.md | 14 |\n`;
const r = parseContext(md);
assert.deepEqual([r.model, r.used, r.window, r.percent], ['claude-sonnet-5-5', 32900, 1e6, 3]);
assert.deepEqual(r.categories, [{ name: 'Messages', tokens: 17500, percent: 1.7 }, { name: 'MCP tools (deferred)', tokens: 32000, percent: 3.2 }]);
assert.deepEqual(r.lists, [{ name: 'Custom Agents', items: ['a'] }, { name: 'Memory Files', items: ['/x/CLAUDE.md'] }]);
console.log('claude context checks passed');
const { parseUsage } = require('../claude-context');
const u = parseUsage('Current session: 19% used · resets Nov 21 at 11:20am (Asia/Bangkok)\nCurrent week (all models): 10% used · resets Nov 24 at 10am (Asia/Bangkok)\n\nLast 24h · 2 requests\n  67%  Start fresh when you switch tasks · run /clear\n');
assert.deepEqual(u.limits, [{ name: '5-hour limit', percent: 19, resets: 'Nov 21 at 11:20am' }, { name: 'Weekly · all models', percent: 10, resets: 'Nov 24 at 10am' }]);
assert.deepEqual(u.tips, ['67% Start fresh when you switch tasks · run /clear']);
console.log('usage parse checks passed');
