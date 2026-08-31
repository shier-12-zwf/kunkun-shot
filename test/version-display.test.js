'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const pkg = require('../package.json');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

test('main window version is sourced from package.json instead of hard-coded markup', () => {
  const windowsSource = read('src/main/windows.js');
  const rendererSource = read('src/renderer/main/main.js');
  const html = read('src/renderer/main/main.html');

  assert.match(pkg.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  assert.match(windowsSource, /version:\s*APP_VERSION\s*}\s*=\s*require\(['"]\.\.\/\.\.\/package\.json['"]\)/);
  assert.match(windowsSource, /appVersion:\s*APP_VERSION/);
  assert.match(rendererSource, /applyVersion\(p\s*&&\s*p\.appVersion\)/);
  assert.match(rendererSource, /versionEl\.textContent\s*=\s*"版本 "\s*\+\s*normalized/);
  assert.match(html, /id="app-version">版本 —<\/span>/);
  assert.doesNotMatch(html, /版本\s+\d+\.\d+\.\d+/);
});
