const test = require('node:test');
const assert = require('node:assert/strict');

const {
  AnnotationDocument,
  composeAnnotatedDataURL,
  normalizePinWindowState,
  mergePinWindowState,
} = require('../src/renderer/pin/pin-annotations');

function point(x, y) {
  return { x, y };
}

test('annotation document supports every pin drawing tool with undo, redo and reversible clear', () => {
  const doc = new AnnotationDocument();
  const stroke = { color: '#ff3b30', width: 0.01 };

  doc.begin('pen', point(0.1, 0.1), stroke);
  doc.update(point(0.2, 0.25));
  doc.finish(point(0.3, 0.2));

  for (const tool of ['line', 'arrow', 'rect', 'ellipse']) {
    doc.begin(tool, point(0.1, 0.2), stroke);
    doc.finish(point(0.8, 0.75));
  }

  doc.addText(point(0.25, 0.5), 'PinPix parity', {
    color: '#246bfd',
    fontSize: 0.05,
  });
  doc.begin('eraser', point(0.4, 0.4), { width: 0.04 });
  doc.update(point(0.5, 0.5));
  doc.finish(point(0.6, 0.6));

  assert.deepEqual(
    doc.snapshot().map((command) => command.type),
    ['pen', 'line', 'arrow', 'rect', 'ellipse', 'text', 'eraser']
  );

  assert.equal(doc.undo(), true);
  assert.equal(doc.snapshot().at(-1).type, 'text');
  assert.equal(doc.redo(), true);
  assert.equal(doc.snapshot().at(-1).type, 'eraser');

  assert.equal(doc.clear(), true);
  assert.equal(doc.isEmpty(), true);
  assert.equal(doc.undo(), true, 'clear must itself be undoable');
  assert.equal(doc.snapshot().length, 7);
  assert.equal(doc.redo(), true);
  assert.equal(doc.isEmpty(), true);
});

test('annotation input is normalized and rejects unsafe or degenerate commands', () => {
  const doc = new AnnotationDocument();

  assert.equal(doc.begin('script', point(0, 0), {}), false);
  assert.equal(doc.addText(point(2, -1), '   ', {}), false);

  doc.begin('rect', point(-2, 3), { color: 'javascript:bad', width: 99 });
  doc.finish(point(4, -5));
  const rect = doc.snapshot()[0];

  assert.deepEqual(rect.start, point(0, 1));
  assert.deepEqual(rect.end, point(1, 0));
  assert.equal(rect.style.color, '#ff3b30');
  assert.equal(rect.style.width, 0.05);
});

test('quit-time snapshots can preserve the visible in-progress stroke without mutating history', () => {
  const doc = new AnnotationDocument();
  doc.begin('pen', point(0.1, 0.2), { color: '#ff3b30', width: 0.01 });
  doc.update(point(0.7, 0.8));

  assert.deepEqual(doc.snapshot(), [], 'ordinary persisted snapshots contain committed commands only');
  const closing = doc.snapshot(true);
  assert.equal(closing.length, 1);
  assert.equal(closing[0].type, 'pen');
  assert.equal(closing[0].points.length, 2);
  assert.deepEqual(doc.snapshot(), [], 'taking the quit snapshot must not mutate undo/redo state');
});

test('close barrier can commit the visible in-progress stroke as the final editable document', () => {
  const doc = new AnnotationDocument();
  doc.begin('pen', point(0.1, 0.2), { color: '#ff3b30', width: 0.01 });
  doc.update(point(0.7, 0.8));

  assert.equal(doc.commitActive(), true);
  assert.equal(doc.active, null);
  assert.equal(doc.snapshot().length, 1);
  assert.deepEqual(doc.snapshot()[0].points, [point(0.1, 0.2), point(0.7, 0.8)]);
  assert.equal(doc.commitActive(), false, 'committing an already-frozen document is idempotent');
  assert.equal(doc.undo(), true, 'the close-time commit remains a normal undoable command if close is canceled');
  assert.deepEqual(doc.snapshot(), []);
});

test('composite export keeps eraser scoped to the annotation layer and returns PNG data', async () => {
  const calls = [];
  let canvasNo = 0;
  function createCanvas() {
    canvasNo += 1;
    const label = canvasNo === 1 ? 'base' : 'overlay';
    const context = {
      globalCompositeOperation: 'source-over',
      drawImage(image) {
        calls.push([label, 'drawImage', image.tag || image.label]);
      },
      save() { calls.push([label, 'save']); },
      restore() { calls.push([label, 'restore']); },
      beginPath() { calls.push([label, 'beginPath', this.globalCompositeOperation]); },
      moveTo() {},
      lineTo() {},
      stroke() { calls.push([label, 'stroke', this.globalCompositeOperation]); },
      setLineDash() {},
    };
    return {
      label,
      width: 0,
      height: 0,
      getContext: () => context,
      toDataURL: () => 'data:image/png;base64,annotated',
    };
  }

  const doc = new AnnotationDocument();
  doc.begin('pen', point(0.1, 0.1), { width: 0.01 });
  doc.finish(point(0.8, 0.8));
  doc.begin('eraser', point(0.4, 0.4), { width: 0.04 });
  doc.finish(point(0.6, 0.6));

  const result = await composeAnnotatedDataURL('data:image/png;base64,source', doc, {
    createCanvas,
    loadImage: async () => ({ tag: 'source-image', naturalWidth: 640, naturalHeight: 480 }),
  });

  assert.equal(result, 'data:image/png;base64,annotated');
  assert.deepEqual(calls[0], ['base', 'drawImage', 'source-image']);
  assert.ok(
    calls.some((entry) => entry[0] === 'overlay' && entry[1] === 'stroke' && entry[2] === 'destination-out'),
    'eraser must erase the transparent annotation layer'
  );
  assert.deepEqual(calls.at(-1), ['base', 'drawImage', 'overlay']);
});

test('pin window state restoration and updates are whitelisted, clamped and merge-safe', () => {
  assert.deepEqual(
    normalizePinWindowState({ opacity: 2, locked: 1, onTop: false, title: '  hello  ', injected: true }),
    { opacity: 1, locked: true, onTop: false, title: 'hello' }
  );
  assert.deepEqual(
    normalizePinWindowState({ opacity: 0.05, locked: 'false', title: 'x'.repeat(500) }),
    { opacity: 0.3, locked: false, onTop: true, title: 'x'.repeat(120) }
  );

  const current = { opacity: 0.8, locked: true, onTop: false, title: 'keep' };
  assert.deepEqual(mergePinWindowState(current, { opacity: 0.55, injected: 'drop' }), {
    opacity: 0.55,
    locked: true,
    onTop: false,
    title: 'keep',
  });
});
