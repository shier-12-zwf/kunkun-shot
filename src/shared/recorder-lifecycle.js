'use strict';

// This module is deliberately dependency-free and uses a tiny UMD wrapper so the
// exact same lifecycle contract is available to Electron's main process, tests,
// and the sandboxed recorder page.
(function exposeRecorderLifecycle(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (root && typeof root === 'object') root.KKRecorderLifecycle = api;
})(typeof globalThis === 'object' ? globalThis : this, function buildRecorderLifecycle() {
  const RECORDER_STATES = Object.freeze({
    OPENING: 'opening',
    IDLE: 'idle',
    STARTING: 'starting',
    ACTIVE: 'active',
    PAUSED: 'paused',
    STOPPING: 'stopping',
    SERIALIZING: 'serializing',
    SAVING: 'saving',
    SAVE_RETRY: 'save-retry',
    SAVED: 'saved',
    CANCELED: 'canceled',
    ERROR: 'error',
    DETACHED: 'detached',
  });

  const VALID_STATES = new Set(Object.values(RECORDER_STATES));
  const REPLACEABLE_STATES = new Set([
    RECORDER_STATES.IDLE,
    RECORDER_STATES.SAVED,
    RECORDER_STATES.CANCELED,
  ]);
  const DIRECTLY_CLOSABLE_STATES = new Set([
    RECORDER_STATES.IDLE,
    RECORDER_STATES.SAVED,
    RECORDER_STATES.CANCELED,
    RECORDER_STATES.DETACHED,
  ]);

  function isNonNegativeInteger(value) {
    return Number.isSafeInteger(value) && value >= 0;
  }

  function normalizeRecorderLifecycleSnapshot(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('recorder lifecycle snapshot must be an object');
    }
    const allowed = new Set(['state', 'generation', 'saveAttempt']);
    for (const key of Object.keys(value)) {
      if (!allowed.has(key)) throw new Error(`unknown recorder lifecycle field: ${key}`);
    }
    if (!VALID_STATES.has(value.state)) throw new Error('recorder lifecycle state is invalid');
    if (!isNonNegativeInteger(value.generation)) {
      throw new Error('recorder lifecycle generation must be a non-negative safe integer');
    }
    if (!isNonNegativeInteger(value.saveAttempt)) {
      throw new Error('recorder lifecycle saveAttempt must be a non-negative safe integer');
    }
    return {
      state: value.state,
      generation: value.generation,
      saveAttempt: value.saveAttempt,
    };
  }

  function decideRecorderWindowOpen({ hasWindow, state } = {}) {
    if (hasWindow !== true) return { action: 'create', busy: false, state: null };
    const safeState = VALID_STATES.has(state) ? state : RECORDER_STATES.OPENING;
    if (REPLACEABLE_STATES.has(safeState)) {
      return { action: 'replace-existing', busy: false, state: safeState };
    }
    // Unknown/opening state fails closed. Closing a window while its first state
    // report is in flight is the same data-loss race as closing an active one.
    return { action: 'focus-existing', busy: true, state: safeState };
  }

  function canCloseRecorderWindow(state) {
    return VALID_STATES.has(state) && DIRECTLY_CLOSABLE_STATES.has(state);
  }

  function createRecorderLifecycle(options = {}) {
    const onChange = typeof options.onChange === 'function' ? options.onChange : null;
    let state = RECORDER_STATES.IDLE;
    let generation = 0;
    let saveAttempt = 0;

    function snapshot() {
      return { state, generation, saveAttempt };
    }

    function emit() {
      const current = snapshot();
      if (onChange) {
        try { onChange(current); } catch (_) { /* lifecycle cannot depend on telemetry */ }
      }
      return current;
    }

    function transition(nextState) {
      state = nextState;
      return emit();
    }

    function accepted(extra) {
      return Object.assign({ accepted: true, state }, extra || {});
    }

    function rejected(reason) {
      return { accepted: false, state, reason: reason || 'invalid-transition' };
    }

    function isCurrentGeneration(token) {
      return !!token
        && isNonNegativeInteger(token.generation)
        && token.generation === generation
        && state !== RECORDER_STATES.CANCELED
        && state !== RECORDER_STATES.DETACHED;
    }

    function isCurrentSave(token) {
      return isCurrentGeneration(token)
        && isNonNegativeInteger(token.saveAttempt)
        && token.saveAttempt === saveAttempt
        && (
          state === RECORDER_STATES.SERIALIZING
          || state === RECORDER_STATES.SAVING
        );
    }

    function beginStart() {
      if (![RECORDER_STATES.IDLE, RECORDER_STATES.ERROR].includes(state)) return null;
      generation += 1;
      saveAttempt = 0;
      transition(RECORDER_STATES.STARTING);
      return Object.freeze({ generation });
    }

    function markActive(token) {
      if (state !== RECORDER_STATES.STARTING || !isCurrentGeneration(token)) {
        return rejected('stale-start');
      }
      transition(RECORDER_STATES.ACTIVE);
      return accepted();
    }

    function markPaused() {
      if (state !== RECORDER_STATES.ACTIVE) return rejected();
      transition(RECORDER_STATES.PAUSED);
      return accepted();
    }

    function markResumed() {
      if (state !== RECORDER_STATES.PAUSED) return rejected();
      transition(RECORDER_STATES.ACTIVE);
      return accepted();
    }

    function beginStop() {
      if (![RECORDER_STATES.ACTIVE, RECORDER_STATES.PAUSED].includes(state)) return rejected();
      transition(RECORDER_STATES.STOPPING);
      return accepted();
    }

    function beginSerialization() {
      if (![RECORDER_STATES.STOPPING, RECORDER_STATES.SAVE_RETRY].includes(state)) return null;
      saveAttempt += 1;
      transition(RECORDER_STATES.SERIALIZING);
      return Object.freeze({ generation, saveAttempt });
    }

    function markSaveSubmitted(token) {
      if (state !== RECORDER_STATES.SERIALIZING || !isCurrentSave(token)) {
        return rejected('stale-save');
      }
      transition(RECORDER_STATES.SAVING);
      return accepted();
    }

    function failSerialization(token) {
      if (state !== RECORDER_STATES.SERIALIZING || !isCurrentSave(token)) {
        return rejected('stale-save');
      }
      transition(RECORDER_STATES.SAVE_RETRY);
      return accepted();
    }

    function completeSave(token, result) {
      if (state !== RECORDER_STATES.SAVING || !isCurrentSave(token)) {
        return rejected('stale-save');
      }
      transition(result && result.saved === true
        ? RECORDER_STATES.SAVED
        : RECORDER_STATES.SAVE_RETRY);
      return accepted({ saved: state === RECORDER_STATES.SAVED });
    }

    function markError() {
      if ([RECORDER_STATES.CANCELED, RECORDER_STATES.SAVED, RECORDER_STATES.DETACHED].includes(state)) {
        return rejected();
      }
      transition(RECORDER_STATES.ERROR);
      return accepted();
    }

    function requestCancel() {
      if (state === RECORDER_STATES.SAVING) {
        // ipcRenderer.invoke has crossed the commit boundary. The main process may
        // already have written the destination file, so calling this "canceled"
        // would be dishonest and can also provoke a duplicate retry.
        return {
          accepted: false,
          state,
          outcome: 'save-outcome-pending',
        };
      }
      if (state === RECORDER_STATES.SAVED) {
        return { accepted: true, state, outcome: 'already-saved' };
      }
      if (state === RECORDER_STATES.CANCELED) {
        return { accepted: true, state, outcome: 'already-canceled' };
      }
      if (state === RECORDER_STATES.DETACHED) return rejected('already-detached');

      const previous = state;
      generation += 1;
      saveAttempt += 1;
      transition(RECORDER_STATES.CANCELED);
      const beforeSubmit = [
        RECORDER_STATES.STOPPING,
        RECORDER_STATES.SERIALIZING,
        RECORDER_STATES.SAVE_RETRY,
      ].includes(previous);
      return accepted({ outcome: beforeSubmit ? 'canceled-before-submit' : 'canceled-recording' });
    }

    function detach() {
      const previous = state;
      generation += 1;
      saveAttempt += 1;
      transition(RECORDER_STATES.DETACHED);
      return accepted({
        outcome: previous === RECORDER_STATES.SAVING
          ? 'detached-save-outcome-unknown'
          : 'detached',
      });
    }

    return Object.freeze({
      snapshot,
      beginStart,
      markActive,
      markPaused,
      markResumed,
      beginStop,
      beginSerialization,
      markSaveSubmitted,
      failSerialization,
      completeSave,
      markError,
      requestCancel,
      detach,
      isCurrentGeneration,
      isCurrentSave,
    });
  }

  return Object.freeze({
    RECORDER_STATES,
    createRecorderLifecycle,
    decideRecorderWindowOpen,
    canCloseRecorderWindow,
    normalizeRecorderLifecycleSnapshot,
  });
});
