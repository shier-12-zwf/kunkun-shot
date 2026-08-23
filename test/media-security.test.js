const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const Module = require('node:module');
const { EventEmitter } = require('node:events');
const media = require('../src/main/media');

function loadMediaWithSpawn(fakeSpawn) {
  const originalLoad = Module._load;
  Module._load = function mockDependencies(request, parent, isMain) {
    if (request === 'child_process') return { spawn: fakeSpawn };
    if (request === 'ffmpeg-static') return '/mock/ffmpeg';
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    const modulePath = require.resolve('../src/main/media');
    delete require.cache[modulePath];
    return require(modulePath);
  } finally {
    Module._load = originalLoad;
  }
}

test('recording temp files live in a private randomized directory', (t) => {
  const file = media.writeTempRecording(Buffer.from('recording'), 'webm');
  t.after(() => {
    try { fs.unlinkSync(file); } catch (_) {}
    try { fs.rmdirSync(path.dirname(file)); } catch (_) {}
  });

  assert.match(path.basename(path.dirname(file)), /^kkshot-rec-/);
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('VP8 WebM can be exported as a broadly compatible H.264 MP4', async (t) => {
  assert.equal(typeof media.convertToMp4, 'function');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kk-shot-mp4-test-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const input = path.join(tempDir, 'vp8.webm');
  const output = path.join(tempDir, 'output.mp4');
  const ffmpeg = media.resolveFfmpeg();
  const generated = spawnSync(
    ffmpeg,
    ['-y', '-f', 'lavfi', '-i', 'color=c=black:s=64x64:r=5', '-t', '0.4', '-c:v', 'libvpx', input],
    { encoding: 'utf8' }
  );
  assert.equal(generated.status, 0, generated.stderr);

  await media.convertToMp4(input, output, []);

  assert.ok(fs.statSync(output).size > 0);
  const probe = spawnSync(ffmpeg, ['-i', output], { encoding: 'utf8' });
  assert.match(probe.stderr, /Video:\s*h264/i);
});

test('failed ffmpeg conversion never truncates an existing destination file', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kk-shot-atomic-media-test-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const input = path.join(tempDir, 'input.png');
  const output = path.join(tempDir, 'existing.png');
  fs.writeFileSync(
    input,
    Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
  );
  fs.writeFileSync(output, 'keep-this-original-file');

  await assert.rejects(
    media.convertImage(input, output, ['-vf', 'definitely_not_a_real_ffmpeg_filter']),
    /转换失败/
  );
  assert.equal(fs.readFileSync(output, 'utf8'), 'keep-this-original-file');
  assert.deepEqual(fs.readdirSync(tempDir).sort(), ['existing.png', 'input.png']);
});

test('ffmpeg is given a private staging path instead of the user destination', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kk-shot-media-stage-test-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const input = path.join(tempDir, 'input.png');
  const output = path.join(tempDir, 'precious.png');
  fs.writeFileSync(input, 'input');
  fs.writeFileSync(output, 'precious-existing-content');
  let spawnedOutput = null;
  const fakeSpawn = (_binary, args) => {
    spawnedOutput = args.at(-1);
    // Model a converter that opens/truncates its output and then fails.
    fs.writeFileSync(spawnedOutput, '');
    const proc = new EventEmitter();
    proc.stderr = new EventEmitter();
    process.nextTick(() => proc.emit('close', 1));
    return proc;
  };
  const isolatedMedia = loadMediaWithSpawn(fakeSpawn);

  await assert.rejects(isolatedMedia.convertImage(input, output, []), /转换失败/);
  assert.notEqual(spawnedOutput, output);
  assert.equal(path.dirname(spawnedOutput), tempDir);
  assert.equal(path.extname(spawnedOutput), '.png');
  assert.equal(fs.readFileSync(output, 'utf8'), 'precious-existing-content');
  assert.deepEqual(fs.readdirSync(tempDir).sort(), ['input.png', 'precious.png']);
});
