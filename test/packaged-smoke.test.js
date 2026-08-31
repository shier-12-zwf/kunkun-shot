const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { findPackagedExecutable } = require('../scripts/test-packaged-electron-smoke');
const productName = require('../package.json').productName;

function executablePath(root, platformDir = 'mac-arm64') {
  return path.join(root, platformDir, `${productName}.app`, 'Contents', 'MacOS', productName);
}

function makeExecutable(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
}

test('packaged smoke resolves exactly one executable inside a supported mac output directory', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kunkun-packaged-smoke-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const expected = executablePath(root);
  makeExecutable(expected);
  assert.equal(findPackagedExecutable(root), fs.realpathSync(expected));
});

test('packaged smoke rejects missing, ambiguous, non-executable, and symlink candidates', (t) => {
  const roots = Array.from({ length: 4 }, () => fs.mkdtempSync(path.join(os.tmpdir(), 'kunkun-packaged-smoke-')));
  t.after(() => roots.forEach((root) => fs.rmSync(root, { recursive: true, force: true })));

  assert.throws(() => findPackagedExecutable(roots[0]), /实际找到 0 个/);

  makeExecutable(executablePath(roots[1], 'mac'));
  makeExecutable(executablePath(roots[1], 'mac-arm64'));
  assert.throws(() => findPackagedExecutable(roots[1]), /实际找到 2 个/);

  const nonExecutable = executablePath(roots[2]);
  makeExecutable(nonExecutable);
  fs.chmodSync(nonExecutable, 0o644);
  assert.throws(() => findPackagedExecutable(roots[2]), /实际找到 0 个/);

  const target = path.join(roots[3], 'target');
  makeExecutable(target);
  const symlink = executablePath(roots[3]);
  fs.mkdirSync(path.dirname(symlink), { recursive: true });
  fs.symlinkSync(target, symlink);
  assert.throws(() => findPackagedExecutable(roots[3]), /实际找到 0 个/);
});
