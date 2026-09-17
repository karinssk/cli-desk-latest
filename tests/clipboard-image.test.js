const assert = require('assert');
const { existsSync, unlinkSync } = require('fs');
const { saveClipboardImage } = require('../handlers');

const path = saveClipboardImage('image/png', 'iVBORw0KGgo=');
assert(path.endsWith('.png') && existsSync(path));
unlinkSync(path);
assert.throws(() => saveClipboardImage('text/plain', 'aGVsbG8='));
assert.throws(() => saveClipboardImage('image/png', 'aGVsbG8='));
