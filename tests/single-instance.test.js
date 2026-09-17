const assert = require('assert');
const net = require('net');
const { isServerReachable } = require('../single-instance');

(async () => {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  assert.equal(await isServerReachable({ host: '127.0.0.1', port }), true);
  await new Promise(resolve => server.close(resolve));
  assert.equal(await isServerReachable({ host: '127.0.0.1', port }), false);
})().catch(err => { console.error(err); process.exit(1); });
