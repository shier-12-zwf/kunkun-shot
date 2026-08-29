const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createSwiftBinaryCache } = require('../src/main/swift-binary-cache');

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kunkun-swift-cache-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('concurrent requests for the same Swift helper share one compilation', async (t) => {
  const dir = tempDir(t);
  let compileCount = 0;
  const cache = createSwiftBinaryCache({
    cacheDir: () => dir,
    compile: async (_sourcePath, outputPath) => {
      compileCount += 1;
      await new Promise((resolve) => setImmediate(resolve));
      fs.writeFileSync(outputPath, 'compiled-helper', { mode: 0o700 });
    }
  });

  const [first, second, third] = await Promise.all([
    cache.ensureBinary({ name: 'vision-boxes', source: 'print("one")' }),
    cache.ensureBinary({ name: 'vision-boxes', source: 'print("one")' }),
    cache.ensureBinary({ name: 'vision-boxes', source: 'print("one")' })
  ]);

  assert.equal(first, second);
  assert.equal(second, third);
  assert.equal(compileCount, 1);
  assert.equal(fs.readFileSync(first, 'utf8'), 'compiled-helper');
});

test('missing compiler output rejects and a later request retries cleanly', async (t) => {
  const dir = tempDir(t);
  let compileCount = 0;
  const cache = createSwiftBinaryCache({
    cacheDir: () => dir,
    compile: async (_sourcePath, outputPath) => {
      compileCount += 1;
      if (compileCount === 2) fs.writeFileSync(outputPath, 'recovered', { mode: 0o700 });
    }
  });

  await assert.rejects(
    cache.ensureBinary({ name: 'axprobe', source: 'print("two")' }),
    /没有生成可执行文件/
  );
  const binary = await cache.ensureBinary({ name: 'axprobe', source: 'print("two")' });
  assert.equal(fs.readFileSync(binary, 'utf8'), 'recovered');
  assert.equal(compileCount, 2);
  assert.deepEqual(
    fs.readdirSync(dir).filter((name) => name.endsWith('.tmp') || name.endsWith('.swift')),
    []
  );
});

test('helper names are validated before becoming filesystem paths', async (t) => {
  const cache = createSwiftBinaryCache({
    cacheDir: () => tempDir(t),
    compile: async () => {}
  });
  await assert.rejects(
    cache.ensureBinary({ name: '../escape', source: 'print("bad")' }),
    /名称无效/
  );
});
