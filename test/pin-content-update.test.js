const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createOrderedPinContentUpdater,
  normalizePinContentUpdate,
} = require('../src/shared/pin-content-update');

const IMAGE_A = 'data:image/png;base64,QUFBQQ==';
const IMAGE_B = 'data:image/png;base64,QkJCQg==';
const IMAGE_C = 'data:image/png;base64,Q0NDQw==';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test('pin content update payload is exact, sequential and image-only', () => {
  assert.deepEqual(normalizePinContentUpdate({
    baseRevision: 0,
    revision: 1,
    dataURL: IMAGE_A,
  }), {
    baseRevision: 0,
    revision: 1,
    dataURL: IMAGE_A,
  });

  assert.throws(
    () => normalizePinContentUpdate({ baseRevision: 1, revision: 3, dataURL: IMAGE_A }),
    /revision/i
  );
  assert.throws(
    () => normalizePinContentUpdate({ baseRevision: 0, revision: 1, dataURL: IMAGE_A, injected: true }),
    /字段/
  );
  assert.throws(
    () => normalizePinContentUpdate({ baseRevision: 0, revision: 1, dataURL: 'file:///tmp/a.png' }),
    /图片/
  );
});

test('content composition and publication stay ordered and snapshot input is isolated', async () => {
  const firstGate = deferred();
  const composeCalls = [];
  const published = [];
  const updater = createOrderedPinContentUpdater({
    sourceDataURL: IMAGE_A,
    compose: async (_source, snapshot) => {
      composeCalls.push(snapshot.mark);
      if (snapshot.mark === 1) await firstGate.promise;
      return snapshot.mark === 1 ? IMAGE_B : IMAGE_C;
    },
    publish: async (payload) => {
      published.push(payload);
      return { ok: true, revision: payload.revision };
    },
  });

  const firstSnapshot = { mark: 1 };
  const first = updater.update(firstSnapshot);
  firstSnapshot.mark = 99;
  const second = updater.update({ mark: 2 });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(composeCalls, [1], 'later compositions must wait for the earlier revision');
  firstGate.resolve();
  await Promise.all([first, second]);

  assert.deepEqual(composeCalls, [1, 2]);
  assert.deepEqual(published, [
    { baseRevision: 0, revision: 1, dataURL: IMAGE_B },
    { baseRevision: 1, revision: 2, dataURL: IMAGE_C },
  ]);
  assert.equal(await updater.flush(), IMAGE_C);
  assert.equal(updater.getCurrentDataURL(), IMAGE_C);
});

test('a reloaded pin continues from the content revision supplied by the main process', async () => {
  const published = [];
  const updater = createOrderedPinContentUpdater({
    sourceDataURL: IMAGE_A,
    initialRevision: 7,
    compose: async () => IMAGE_B,
    publish: async (payload) => {
      published.push(payload);
      return { ok: true, revision: payload.revision };
    },
  });

  await updater.update([]);
  assert.deepEqual(published, [
    { baseRevision: 7, revision: 8, dataURL: IMAGE_B },
  ]);
  assert.equal(updater.getPublishedRevision(), 8);
});

test('a rejected publication is reconciled before the next ordered update', async () => {
  const attempts = [];
  let failFirst = true;
  const updater = createOrderedPinContentUpdater({
    sourceDataURL: IMAGE_A,
    compose: async (_source, snapshot) => snapshot.dataURL,
    publish: async (payload) => {
      attempts.push(payload);
      if (failFirst) {
        failFirst = false;
        return { ok: false, error: 'temporary failure' };
      }
      return { ok: true, revision: payload.revision };
    },
  });

  await assert.rejects(updater.update({ dataURL: IMAGE_B }), /temporary failure/);
  await updater.update({ dataURL: IMAGE_C });

  assert.deepEqual(attempts.map(({ baseRevision, revision, dataURL }) => ({ baseRevision, revision, dataURL })), [
    { baseRevision: 0, revision: 1, dataURL: IMAGE_B },
    { baseRevision: 0, revision: 1, dataURL: IMAGE_B },
    { baseRevision: 1, revision: 2, dataURL: IMAGE_C },
  ]);
  assert.equal(await updater.flush(), IMAGE_C);
});

test('flush retries a materialized update with the identical revision after a lost acknowledgement', async () => {
  const attempts = [];
  let first = true;
  const updater = createOrderedPinContentUpdater({
    sourceDataURL: IMAGE_A,
    compose: async () => IMAGE_B,
    publish: async (payload) => {
      attempts.push(payload);
      if (first) {
        first = false;
        throw new Error('ack lost');
      }
      return { ok: true, revision: payload.revision };
    },
  });

  await assert.rejects(updater.update([]), /ack lost/);
  assert.equal(await updater.flush(), IMAGE_B);
  assert.deepEqual(attempts, [
    { baseRevision: 0, revision: 1, dataURL: IMAGE_B },
    { baseRevision: 0, revision: 1, dataURL: IMAGE_B },
  ]);
});
