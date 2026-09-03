const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const PinAnnotations = require('../src/renderer/pin/pin-annotations');
const PinImageLoader = require('../src/renderer/pin/pin-image-loader');
const pinSource = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'renderer', 'pin', 'pin.js'),
  'utf8'
);

const IMAGE = 'data:image/png;base64,QUFBQQ==';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeClassList() {
  const values = new Set();
  return {
    add(value) { values.add(value); },
    remove(value) { values.delete(value); },
    contains(value) { return values.has(value); },
    toggle(value, force) {
      if (force === true || (force === undefined && !values.has(value))) values.add(value);
      else if (force === false || force === undefined) values.delete(value);
      return values.has(value);
    },
  };
}

function makeElement(id) {
  const listeners = new Map();
  const capturedPointers = new Set();
  return {
    id,
    hidden: false,
    value: '#ff3b30',
    style: {},
    className: '',
    classList: makeClassList(),
    textContent: '',
    innerHTML: '',
    offsetWidth: 100,
    offsetHeight: 100,
    width: 100,
    height: 100,
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(listener);
    },
    dispatch(type, event = {}) {
      const safeEvent = {
        preventDefault() {},
        stopPropagation() {},
        target: this,
        ...event,
      };
      for (const listener of listeners.get(type) || []) listener(safeEvent);
    },
    contains() { return false; },
    closest() { return null; },
    querySelectorAll() { return []; },
    setAttribute() {},
    getAttribute() { return null; },
    appendChild() {},
    focus() {},
    getBoundingClientRect() { return { left: 0, top: 0, width: 100, height: 100 }; },
    getContext() {
      return {
        clearRect() {}, save() {}, restore() {}, beginPath() {}, moveTo() {}, lineTo() {},
        stroke() {}, fill() {}, fillText() {}, rect() {}, ellipse() {}, closePath() {},
      };
    },
    setPointerCapture(pointerId) { capturedPointers.add(pointerId); },
    hasPointerCapture(pointerId) { return capturedPointers.has(pointerId); },
    releasePointerCapture(pointerId) { capturedPointers.delete(pointerId); },
  };
}

function createRuntime({ update, flush, confirmAnswers = [], onConfirm }) {
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, makeElement(id));
    return elements.get(id);
  };
  const body = element('body');
  const documentListeners = new Map();
  const windowListeners = new Map();
  const callbacks = {};
  const acknowledgements = [];
  const syncAcknowledgements = [];
  const updates = [];
  let closeCalls = 0;
  let confirmCalls = 0;
  let flushCalls = 0;

  const document = {
    body,
    readyState: 'complete',
    getElementById: element,
    createElement: (tag) => makeElement(tag),
    addEventListener(type, listener) { documentListeners.set(type, listener); },
  };
  const window = {
    document,
    PinAnnotations,
    PinImageLoader,
    Image: class {
      constructor() {
        this.naturalWidth = 100;
        this.naturalHeight = 100;
      }
      decode() { return Promise.resolve(); }
    },
    PinContentUpdate: {
      createOrderedPinContentUpdater() {
        return {
          update(snapshot) {
            updates.push(JSON.parse(JSON.stringify(snapshot)));
            return update(snapshot);
          },
          flush() {
            flushCalls += 1;
            return flush();
          },
        };
      },
    },
    kkapi: {
      getConfig: async () => ({}),
      onInit(listener) { callbacks.init = listener; },
      onPinCmd(listener) { callbacks.command = listener; },
      pinUpdateContent: async () => ({ ok: true, revision: 1 }),
      pinCloseReady: async (payload) => { acknowledgements.push(payload); return { ok: true }; },
      pinSyncReady: async (payload) => { syncAcknowledgements.push(payload); return { ok: true }; },
      closeSelf() { closeCalls += 1; },
    },
    addEventListener(type, listener) { windowListeners.set(type, listener); },
    close() { closeCalls += 1; },
    confirm() {
      confirmCalls += 1;
      if (typeof onConfirm === 'function') onConfirm(callbacks);
      return Boolean(confirmAnswers.shift());
    },
    prompt() { return ''; },
    devicePixelRatio: 1,
    innerWidth: 100,
    innerHeight: 100,
  };
  window.window = window;

  const context = {
    window,
    document,
    ResizeObserver: class { observe() {} },
    setTimeout: () => 1,
    clearTimeout() {},
    console,
  };
  vm.runInNewContext(pinSource, context, { filename: 'pin.js' });
  callbacks.init({ dataURL: IMAGE, bounds: { width: 100, height: 100 }, contentRevision: 0 });

  return {
    callbacks,
    elements,
    acknowledgements,
    syncAcknowledgements,
    updates,
    body,
    get closeCalls() { return closeCalls; },
    get confirmCalls() { return confirmCalls; },
    get flushCalls() { return flushCalls; },
  };
}

