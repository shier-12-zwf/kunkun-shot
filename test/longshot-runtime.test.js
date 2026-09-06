const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const LongshotStitch = require('../src/renderer/longshot/longshot-stitch');
const longshotSource = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'renderer', 'longshot', 'longshot.js'),
  'utf8'
);

function makeClassList() {
  const values = new Set();
  return {
    add(value) { values.add(value); },
    remove(value) { values.delete(value); },
    contains(value) { return values.has(value); },
  };
}

class FakeElement {
  constructor(tagName, id) {
    this.tagName = tagName;
    this.id = id || '';
    this.hidden = false;
    this.disabled = false;
    this.value = '';
    this.max = '';
    this.title = '';
    this.textContent = '';
    this.style = {};
    this.classList = makeClassList();
    this.children = [];
    this.listeners = new Map();
    this.label = tagName === 'button' ? { textContent: '' } : null;
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }

  setAttribute(name, value) { this[name] = value; }

  dispatch(type, event = {}) {
    const safeEvent = {
      preventDefault() {},
      stopPropagation() {},
      target: this,
      ...event,
    };
    for (const listener of this.listeners.get(type) || []) listener(safeEvent);
  }

  querySelector(selector) {
    if (selector === '.label') return this.label;
    return null;
  }

  replaceChildren() {
    this.children = [];
    this.value = '';
  }

  appendChild(child) {
    this.children.push(child);
    if (!this.value && child.value) this.value = child.value;
    return child;
  }
}

class FakeCanvas {
  constructor(renderedCanvases, faults) {
    this._width = 0;
    this._height = 0;
    this._pixels = new Uint8ClampedArray();
    this._renderedCanvases = renderedCanvases;
    this._faults = faults;
    this._context = new FakeCanvasContext(this);
  }

  get width() { return this._width; }
  set width(value) {
    this._width = Math.max(0, Number(value) || 0);
    this._resetPixels();
  }

  get height() { return this._height; }
  set height(value) {
    this._height = Math.max(0, Number(value) || 0);
    this._resetPixels();
  }

  _resetPixels() {
    this._pixels = new Uint8ClampedArray(this._width * this._height * 4);
  }

  getContext() { return this._context; }

  toDataURL() { return 'data:image/png;base64,' + 'A'.repeat(64); }
}

class FakeCanvasContext {
  constructor(canvas) {
    this.canvas = canvas;
  }

  translate() {}
  rotate() {}

  drawImage(source) {
    const pixels = source && (source._pixels || (source.canvas && source.canvas._pixels));
    if (!pixels) throw new Error('fake canvas only supports whole-frame drawImage');
    this.canvas._pixels.set(pixels.subarray(0, this.canvas._pixels.length));
  }

  getImageData(x, y, width, height) {
    assert.equal(x, 0);
    assert.equal(y, 0);
    assert.equal(width, this.canvas.width);
    assert.equal(height, this.canvas.height);
    return { data: this.canvas._pixels };
  }

  createImageData(width, height) {
    if (this.canvas._faults.createImageData > 0) {
      this.canvas._faults.createImageData -= 1;
      throw new Error('injected timeline render failure');
    }
    return { data: new Uint8ClampedArray(width * height * 4) };
  }

  putImageData(imageData) {
    this.canvas._pixels.set(imageData.data);
    this.canvas._renderedCanvases.push(this.canvas);
  }
}

function rowPixels(start, count, width = 4) {
  const pixels = new Uint8ClampedArray(width * count * 4);
  for (let y = 0; y < count; y += 1) {
    const row = start + y;
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      pixels[offset] = 20;
      pixels[offset + 1] = 20 + row * 10;
      pixels[offset + 2] = 35 + row * 7;
      pixels[offset + 3] = 255;
    }
  }
  return pixels;
}

