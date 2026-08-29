'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  ensureVerifiedCacheFile,
  isMatchingRegularFile,
  sha256File,
} = require('../src/main/verified-cache-file');

test('verified cache rewrites same-length corruption and then reuses the exact file', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kk-shot-cache-integrity-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source.traineddata');
  const cache = path.join(root, 'cache', 'source.traineddata');
  fs.writeFileSync(source, Buffer.from('correct-language-data'));
  fs.mkdirSync(path.dirname(cache));
  fs.writeFileSync(cache, Buffer.from('corrupt-language-data'));
  assert.equal(fs.statSync(source).size, fs.statSync(cache).size);
  assert.equal(isMatchingRegularFile(source, cache), false);

  assert.equal(ensureVerifiedCacheFile(source, cache), true);
  assert.equal(fs.readFileSync(cache, 'utf8'), 'correct-language-data');
  assert.equal(sha256File(cache), sha256File(source));
  assert.equal(fs.statSync(cache).mode & 0o777, 0o600);
  assert.equal(ensureVerifiedCacheFile(source, cache), false);
});

test('verified cache does not trust a symlink even when its target matches', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kk-shot-cache-symlink-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  const destination = path.join(root, 'destination');
  fs.writeFileSync(source, 'trusted');
  fs.symlinkSync(source, destination);

  assert.equal(isMatchingRegularFile(source, destination), false);
  assert.equal(ensureVerifiedCacheFile(source, destination), true);
  assert.equal(fs.lstatSync(destination).isSymbolicLink(), false);
  assert.equal(fs.readFileSync(destination, 'utf8'), 'trusted');
});
