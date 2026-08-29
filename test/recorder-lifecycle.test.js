'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  RECORDER_STATES,
  createRecorderLifecycle,
  decideRecorderWindowOpen,
  canCloseRecorderWindow,
  normalizeRecorderLifecycleSnapshot,
} = require('../src/shared/recorder-lifecycle');

test('a content-bearing recorder is focused instead of replaced', () => {
  for (const state of [
    RECORDER_STATES.STARTING,
    RECORDER_STATES.ACTIVE,
    RECORDER_STATES.PAUSED,
    RECORDER_STATES.STOPPING,
    RECORDER_STATES.SERIALIZING,
    RECORDER_STATES.SAVING,
    RECORDER_STATES.SAVE_RETRY,
    RECORDER_STATES.ERROR,
  ]) {
    assert.deepEqual(
      decideRecorderWindowOpen({ hasWindow: true, state }),
      { action: 'focus-existing', busy: true, state },
      `state ${state} must preserve the existing recorder`,
    );
  }
});

test('an opening or unknown existing recorder fails closed against replacement', () => {
  assert.deepEqual(
    decideRecorderWindowOpen({ hasWindow: true, state: RECORDER_STATES.OPENING }),
    { action: 'focus-existing', busy: true, state: RECORDER_STATES.OPENING },
  );
  assert.deepEqual(
    decideRecorderWindowOpen({ hasWindow: true, state: 'forged-state' }),
    { action: 'focus-existing', busy: true, state: RECORDER_STATES.OPENING },
  );
});

test('only recorders without unsaved content may be replaced or closed directly', () => {
  assert.deepEqual(
    decideRecorderWindowOpen({ hasWindow: false, state: null }),
    { action: 'create', busy: false, state: null },
  );
  assert.deepEqual(
    decideRecorderWindowOpen({ hasWindow: true, state: RECORDER_STATES.IDLE }),
    { action: 'replace-existing', busy: false, state: RECORDER_STATES.IDLE },
  );
  assert.equal(canCloseRecorderWindow(RECORDER_STATES.ACTIVE), false);
  assert.equal(canCloseRecorderWindow(RECORDER_STATES.SAVE_RETRY), false);
  assert.equal(canCloseRecorderWindow(RECORDER_STATES.CANCELED), true);
  assert.equal(canCloseRecorderWindow(RECORDER_STATES.SAVED), true);
  assert.equal(canCloseRecorderWindow('forged-state'), false);
});

test('cancel during Blob serialization invalidates the save token before IPC submission', () => {
  const lifecycle = createRecorderLifecycle();
  const start = lifecycle.beginStart();
  assert.equal(lifecycle.markActive(start).accepted, true);
  assert.equal(lifecycle.beginStop().accepted, true);
  const saveToken = lifecycle.beginSerialization();

  assert.equal(lifecycle.isCurrentSave(saveToken), true);
  const cancellation = lifecycle.requestCancel();
  assert.deepEqual(cancellation, {
    accepted: true,
    state: RECORDER_STATES.CANCELED,
    outcome: 'canceled-before-submit',
  });
  assert.equal(lifecycle.isCurrentSave(saveToken), false);
  assert.equal(lifecycle.markSaveSubmitted(saveToken).accepted, false);
});

test('cancel after save IPC submission is refused because commit outcome is unknown', () => {
  const lifecycle = createRecorderLifecycle();
  const start = lifecycle.beginStart();
  lifecycle.markActive(start);
  lifecycle.beginStop();
  const saveToken = lifecycle.beginSerialization();
  assert.equal(lifecycle.markSaveSubmitted(saveToken).accepted, true);

  assert.deepEqual(lifecycle.requestCancel(), {
    accepted: false,
    state: RECORDER_STATES.SAVING,
    outcome: 'save-outcome-pending',
  });
  assert.equal(lifecycle.isCurrentSave(saveToken), true);
});

test('forced detach invalidates late IPC results without claiming the save was canceled', () => {
  const lifecycle = createRecorderLifecycle();
  const start = lifecycle.beginStart();
  lifecycle.markActive(start);
  lifecycle.beginStop();
  const saveToken = lifecycle.beginSerialization();
  lifecycle.markSaveSubmitted(saveToken);

  const detached = lifecycle.detach();
  assert.deepEqual(detached, {
    accepted: true,
    state: RECORDER_STATES.DETACHED,
    outcome: 'detached-save-outcome-unknown',
  });
  assert.equal(lifecycle.isCurrentSave(saveToken), false);
  assert.equal(lifecycle.completeSave(saveToken, { saved: true }).accepted, false);
});

test('failed save is retryable with a fresh token and stale attempts cannot mutate state', () => {
  const lifecycle = createRecorderLifecycle();
  const start = lifecycle.beginStart();
  lifecycle.markActive(start);
  lifecycle.beginStop();
  const first = lifecycle.beginSerialization();
  lifecycle.markSaveSubmitted(first);
  assert.equal(lifecycle.completeSave(first, { saved: false }).accepted, true);
  assert.equal(lifecycle.snapshot().state, RECORDER_STATES.SAVE_RETRY);

  const second = lifecycle.beginSerialization();
  assert.notEqual(second.saveAttempt, first.saveAttempt);
  assert.equal(lifecycle.completeSave(first, { saved: true }).accepted, false);
  assert.equal(lifecycle.snapshot().state, RECORDER_STATES.SERIALIZING);
  lifecycle.markSaveSubmitted(second);
  assert.equal(lifecycle.completeSave(second, { saved: true }).accepted, true);
  assert.equal(lifecycle.snapshot().state, RECORDER_STATES.SAVED);
});

test('main-process snapshots are strictly normalized', () => {
  assert.deepEqual(
    normalizeRecorderLifecycleSnapshot({ state: 'paused', generation: 4, saveAttempt: 2 }),
    { state: 'paused', generation: 4, saveAttempt: 2 },
  );
  assert.throws(
    () => normalizeRecorderLifecycleSnapshot({ state: 'paused', generation: '4', saveAttempt: 2 }),
    /generation/,
  );
  assert.throws(
    () => normalizeRecorderLifecycleSnapshot({ state: 'forged', generation: 1, saveAttempt: 0 }),
    /state/,
  );
  assert.throws(
    () => normalizeRecorderLifecycleSnapshot({ state: 'active', generation: 1, extra: true }),
    /unknown/i,
  );
});