function createRuntime({ stitchApi = LongshotStitch } = {}) {
  const renderedCanvases = [];
  const faults = { createImageData: 0 };
  const elements = new Map();
  const buttonIds = new Set([
    'btnStart', 'btnDone', 'btnSave', 'btnDir', 'btnCancel', 'btnDeleteSegment',
    'btnUndo', 'btnRedo', 'btnSuggestFixed', 'btnApplyFixed',
  ]);
  const inputIds = new Set(['cropTop', 'cropBottom', 'fixedTop', 'fixedBottom']);
  const getElement = (id) => {
    if (!elements.has(id)) {
      const tagName = buttonIds.has(id) ? 'button' : inputIds.has(id) ? 'input' : id === 'segmentSelect' ? 'select' : 'div';
      const element = new FakeElement(tagName, id);
      if (id === 'fixedTop' || id === 'fixedBottom' || id === 'cropTop' || id === 'cropBottom') element.value = '0';
      if (id === 'btnStart') element.label.textContent = '开始';
      if (id === 'btnDir') element.label.textContent = '纵向';
      elements.set(id, element);
    }
    return elements.get(id);
  };
  const document = {
    getElementById: getElement,
    createElement(tagName) {
      if (tagName === 'canvas') return new FakeCanvas(renderedCanvases, faults);
      return new FakeElement(tagName);
    },
  };
  const pendingTimers = new Map();
  let nextTimerId = 1;
  const frameDefinitions = new Map();
  const captureQueue = [];
  let initListener = null;
  const windowListeners = new Map();

  class FakeImage {
    set src(value) {
      const frame = frameDefinitions.get(value);
      if (!frame) {
        Promise.resolve().then(() => this.onerror && this.onerror(new Error('unknown frame')));
        return;
      }
      this.naturalWidth = frame.width;
      this.naturalHeight = frame.height;
      this._pixels = frame.pixels;
      Promise.resolve().then(() => this.onload && this.onload());
    }
  }

  const kkapi = {
    onInit(listener) { initListener = listener; },
    async captureRegion() {
      if (!captureQueue.length) throw new Error('test capture queue is empty');
      return captureQueue.shift();
    },
    async saveImage() { return { saved: true }; },
    async copyImage() {},
    async closeSelf() {},
  };
  const window = {
    LongshotStitch: stitchApi,
    kkapi,
    addEventListener(type, listener) { windowListeners.set(type, listener); },
  };
  window.window = window;

  const context = {
    window,
    document,
    kkapi,
    Image: FakeImage,
    Uint8ClampedArray,
    setTimeout(listener, delay) {
      const id = nextTimerId++;
      pendingTimers.set(id, { listener, delay });
      return id;
    },
    clearTimeout(id) { pendingTimers.delete(id); },
    console,
  };
  vm.runInNewContext(longshotSource, context, { filename: 'longshot.js' });
  initListener({
    rect: { x: 0, y: 0, width: 4, height: 12 },
    displayId: 'test-display',
    scaleFactor: 1,
    longshotLimits: { maxFrames: 20, maxPixels: 20_000, maxConsecutiveFailures: 3 },
  });

  return {
    kkapi,
    elements,
    renderedCanvases,
    defineFrame(url, start, count = 12, width = 4) {
      frameDefinitions.set(url, { width, height: count, pixels: rowPixels(start, count, width) });
    },
    queueCapture(url) { captureQueue.push(url); },
    failNextTimelineRender() { faults.createImageData += 1; },
    click(id) { getElement(id).dispatch('click'); },
    keydown(key, options = {}) {
      windowListeners.get('keydown')({ key, preventDefault() {}, ...options });
    },
    async runNextTimer() {
      const entry = pendingTimers.entries().next().value;
      assert.ok(entry, 'a capture timer must be scheduled');
      const [id, timer] = entry;
      pendingTimers.delete(id);
      await Promise.resolve(timer.listener());
      await settle();
    },
  };
}

