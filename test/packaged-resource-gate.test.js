const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const asar = require('@electron/asar');
const {
  REQUIRED_LEGAL_RESOURCES,
  assertPackagedResources,
  isForbiddenStandaloneFfmpegPath,
} = require('../scripts/verify-macos-release');

function makeApp(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kkshot-resource-gate-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const appPath = path.join(root, 'Test.app');
  const resources = path.join(appPath, 'Contents', 'Resources');
  const source = path.join(root, 'asar-source');
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(path.join(source, 'package.json'), '{"name":"fixture"}');
  fs.mkdirSync(resources, { recursive: true });
  for (const relative of REQUIRED_LEGAL_RESOURCES) {
    const target = path.join(resources, ...relative.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, 'fixture notice');
  }
  return { appPath, resources, root, source };
}

test('packaged-resource path matcher rejects only standalone FFmpeg payloads', () => {
  assert.equal(isForbiddenStandaloneFfmpegPath('/node_modules/ffmpeg-static/ffmpeg'), true);
  assert.equal(isForbiddenStandaloneFfmpegPath('app.asar.unpacked/vendor/ffmpeg'), true);
  assert.equal(isForbiddenStandaloneFfmpegPath('vendor/ffmpeg.exe'), true);
  assert.equal(isForbiddenStandaloneFfmpegPath('app.asar.unpacked/vendor/ffprobe'), true);
  assert.equal(isForbiddenStandaloneFfmpegPath('vendor/ffprobe.exe'), true);
  assert.equal(isForbiddenStandaloneFfmpegPath('src/main/media.js'), false);
  assert.equal(isForbiddenStandaloneFfmpegPath('Frameworks/Electron Framework.framework/Libraries/libffmpeg.dylib'), false);
});

test('packaged-resource gate accepts a complete app and does not confuse Electron libffmpeg', async (t) => {
  const fixture = makeApp(t);
  await asar.createPackage(fixture.source, path.join(fixture.resources, 'app.asar'));
  const chromiumLibrary = path.join(
    fixture.appPath,
    'Contents',
    'Frameworks',
    'Electron Framework.framework',
    'Libraries',
    'libffmpeg.dylib',
  );
  fs.mkdirSync(path.dirname(chromiumLibrary), { recursive: true });
  fs.writeFileSync(chromiumLibrary, 'electron runtime library');
  assert.doesNotThrow(() => assertPackagedResources(fixture.appPath));
});

test('packaged-resource gate rejects ffmpeg-static in app.asar', async (t) => {
  const fixture = makeApp(t);
  const dependency = path.join(fixture.source, 'node_modules', 'ffmpeg-static');
  fs.mkdirSync(dependency, { recursive: true });
  fs.writeFileSync(path.join(dependency, 'index.js'), 'module.exports = "ffmpeg";');
  await asar.createPackage(fixture.source, path.join(fixture.resources, 'app.asar'));
  assert.throws(() => assertPackagedResources(fixture.appPath), /forbidden standalone FFmpeg/);
});

test('packaged-resource gate rejects unpacked FFmpeg and missing legal notices', async (t) => {
  const fixture = makeApp(t);
  await asar.createPackage(fixture.source, path.join(fixture.resources, 'app.asar'));
  const binary = path.join(
    fixture.resources,
    'app.asar.unpacked',
    'node_modules',
    'ffmpeg-static',
    'ffmpeg',
  );
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  fs.writeFileSync(binary, 'binary');
  assert.throws(() => assertPackagedResources(fixture.appPath), /forbidden standalone FFmpeg/);

  fs.rmSync(path.join(fixture.resources, 'app.asar.unpacked'), { recursive: true, force: true });
  fs.rmSync(path.join(fixture.resources, 'licenses', 'LICENSES', 'tr46-MIT.txt'));
  assert.throws(() => assertPackagedResources(fixture.appPath), /missing required legal notice.*tr46-MIT/);
});
