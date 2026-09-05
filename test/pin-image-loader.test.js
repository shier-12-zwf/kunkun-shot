const test = require('node:test');
const assert = require('node:assert/strict');

const { createPinImageLoader } = require('../src/renderer/pin/pin-image-loader');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test('failed replacement keeps the last decoded image and exposes a retryable persistent error', async () => {
  const attempts = [];
  const states = [];
  const loader = createPinImageLoader({
    decode(dataURL) {
      const attempt = deferred();
      attempts.push({ dataURL, ...attempt });
      return attempt.promise;
    },
    onState(state) { states.push(state); },
  });

  const first = loader.load('data:image/png;base64,first');
  await Promise.resolve();
  attempts[0].resolve({ width: 320, height: 180 });
  assert.equal((await first).status, 'ready');

  const replacement = loader.load('data:image/png;base64,replacement');
  await Promise.resolve();
  assert.equal(loader.getState().status, 'decoding');
  assert.equal(loader.getState().committedDataURL, 'data:image/png;base64,first');
  attempts[1].reject(new Error('decode failed'));
  assert.equal((await replacement).status, 'error');

  const failed = loader.getState();
  assert.equal(failed.status, 'error');
  assert.equal(failed.committedDataURL, 'data:image/png;base64,first');
  assert.equal(failed.candidateDataURL, 'data:image/png;base64,replacement');
  assert.match(failed.error, /decode failed/);
  assert.equal(states.at(-1).status, 'error');

  const retry = loader.retry();
  await Promise.resolve();
  assert.equal(attempts[2].dataURL, 'data:image/png;base64,replacement');
  attempts[2].resolve({ width: 640, height: 360 });
  const recovered = await retry;
  assert.equal(recovered.status, 'ready');
  assert.deepEqual(loader.getState(), {
    generation: 3,
    status: 'ready',
    committedDataURL: 'data:image/png;base64,replacement',
    candidateDataURL: '',
    width: 640,
    height: 360,
    error: '',
  });
});

test('late decode completion from an older generation cannot replace the newest image', async () => {
  const attempts = [];
  const committed = [];
  const loader = createPinImageLoader({
    decode(dataURL) {
      const attempt = deferred();
      attempts.push({ dataURL, ...attempt });
      return attempt.promise;
    },
    onCommit(result) { committed.push(result.dataURL); },
  });

  const oldLoad = loader.load('data:image/png;base64,old');
  await Promise.resolve();
  const newLoad = loader.load('data:image/png;base64,new');
  await Promise.resolve();
  attempts[1].resolve({ width: 200, height: 100 });
  assert.equal((await newLoad).status, 'ready');

  attempts[0].resolve({ width: 10, height: 10 });
  assert.equal((await oldLoad).status, 'stale');
  assert.deepEqual(committed, ['data:image/png;base64,new']);
  assert.equal(loader.getState().committedDataURL, 'data:image/png;base64,new');
});

test('each generation decodes its own candidate even when loads start back-to-back', async () => {
  const decoded = [];
  const loader = createPinImageLoader({
    async decode(dataURL) {
      decoded.push(dataURL);
      return { width: 100, height: 50 };
    },
  });

  const oldLoad = loader.load('data:image/png;base64,old');
  const newLoad = loader.load('data:image/png;base64,new');
  const [oldResult, newResult] = await Promise.all([oldLoad, newLoad]);

  assert.deepEqual(decoded, [
    'data:image/png;base64,old',
    'data:image/png;base64,new',
  ]);
  assert.equal(oldResult.status, 'stale');
  assert.equal(newResult.status, 'ready');
  assert.equal(loader.getState().committedDataURL, 'data:image/png;base64,new');
});

test('decoded images with invalid dimensions fail closed', async () => {
  const loader = createPinImageLoader({
    decode: async () => ({ width: 0, height: 100 }),
  });

  const result = await loader.load('data:image/png;base64,broken');
  assert.equal(result.status, 'error');
  assert.match(loader.getState().error, /尺寸/);
  assert.equal(loader.getState().committedDataURL, '');
});

test('the exact decoded image element is committed so display does not decode the source twice', async () => {
  const imageElement = { naturalWidth: 640, naturalHeight: 360 };
  let committed;
  const loader = createPinImageLoader({
    decode: async () => ({ width: 640, height: 360, imageElement }),
    onCommit(value) { committed = value; },
  });

  const result = await loader.load('data:image/png;base64,atomic');

  assert.equal(result.status, 'ready');
  assert.equal(committed.imageElement, imageElement);
  assert.equal(result.imageElement, imageElement);
});