async function settle() {
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

async function readyExportRuntime() {
  const runtime = createRuntime();
  runtime.defineFrame('frame:a', 0);
  runtime.queueCapture('frame:a');
  runtime.click('btnStart');
  await settle();
  return runtime;
}

test('copy click, Enter and Cmd+C export without a save dialog', async () => {
  for (const trigger of [r => r.click('btnDone'), r => r.keydown('Enter'), r => r.keydown('c', { metaKey: true })]) {
    const r = await readyExportRuntime();
    const calls = [];
    r.kkapi.saveImage = async () => { calls.push('save'); return { saved: true }; };
    r.kkapi.copyImage = async () => { calls.push('copy'); return true; };
    r.kkapi.closeSelf = async () => { calls.push('close'); };
    trigger(r);
    await settle();
    assert.deepEqual(calls, ['copy', 'close']);
  }
});

test('Enter on a focused native button preserves its own action instead of copying', async () => {
  for (const id of ['btnSave', 'btnCancel', 'btnStart', 'btnDone']) {
    const r = await readyExportRuntime();
    const calls = [];
    let prevented = false;
    r.kkapi.saveImage = async () => { calls.push('save'); return { saved: true }; };
    r.kkapi.copyImage = async () => { calls.push('copy'); return true; };
    r.kkapi.closeSelf = async () => { calls.push('close'); };
    r.keydown('Enter', { target: { id, tagName: 'BUTTON' }, preventDefault() { prevented = true; } });
    await settle();
    assert.equal(prevented, false, id + ' must retain native Enter activation');
    assert.deepEqual(calls, [], id + ' must not be intercepted by the window shortcut');
  }
});

test('canceling save retains the PNG and restores both export actions for copy', async () => {
  const r = await readyExportRuntime();
  let savedPNG;
  let copiedPNG;
  let closed = 0;
  r.kkapi.saveImage = async data => { savedPNG = data; return { saved: false, canceled: true }; };
  r.kkapi.copyImage = async data => { copiedPNG = data; return true; };
  r.kkapi.closeSelf = async () => { closed++; };
  r.click('btnSave');
  await settle();
  assert.ok(savedPNG);
  assert.equal(closed, 0);
  assert.equal(r.elements.get('btnSave').disabled, false);
  assert.equal(r.elements.get('btnDone').disabled, false);
  assert.match(r.elements.get('hint').textContent, /取消保存/);
  r.click('btnDone');
  await settle();
  assert.equal(copiedPNG, savedPNG);
  assert.equal(closed, 1);
});

test('Cmd+S saves without changing clipboard and export shortcuts ignore text fields', async () => {
  const r = await readyExportRuntime();
  const calls = [];
  r.kkapi.saveImage = async () => { calls.push('save'); return { saved: true }; };
  r.kkapi.copyImage = async () => { calls.push('copy'); return true; };
  r.kkapi.closeSelf = async () => { calls.push('close'); };
  for (const tagName of ['INPUT', 'SELECT', 'TEXTAREA']) {
    r.keydown('c', { metaKey: true, target: { tagName } });
    r.keydown('s', { metaKey: true, target: { tagName } });
    r.keydown('Enter', { target: { tagName } });
  }
  await settle();
  assert.deepEqual(calls, []);
  r.keydown('s', { metaKey: true });
  await settle();
  assert.deepEqual(calls, ['save', 'close']);
});

test('cancel during clipboard write ignores its late completion and prevents duplicate export', async () => {
  const r = await readyExportRuntime();
  let resolveCopy;
  const calls = [];
  r.kkapi.copyImage = () => { calls.push('copy'); return new Promise(resolve => { resolveCopy = resolve; }); };
  r.kkapi.saveImage = async () => { calls.push('save'); return { saved: true }; };
  r.kkapi.closeSelf = async () => { calls.push('close'); };
  r.click('btnDone');
  await settle();
  assert.equal(r.elements.get('btnDone').disabled, true);
  assert.equal(r.elements.get('btnSave').disabled, true);
  r.click('btnSave');
  r.keydown('Escape');
  resolveCopy(true);
  await settle();
  assert.deepEqual(calls, ['copy', 'close']);
});

function renderedGreenRows(canvas) {
  const rows = [];
  for (let y = 0; y < canvas.height; y += 1) {
    rows.push(canvas._pixels[y * canvas.width * 4 + 1]);
  }
  return rows;
}

test('renderer can pause, edit, survive a bad frame, and continue from retained raw frames', async () => {
  const runtime = createRuntime();
  runtime.defineFrame('frame:a', 0);
  runtime.defineFrame('frame:b', 4);
  runtime.defineFrame('frame:c', 8);
  runtime.defineFrame('frame:wrong-width', 8, 12, 5);

  runtime.queueCapture('frame:a');
  runtime.click('btnStart');
  await settle();
  assert.equal(runtime.elements.get('count').textContent, '1');
  assert.equal(runtime.elements.get('btnStart').label.textContent, '暂停');

  runtime.queueCapture('frame:b');
  await runtime.runNextTimer();
  assert.equal(runtime.elements.get('count').textContent, '2');
  assert.equal(runtime.elements.get('btnAdjust').disabled, false,
    'after the second frame finishes, adjustment must remain directly available');

  runtime.click('btnStart');
  assert.equal(runtime.elements.get('btnStart').label.textContent, '继续');
  assert.equal(runtime.elements.get('btnDeleteSegment').disabled, false);

  runtime.click('btnDeleteSegment');
  assert.equal(runtime.elements.get('count').textContent, '1');
  runtime.click('btnUndo');
  assert.equal(runtime.elements.get('count').textContent, '2');

  const lastGoodCanvas = runtime.renderedCanvases.at(-1);
  assert.deepEqual(renderedGreenRows(lastGoodCanvas), Array.from({ length: 16 }, (_, row) => 20 + row * 10));

  runtime.queueCapture('frame:wrong-width');
  runtime.click('btnStart');
  await settle();
  assert.equal(runtime.elements.get('count').textContent, '2');
  assert.equal(runtime.elements.get('btnStart').label.textContent, '继续');
  assert.match(runtime.elements.get('hint').textContent, /DPR|尺寸|变化/);
  assert.equal(runtime.renderedCanvases.at(-1), lastGoodCanvas, 'a rejected frame must not replace the last good canvas');

  runtime.queueCapture('frame:b');
  runtime.click('btnStart');
  await settle();
  assert.equal(runtime.elements.get('btnStart').label.textContent, '暂停');
  assert.equal(runtime.elements.get('count').textContent, '2');

  runtime.queueCapture('frame:c');
  await runtime.runNextTimer();
  assert.equal(runtime.elements.get('count').textContent, '3');
  assert.deepEqual(
    renderedGreenRows(runtime.renderedCanvases.at(-1)),
    Array.from({ length: 20 }, (_, row) => 20 + row * 10)
  );
});

test('renderer rolls back an accepted frame when fresh-canvas rendering throws', async () => {
  const runtime = createRuntime();
  runtime.defineFrame('frame:a', 0);
  runtime.defineFrame('frame:b', 4);

  runtime.queueCapture('frame:a');
  runtime.click('btnStart');
  await settle();
  assert.equal(runtime.elements.get('count').textContent, '1');
  const lastGoodCanvas = runtime.renderedCanvases.at(-1);

  runtime.failNextTimelineRender();
  runtime.queueCapture('frame:b');
  await runtime.runNextTimer();
  assert.equal(runtime.elements.get('count').textContent, '1');
  assert.equal(runtime.renderedCanvases.at(-1), lastGoodCanvas);

  runtime.queueCapture('frame:b');
  runtime.click('btnStart');
  await settle();
  assert.equal(runtime.elements.get('count').textContent, '2', 'the rejected model mutation must be retryable');
});

test('an unconfirmed fixed-region suggestion does not pause or expand capture and the next scroll remains usable', async () => {
  const runtime = createRuntime({
    stitchApi: {
      ...LongshotStitch,
      createStitchTimeline(options) {
        const timeline = LongshotStitch.createStitchTimeline(options);
        let calls = 0;
        return {
          ...timeline,
          addFrame(frame) {
            calls += 1;
            if (calls === 2) return {
              ok: false, reason: 'fixed-bands-suggested',
              suggestion: { top: 3, bottom: 3 },
            };
            return timeline.addFrame(frame);
          },
        };
      },
    },
  });
  runtime.defineFrame('frame:a', 0);
  runtime.defineFrame('frame:b', 4);
  runtime.queueCapture('frame:a');
  runtime.click('btnStart');
  await settle();
  const original = runtime.renderedCanvases.at(-1);
  runtime.queueCapture('frame:b');
  await runtime.runNextTimer();
  assert.equal(runtime.elements.get('btnStart').label.textContent, '暂停', 'unconfirmed matching advice must not stop polling');
  assert.equal(runtime.elements.get('adjustPanel').hidden, true);
  assert.equal(runtime.elements.get('btnAdjust')['aria-expanded'], 'false');
  assert.equal(runtime.renderedCanvases.at(-1), original, 'uncertain frame must not corrupt the existing result');
  runtime.queueCapture('frame:b');
  await runtime.runNextTimer();
  assert.equal(runtime.elements.get('count').textContent, '2');
  assert.deepEqual(renderedGreenRows(runtime.renderedCanvases.at(-1)), Array.from({ length: 16 }, (_, row) => 20 + row * 10));
});

test('renderer rolls back an edit when fresh-canvas rendering throws', async () => {
  const runtime = createRuntime();
  runtime.defineFrame('frame:a', 0);
  runtime.defineFrame('frame:b', 4);

  runtime.queueCapture('frame:a');
  runtime.click('btnStart');
  await settle();
  runtime.queueCapture('frame:b');
  await runtime.runNextTimer();
  runtime.click('btnStart');
  assert.equal(runtime.elements.get('count').textContent, '2');
  const lastGoodCanvas = runtime.renderedCanvases.at(-1);

  runtime.failNextTimelineRender();
  runtime.click('btnDeleteSegment');
  assert.equal(runtime.elements.get('count').textContent, '2');
  assert.equal(runtime.renderedCanvases.at(-1), lastGoodCanvas);
  assert.match(runtime.elements.get('hint').textContent, /失败/);

  runtime.click('btnDeleteSegment');
  assert.equal(runtime.elements.get('count').textContent, '1', 'the rolled-back edit must be retryable');
});

test('renderer keeps the longshot window retryable and shows an error when clipboard copy fails', async () => {
  const copyOutcomes = [
    { name: 'false', run: async () => false },
    { name: 'undefined', run: async () => undefined },
    { name: 'rejection', run: async () => { throw new Error('clipboard unavailable'); } },
  ];

  for (const outcome of copyOutcomes) {
    const runtime = createRuntime();
    const calls = [];
    runtime.kkapi.saveImage = async () => {
      calls.push('save');
      return { saved: true };
    };
    runtime.kkapi.copyImage = async () => {
      calls.push('copy');
      return outcome.run();
    };
    runtime.kkapi.closeSelf = async () => calls.push('close');
    runtime.defineFrame('frame:a', 0);
    runtime.queueCapture('frame:a');
    runtime.click('btnStart');
    await settle();

    runtime.click('btnDone');
    await settle();

    assert.deepEqual(calls, ['copy'], outcome.name);
    assert.match(runtime.elements.get('hint').textContent, /复制到剪贴板失败/, outcome.name);
    assert.equal(runtime.elements.get('bar').classList.contains('busy'), false, outcome.name);
    assert.equal(runtime.elements.get('btnStart').disabled, false, outcome.name);
  }
});

test('renderer retries clipboard without reopening save when the exported image is unchanged', async () => {
  const runtime = createRuntime();
  const calls = [];
  let copySucceeds = false;
  runtime.kkapi.saveImage = async () => {
    calls.push('save');
    return { saved: true };
  };
  runtime.kkapi.copyImage = async () => {
    calls.push('copy');
    return copySucceeds;
  };
  runtime.kkapi.closeSelf = async () => calls.push('close');
  runtime.defineFrame('frame:a', 0);
  runtime.queueCapture('frame:a');
  runtime.click('btnStart');
  await settle();

  runtime.click('btnDone');
  await settle();
  copySucceeds = true;
  runtime.click('btnDone');
  await settle();

  assert.deepEqual(calls, ['copy', 'copy', 'close']);
});

test('renderer still copies without saving after crop or timeline changes following a clipboard failure', async () => {
  const mutations = [
    {
      name: 'crop',
      run(runtime) {
        const cropTop = runtime.elements.get('cropTop');
        cropTop.value = '1';
        cropTop.dispatch('input');
        cropTop.value = '0';
        cropTop.dispatch('input');
      },
    },
    {
      name: 'timeline',
      run(runtime) { runtime.click('btnDeleteSegment'); },
    },
  ];

  for (const mutation of mutations) {
    const runtime = createRuntime();
    const calls = [];
    let copySucceeds = false;
    runtime.kkapi.saveImage = async () => {
      calls.push('save');
      return { saved: true };
    };
    runtime.kkapi.copyImage = async () => {
      calls.push('copy');
      return copySucceeds;
    };
    runtime.kkapi.closeSelf = async () => calls.push('close');
    runtime.defineFrame('frame:a', 0);
    runtime.defineFrame('frame:b', 4);
    runtime.queueCapture('frame:a');
    runtime.click('btnStart');
    await settle();
    runtime.queueCapture('frame:b');
    await runtime.runNextTimer();
    runtime.click('btnStart');

    runtime.click('btnDone');
    await settle();
    mutation.run(runtime);
    copySucceeds = true;
    runtime.click('btnDone');
    await settle();

    assert.deepEqual(calls, ['copy', 'copy', 'close'], mutation.name);
  }
});
