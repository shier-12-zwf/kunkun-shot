(function (root, factory) {
  'use strict';
  var exported = factory();
  if (typeof module === 'object' && module.exports) module.exports = exported;
  if (root) root.PinContentUpdate = exported;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var MAX_IMAGE_DATA_URL_CHARS = 128 * 1024 * 1024;
  var MAX_REVISION = 2147483647;

  function requireImageDataURL(value) {
    if (typeof value !== 'string' || value.length > MAX_IMAGE_DATA_URL_CHARS) {
      throw new Error('贴图内容图片无效。');
    }
    var match = /^data:image\/(?:png|jpe?g|webp|gif|bmp);base64,([\s\S]+)$/i.exec(value);
    if (!match) throw new Error('贴图内容图片无效。');
    var base64 = match[1].replace(/\s/g, '');
    if (!base64 || base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
      throw new Error('贴图内容图片无效。');
    }
    return value;
  }

  function normalizePinContentUpdate(value, validateDataURL) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('贴图内容更新格式无效。');
    }
    var keys = Object.keys(value).sort();
    var expected = ['baseRevision', 'dataURL', 'revision'];
    if (keys.length !== expected.length || keys.some(function (key, index) { return key !== expected[index]; })) {
      throw new Error('贴图内容更新字段无效。');
    }
    if (!Number.isSafeInteger(value.baseRevision) || value.baseRevision < 0 || value.baseRevision >= MAX_REVISION) {
      throw new Error('贴图内容 baseRevision 无效。');
    }
    if (!Number.isSafeInteger(value.revision) || value.revision !== value.baseRevision + 1 || value.revision > MAX_REVISION) {
      throw new Error('贴图内容 revision 必须严格递增。');
    }
    var validate = typeof validateDataURL === 'function' ? validateDataURL : requireImageDataURL;
    return {
      baseRevision: value.baseRevision,
      revision: value.revision,
      dataURL: validate(value.dataURL),
    };
  }

  function cloneSnapshot(value) {
    if (value === undefined) return null;
    return JSON.parse(JSON.stringify(value));
  }

  function createOrderedPinContentUpdater(options) {
    options = options && typeof options === 'object' ? options : {};
    if (typeof options.compose !== 'function') throw new TypeError('缺少贴图内容合成器。');
    if (typeof options.publish !== 'function') throw new TypeError('缺少贴图内容发布器。');
    var validate = typeof options.validateDataURL === 'function' ? options.validateDataURL : requireImageDataURL;
    var sourceDataURL = validate(options.sourceDataURL);
    var currentDataURL = sourceDataURL;
    var publishedRevision = options.initialRevision === undefined ? 0 : options.initialRevision;
    if (!Number.isSafeInteger(publishedRevision) || publishedRevision < 0 || publishedRevision >= MAX_REVISION) {
      throw new TypeError('贴图初始内容 revision 无效。');
    }
    var retryablePublishFailure = false;
    var tail = Promise.resolve(currentDataURL);

    async function publishCurrent(dataURL) {
      var payload = normalizePinContentUpdate({
        baseRevision: publishedRevision,
        revision: publishedRevision + 1,
        dataURL: dataURL,
      }, validate);
      var result = await options.publish(payload);
      if (!result || result.ok !== true) {
        throw new Error((result && result.error) || '主进程未确认贴图内容更新。');
      }
      if (result.revision !== payload.revision) {
        throw new Error('主进程贴图内容 revision 回执无效。');
      }
      publishedRevision = payload.revision;
      retryablePublishFailure = false;
      return currentDataURL;
    }

    function update(snapshot) {
      // AnnotationDocument.snapshot() 仍是可变数组；在入队边界深拷贝，
      // 避免图片异步解码期间后续笔画污染较早的 revision。
      var frozenSnapshot = cloneSnapshot(snapshot);
      var task = tail.catch(function () {
        // 主进程可能已应用上一版、仅 IPC 回执丢失。必须先用完全相同的
        // payload 幂等确认上一 revision，才能合成并发布下一版；否则下一版
        // 会错误复用同一 revision，形成“同序号不同内容”的冲突。
        if (retryablePublishFailure) return publishCurrent(currentDataURL);
      }).then(async function () {
        retryablePublishFailure = false;
        var composed = validate(await options.compose(sourceDataURL, frozenSnapshot));
        currentDataURL = composed;
        retryablePublishFailure = true;
        try {
          return await publishCurrent(composed);
        } catch (error) {
          retryablePublishFailure = true;
          throw error;
        }
      });
      tail = task;
      return task;
    }

    function flush() {
      // IPC 在主进程应用更新后仍可能因回执丢失而 reject。flush 会用相同
      // baseRevision/revision/dataURL 重试当前已合成内容；主进程端应对完全相同的重放幂等。
      var task = tail.catch(function (error) {
        if (!retryablePublishFailure) throw error;
        return publishCurrent(currentDataURL);
      }).then(function () { return currentDataURL; });
      tail = task;
      return task;
    }

    return {
      update: update,
      flush: flush,
      getCurrentDataURL: function () { return currentDataURL; },
      getPublishedRevision: function () { return publishedRevision; },
    };
  }

  return {
    createOrderedPinContentUpdater: createOrderedPinContentUpdater,
    normalizePinContentUpdate: normalizePinContentUpdate,
  };
});
