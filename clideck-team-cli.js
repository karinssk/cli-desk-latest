const http = require('http');
const { PRESETS } = require('./team');

const usage = () => [
  'Usage:',
  '  clideck team create [preset]',
  '',
  'Opens a full agent team in the caller session\'s project and folder.',
  `Presets: ${Object.entries(PRESETS).map(([k, m]) => `${k} (${m.map(x => `${x.name}/${x.model}`).join(', ')})`).join('; ')}`,
  'Give the Orchestrator your task; it plans, sends slices to the Devs, and reviews and tests with subagents.',
].join('\n');

function post(path, body) {
  const port = process.env.CLIDECK_PORT || process.env.PORT || '4000';
  const url = new URL(path, process.env.CLIDECK_URL || `http://127.0.0.1:${port}`);
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' } }, res => {
      let data = ''; res.setEncoding('utf8');
      res.on('data', c => { data += c; });
      res.on('end', () => {
        let j = {}; try { j = JSON.parse(data); } catch {}
        res.statusCode >= 400 ? reject(new Error(j.error || `Failed (${res.statusCode})`)) : resolve(j);
      });
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

async function run(args) {
  try {
    if (args[0] !== 'create' || args.includes('-h') || args.includes('--help')) { console.log(usage()); return; }
    const callerSessionId = process.env.CLIDECK_SESSION_ID;
    if (!callerSessionId) throw new Error('CLIDECK_SESSION_ID is missing. Run this from inside a CliDeck session.');
    const r = await post('/api/team/create', { callerSessionId, preset: args[1] || 'coding' });
    console.log(`Team ${r.teamId} opened:`);
    for (const m of r.members) console.log(`  ${m.name} (${m.role}, ${m.model}) id=${m.id}`);
    console.log(`Next: give your task to "${r.members[0].name}".`);
  } catch (e) { process.stderr.write(`${e.message}\n`); process.exitCode = 1; }
}

module.exports = { run };
