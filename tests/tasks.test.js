// tasks.js: report parsing (ATTACH / VERDICT / markers), folder confinement, and the task log.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const { join } = require('node:path');
const home = fs.mkdtempSync(join(os.tmpdir(), 'clideck-tasks-'));
process.env.HOME = home; // tasks.jsonl goes to a temp ~/.clideck
const tasks = require('../tasks');

const proj = join(home, 'proj');
fs.mkdirSync(join(proj, 'shots'), { recursive: true });
fs.writeFileSync(join(proj, 'shots', 'a.png'), 'x');
fs.writeFileSync(join(home, 'secret.txt'), 'x');

const r = tasks.parseReport('All good.\n**VERDICT: PASS**\nATTACH: shots/a.png\nATTACH: ../secret.txt\nATTACH: missing.png\n[CLIDECK:DONE]', proj);
assert.equal(r.report, 'All good.');
assert.equal(r.verdict, 'PASS');
assert.equal(r.marker, 'DONE');
assert.deepEqual(r.files.map(f => [f.name, f.image]), [['a.png', true]]);
assert.equal(r.notes.length, 2); // outside folder + missing

const sent = [];
tasks.setBroadcast(m => sent.push(m));
const t = tasks.start({ fromId: 'A', fromName: 'Lead', toId: 'B', toName: 'Tester', task: 'test login' });
assert.equal(t.status, 'working');
tasks.finish(t.id, { text: 'Checked.\nATTACH: shots/a.png\nVERDICT: CHANGES_NEEDED\n[CLIDECK:DONE]', cwd: proj });
const [done] = tasks.list('B');
assert.equal(done.status, 'done');
assert.equal(done.verdict, 'CHANGES_NEEDED');
assert.deepEqual(done.files, [{ name: 'a.png', size: 1, image: true }]); // no server path sent to clients
assert.ok(tasks.filePath(t.id, 0).endsWith('a.png'));
assert.equal(tasks.filePath(t.id, 1), null);
assert.equal(sent.length, 2);
const failed = tasks.start({ fromId: 'A', toId: 'C', task: 'x' });
tasks.finish(failed.id, { error: 'Timed out waiting for target session response' });
assert.equal(tasks.list('C')[0].status, 'timeout');
assert.equal(fs.readFileSync(join(home, '.clideck', 'tasks.jsonl'), 'utf8').trim().split('\n').length, 4);
console.log('tasks checks passed');
