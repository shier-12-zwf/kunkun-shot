(function (root, factory) {
  'use strict';
  var exported = factory();
  if (typeof module === 'object' && module.exports) module.exports = exported;
  if (root) root.PinImageLoader = exported;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function errorMessage(error) {
    if (error && typeof error.message === 'string' && error.message) return error.message;
    return String(error || '图片解码失败。');
  }

  function validDimension(value) {
    return Number.isFinite(Number(value)) && Number(value) > 0 && Number(value) <= 100000;
  }

  function createPinImageLoader(options) {
    options = options && typeof options === 'object' ? options : {};
    if (typeof options.decode !== 'function') throw new TypeError('缺少贴图图片解码器。');

    var generation = 0;
    var state = {
      generation: 0,
      status: 'idle',
      committedDataURL: '',
      candidateDataURL: '',
      width: 0,
      height: 0,
      error: '',
    };

    function snapshot() {
      return {
        generation: state.generation,
        status: state.status,
        committedDataURL: state.committedDataURL,
        candidateDataURL: state.candidateDataURL,
        width: state.width,
        height: state.height,
        error: state.error,
      };
    }

    function emit() {
      var value = snapshot();
      if (typeof options.onState === 'function') options.onState(value);
      return value;
    }

    function load(dataURL) {
      var token = ++generation;
      // Capture the candidate per generation. Reading the mutable state again in
      // the microtask would make two immediate load() calls decode the newer URL
      // twice, even though the stale-generation commit guard still worked.
      var candidateDataURL = typeof dataURL === 'string' ? dataURL : '';
      state.generation = token;
      state.status = 'decoding';
      state.candidateDataURL = candidateDataURL;
      state.error = '';
      emit();

      return Promise.resolve()
        .then(function () {
          if (!candidateDataURL) throw new Error('贴图图片数据为空。');
          return options.decode(candidateDataURL);
        })
        .then(function (decoded) {
          if (token !== generation) return { status: 'stale', generation: token };
          var width = decoded && decoded.width;
          var height = decoded && decoded.height;
          if (!validDimension(width) || !validDimension(height)) {
            throw new Error('贴图图片尺寸无效。');
          }
          var committed = {
            dataURL: candidateDataURL,
            width: Math.round(Number(width)),
            height: Math.round(Number(height)),
            generation: token,
          };
          if (typeof options.onCommit === 'function') options.onCommit(committed, snapshot());
          state.status = 'ready';
          state.committedDataURL = committed.dataURL;
          state.candidateDataURL = '';
          state.width = committed.width;
          state.height = committed.height;
          state.error = '';
          emit();
          return {
            status: 'ready',
            generation: token,
            dataURL: committed.dataURL,
            width: committed.width,
            height: committed.height,
          };
        })
        .catch(function (error) {
          if (token !== generation) return { status: 'stale', generation: token };
          state.status = 'error';
          state.error = errorMessage(error);
          emit();
          return { status: 'error', generation: token, error: state.error };
        });
    }

    function retry() {
      var candidate = state.candidateDataURL;
      if (!candidate) {
        return Promise.resolve({
          status: state.status,
          generation: state.generation,
          dataURL: state.committedDataURL,
        });
      }
      return load(candidate);
    }

    function cancel() {
      generation += 1;
      state.generation = generation;
      state.status = state.committedDataURL ? 'ready' : 'idle';
      state.candidateDataURL = '';
      state.error = '';
      emit();
    }

    return {
      load: load,
      retry: retry,
      cancel: cancel,
      getState: snapshot,
      isReady: function () { return state.status === 'ready'; },
    };
  }

  return { createPinImageLoader: createPinImageLoader };
});
