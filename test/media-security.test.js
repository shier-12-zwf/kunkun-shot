const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const media = require('../src/main/media');

test('system FFmpeg resolution is deterministic and supports a safe absolute override', () => {
  const executable = new Set(['/custom/ffmpeg', '/common/ffmpeg', '/path/bin/ffmpeg']);
  const isExecutable = (candidate) => executable.has(candidate);
  assert.equal(media.resolveFfmpeg({
    env: { KUNKUN_SHOT_FFMPEG_PATH: '/custom/ffmpeg', PATH: '/path/bin' },
    commonPaths: ['/common/ffmpeg'],
    isExecutable,
  }), '/custom/ffmpeg');
  assert.equal(media.resolveFfmpeg({
    env: { KUNKUN_SHOT_FFMPEG_PATH: 'relative/ffmpeg', PATH: '/path/bin' },
    commonPaths: ['/common/ffmpeg'],
    isExecutable,
  }), '/path/bin/ffmpeg');
  assert.equal(media.resolveFfmpeg({
    env: { PATH: '/missing/bin' },
    commonPaths: [],
    isExecutable,
  }), null);
  assert.equal(media.resolveFfmpeg({
    env: { PATH: 'relative/bin' },
    commonPaths: ['/common/ffmpeg'],
    isExecutable,
  }), '/common/ffmpeg', 'relative PATH entries must not be resolved against the app working directory');
});

test('GIF recording safely falls back to direct WebM when system FFmpeg is unavailable', () => {
  assert.deepEqual(
    media.resolveRecordingExportMode(true, null),
    { wantGif: false, fallbackToWebm: true },
  );
  assert.deepEqual(
    media.resolveRecordingExportMode(true, '/system/ffmpeg'),
    { wantGif: true, fallbackToWebm: false },
  );
  assert.deepEqual(
    media.resolveRecordingExportMode(false, null),
    { wantGif: false, fallbackToWebm: false },
  );
});

test('recording export targets strictly match their actual container and FFmpeg availability', () => {
  const ffmpeg = '/system/ffmpeg';
  assert.deepEqual(
    media.resolveRecordingExportTarget('/tmp/clip', false, null),
    { outputPath: '/tmp/clip.webm', format: 'webm' },
  );
  assert.deepEqual(
    media.resolveRecordingExportTarget('/tmp/clip.WEBM', false, null),
    { outputPath: '/tmp/clip.WEBM', format: 'webm' },
  );
  assert.deepEqual(
    media.resolveRecordingExportTarget('/tmp/clip.mp4', false, ffmpeg),
    { outputPath: '/tmp/clip.mp4', format: 'mp4' },
  );
  assert.deepEqual(
    media.resolveRecordingExportTarget('/tmp/clip.GIF', true, ffmpeg),
    { outputPath: '/tmp/clip.GIF', format: 'gif' },
  );
  assert.deepEqual(
    media.resolveRecordingExportTarget('/tmp/clip', true, ffmpeg),
    { outputPath: '/tmp/clip.gif', format: 'gif' },
  );
  for (const invalid of ['/tmp/clip.gif', '/tmp/clip.mp4', '/tmp/clip.mov']) {
    assert.throws(
      () => media.resolveRecordingExportTarget(invalid, false, null),
      /WebM|FFmpeg|\.webm/,
    );
  }
  assert.throws(
    () => media.resolveRecordingExportTarget('/tmp/clip.webm', true, ffmpeg),
    /\.gif/,
  );
  assert.throws(
    () => media.resolveRecordingExportTarget('/tmp/clip.gif', true, null),
    /FFmpeg/,
  );
});

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

test('VP8 WebM video can be exported as H.264 MP4 (video-only codec coverage)', async (t) => {
  assert.equal(typeof media.convertToMp4, 'function');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kk-shot-mp4-test-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const input = path.join(tempDir, 'vp8.webm');
  const output = path.join(tempDir, 'output.mp4');
  const ffmpeg = media.resolveFfmpeg();
  if (!ffmpeg) {
    t.skip('optional system FFmpeg is not installed');
    return;
  }
  const encoderProbe = spawnSync(ffmpeg, ['-hide_banner', '-encoders'], { encoding: 'utf8' });
  const encoders = `${encoderProbe.stdout || ''}\n${encoderProbe.stderr || ''}`;
  if (encoderProbe.status !== 0 || !/\blibvpx\b/.test(encoders) || !/\blibx264\b/.test(encoders)) {
    t.skip('system FFmpeg lacks the optional libvpx/libx264 integration codecs');
    return;
  }
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
  assert.doesNotMatch(probe.stderr, /Audio:/i, 'this fixture intentionally covers video only');
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

  const fakeSpawn = (_binary, args) => {
    const stage = args.at(-1);
    fs.writeFileSync(stage, 'partial-converter-output');
    const proc = new EventEmitter();
    proc.stderr = new EventEmitter();
    process.nextTick(() => {
      proc.stderr.emit('data', Buffer.from("No such filter: 'definitely_not_a_real_ffmpeg_filter'"));
      proc.emit('close', 1);
    });
    return proc;
  };

  await assert.rejects(
    media.convertImage(input, output, ['-vf', 'definitely_not_a_real_ffmpeg_filter'], {
      resolveFfmpeg: () => '/mock/ffmpeg',
      spawn: fakeSpawn,
    }),
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
  await assert.rejects(media.convertImage(input, output, [], {
    resolveFfmpeg: () => '/mock/ffmpeg',
    spawn: fakeSpawn,
  }), /转换失败/);
  assert.notEqual(spawnedOutput, output);
  assert.equal(path.dirname(spawnedOutput), tempDir);
  assert.equal(path.extname(spawnedOutput), '.png');
  assert.equal(fs.readFileSync(output, 'utf8'), 'precious-existing-content');
  assert.deepEqual(fs.readdirSync(tempDir).sort(), ['input.png', 'precious.png']);
});

test('missing system FFmpeg fails before staging and explains the install path', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kk-shot-no-ffmpeg-test-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const input = path.join(tempDir, 'input.png');
  const output = path.join(tempDir, 'existing.webp');
  fs.writeFileSync(input, 'input');
  fs.writeFileSync(output, 'keep-this-original-file');

  await assert.rejects(
    media.convertImage(input, output, [], { resolveFfmpeg: () => null }),
    /未找到.*FFmpeg.*brew install/s
  );
  assert.equal(fs.readFileSync(output, 'utf8'), 'keep-this-original-file');
  assert.deepEqual(fs.readdirSync(tempDir).sort(), ['existing.webp', 'input.png']);
});
