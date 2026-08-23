const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

function sha256(relativePath) {
  return crypto
    .createHash('sha256')
    .update(fs.readFileSync(path.join(root, relativePath)))
    .digest('hex');
}

test('bundled OCR language data matches the documented fixed upstream files', () => {
  assert.equal(
    sha256('tessdata/chi_sim.traineddata'),
    'a5fcb6f0db1e1d6d8522f39db4e848f05984669172e584e8d76b6b3141e1f730'
  );
  assert.equal(
    sha256('tessdata/eng.traineddata'),
    '7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2'
  );
});

test('Apache-2.0 text is retained for vendored jsQR and OCR data', () => {
  const license = fs.readFileSync(path.join(root, 'LICENSES/Apache-2.0.txt'), 'utf8');
  const notices = fs.readFileSync(path.join(root, 'THIRD_PARTY_NOTICES.md'), 'utf8');
  assert.match(license, /Apache License\s+Version 2\.0, January 2004/);
  assert.match(notices, /87416418657359cb625c412a48b6e1d6d41c29bd/);
  assert.match(notices, /LICENSES\/Apache-2\.0\.txt/);
});
