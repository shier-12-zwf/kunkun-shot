const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseScreenSourceIndex,
  selectDisplaySource,
  serializeCaptureSources,
} = require('../src/main/capture-source-matcher');

const displays = [
  { id: 101, size: { width: 1440, height: 900 } },
  { id: 202, size: { width: 1920, height: 1080 } },
];

test('display_id is authoritative even when source order is reversed', () => {
  const sources = [
    { id: 'screen:1:0', display_id: '202' },
    { id: 'screen:0:0', display_id: '101' },
  ];

  assert.equal(selectDisplaySource(sources, displays[0], displays), sources[1]);
});

test('screen source index matches the display index when macOS omits display_id', () => {
  const sources = [
    { id: 'screen:1:0', display_id: '' },
    { id: 'screen:0:0', display_id: '' },
  ];

  assert.equal(parseScreenSourceIndex('screen:17:0'), 17);
  assert.equal(parseScreenSourceIndex('window:17:0'), null);
  assert.equal(selectDisplaySource(sources, displays[0], displays), sources[1]);
  assert.equal(selectDisplaySource(sources, displays[1], displays), sources[0]);
});

test('a unique thumbnail aspect ratio can identify a source without ids', () => {
  const sources = [
    { id: 'opaque-a', display_id: '', thumbnail: { getSize: () => ({ width: 1600, height: 1000 }) } },
    { id: 'opaque-b', display_id: '', thumbnail: { getSize: () => ({ width: 1920, height: 1080 }) } },
  ];

  assert.equal(selectDisplaySource(sources, displays[1], displays), sources[1]);
});

test('ambiguous multi-display sources fail explicitly instead of silently using the first screen', () => {
  const sources = [
    { id: 'opaque-a', display_id: '' },
    { id: 'opaque-b', display_id: '' },
  ];

  assert.throws(
    () => selectDisplaySource(sources, displays[1], displays),
    /无法可靠匹配目标显示器/
  );
});

test('serialized sources expose a parsed index for recorder matching after reordering', () => {
  assert.deepEqual(
    serializeCaptureSources([
      { id: 'screen:3:0', name: 'Screen 4', display_id: '' },
      { id: 'opaque', name: 'Unknown', display_id: '' },
    ]),
    [
      { id: 'screen:3:0', name: 'Screen 4', display_id: '', screen_index: 3 },
      { id: 'opaque', name: 'Unknown', display_id: '', screen_index: null },
    ]
  );
});
