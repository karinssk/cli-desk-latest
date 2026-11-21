const http = require('http');
const { PRESETS } = require('./team');

const usage = () => [
  'Usage:',
  '  clideck team create [preset] [--project <name-or-id>]',
  '',
  'Opens a full agent team in the caller session\'s project and folder,',
  'or with --project in that CliDeck project\'s folder (works from any terminal).',
  `Presets: ${Object.entries(PRESETS).map(([k, m]) => `${k} (${m.map(x => `${x.name}/${x.model}`).join(', ')})`).join('; ')}`,
  'Give the Orchestrator your task; it plans, sends slices to the team members, and reviews and tests with subagents.',
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
    const rest = args.slice(1), i = rest.indexOf('--project');
    const project = i >= 0 ? rest.splice(i, 2)[1] : undefined;
    if (i >= 0 && !project) throw new Error('--project needs a project name or id');
    const callerSessionId = process.env.CLIDECK_SESSION_ID;
    if (!callerSessionId && !project) throw new Error('Run this inside a CliDeck session, or pass --project <name>.');
    const r = await post('/api/team/create', { callerSessionId, preset: rest[0] || 'coding', project });
    console.log(`Team ${r.teamId} opened:`);
    for (const m of r.members) console.log(`  ${m.name} (${m.role}, ${m.model}) id=${m.id}`);
    console.log(`Next: give your task to "${r.members[0].name}".`);
  } catch (e) { process.stderr.write(`${e.message}\n`); process.exitCode = 1; }
}

module.exports = { run };