function click(target) {
  target.dispatch('click', { target, button: 0 });
}

async function settle() {
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

test('prepare-close freezes pointer edits and ACKs exactly the committed visible stroke', async () => {
  const gate = deferred();
  const runtime = createRuntime({
    update: () => gate.promise,
    flush: async () => IMAGE,
  });
  await settle();
  click(runtime.elements.get('btnAnnotate'));
  const canvas = runtime.elements.get('pinAnnotationCanvas');
  canvas.dispatch('pointerdown', { button: 0, pointerId: 7, clientX: 10, clientY: 20 });
  canvas.dispatch('pointermove', { pointerId: 7, clientX: 40, clientY: 50 });

  runtime.callbacks.command({ cmd: 'prepare-close', requestId: 'req-1' });
  canvas.dispatch('pointermove', { pointerId: 7, clientX: 90, clientY: 90 });
  canvas.dispatch('pointerup', { pointerId: 7, clientX: 90, clientY: 90 });
  await settle();

  assert.equal(runtime.updates.length, 1);
  assert.deepEqual(runtime.updates[0][0].points, [
    { x: 0.1, y: 0.2 },
    { x: 0.4, y: 0.5 },
  ]);
  assert.deepEqual(runtime.acknowledgements, [], 'ACK must wait for final publication');

  gate.resolve(IMAGE);
  await settle();
  assert.deepEqual(
    JSON.parse(JSON.stringify(runtime.acknowledgements)),
    [{ requestId: 'req-1', ok: true }]
  );
});

test('failed batch close stays open without modal; only explicit interactive discard closes', async () => {
  const runtime = createRuntime({
    update: async () => { throw new Error('publish failed'); },
    flush: async () => { throw new Error('flush failed'); },
    confirmAnswers: [false, true],
  });
  await settle();

  runtime.callbacks.command({ cmd: 'close' });
  await settle();
  assert.equal(runtime.closeCalls, 0);
  assert.equal(runtime.confirmCalls, 0, 'batch close must not create a modal storm');
  assert.equal(runtime.body.classList.contains('pin-close-pending'), false);

  click(runtime.elements.get('btnAnnotate'));
  const canvas = runtime.elements.get('pinAnnotationCanvas');
  canvas.dispatch('pointerdown', { button: 0, pointerId: 9, clientX: 20, clientY: 20 });
  canvas.dispatch('pointermove', { pointerId: 9, clientX: 30, clientY: 30 });
  click(runtime.elements.get('btnClose'));
  await settle();
  assert.equal(runtime.confirmCalls, 1);
  assert.equal(runtime.closeCalls, 0, 'canceling discard keeps the failed pin open');
  assert.equal(runtime.body.classList.contains('pin-close-pending'), false);

  click(runtime.elements.get('btnClose'));
  await settle();
  assert.equal(runtime.confirmCalls, 2);
  assert.equal(runtime.closeCalls, 1, 'only the explicit discard confirmation may close after failure');
});

test('prepare-close taking over inside the discard dialog prevents a pre-ACK close', async () => {
  const gate = deferred();
  const runtime = createRuntime({
    update: () => gate.promise,
    flush: async () => { throw new Error('flush failed'); },
    confirmAnswers: [true],
    onConfirm(callbacks) {
      callbacks.command({ cmd: 'prepare-close', requestId: 'req-takeover' });
    },
  });
  await settle();

  click(runtime.elements.get('btnClose'));
  await settle();

  assert.equal(runtime.confirmCalls, 1);
  assert.equal(runtime.closeCalls, 0, 'application close barrier must override the pending discard');
  assert.deepEqual(runtime.acknowledgements, [], 'takeover ACK must wait for final publication');

  gate.resolve(IMAGE);
  await settle();
  assert.equal(runtime.closeCalls, 0);
  assert.deepEqual(
    JSON.parse(JSON.stringify(runtime.acknowledgements)),
    [{ requestId: 'req-takeover', ok: true }]
  );
});

test('canceling application quit releases the edit barrier and suppresses its stale ACK', async () => {
  const gate = deferred();
  const runtime = createRuntime({
    update: () => gate.promise,
    flush: async () => IMAGE,
  });
  await settle();
  click(runtime.elements.get('btnAnnotate'));
  const canvas = runtime.elements.get('pinAnnotationCanvas');
  canvas.dispatch('pointerdown', { button: 0, pointerId: 11, clientX: 10, clientY: 10 });
  canvas.dispatch('pointermove', { pointerId: 11, clientX: 20, clientY: 20 });

  runtime.callbacks.command({ cmd: 'prepare-close', requestId: 'req-canceled' });
  runtime.callbacks.command({ cmd: 'cancel-prepare-close' });
  assert.equal(runtime.body.classList.contains('pin-close-pending'), false);

  canvas.dispatch('pointerdown', { button: 0, pointerId: 12, clientX: 30, clientY: 30 });
  canvas.dispatch('pointermove', { pointerId: 12, clientX: 40, clientY: 40 });
  canvas.dispatch('pointerup', { pointerId: 12, clientX: 40, clientY: 40 });
  gate.resolve(IMAGE);
  await settle();

  assert.equal(runtime.acknowledgements.length, 0, 'a canceled quit request must not emit a stale ACK');
  assert.equal(runtime.updates.length >= 2, true, 'editing must resume after quit cancellation');
});

test('save-all sync commits the visible stroke, waits for publication, and keeps editing enabled', async () => {
  const gate = deferred();
  const runtime = createRuntime({
    update: () => gate.promise,
    flush: async () => IMAGE,
  });
  await settle();
  click(runtime.elements.get('btnAnnotate'));
  const canvas = runtime.elements.get('pinAnnotationCanvas');
  canvas.dispatch('pointerdown', { button: 0, pointerId: 21, clientX: 10, clientY: 20 });
  canvas.dispatch('pointermove', { pointerId: 21, clientX: 40, clientY: 50 });

  runtime.callbacks.command({ cmd: 'sync-content', requestId: 'save-1' });
  await settle();
  assert.equal(runtime.updates.length, 1);
  assert.deepEqual(runtime.syncAcknowledgements, []);
  assert.equal(runtime.body.classList.contains('pin-close-pending'), false);

  gate.resolve(IMAGE);
  await settle();
  assert.deepEqual(
    JSON.parse(JSON.stringify(runtime.syncAcknowledgements)),
    [{ requestId: 'save-1', ok: true }]
  );

  canvas.dispatch('pointerdown', { button: 0, pointerId: 22, clientX: 30, clientY: 30 });
  canvas.dispatch('pointermove', { pointerId: 22, clientX: 40, clientY: 40 });
  canvas.dispatch('pointerup', { pointerId: 22, clientX: 40, clientY: 40 });
  await settle();
  assert.equal(runtime.updates.length, 2, 'point-in-time save synchronization must not freeze later edits');
});
