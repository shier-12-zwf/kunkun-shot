// 贴图窗逻辑：纯渲染层，禁止 require，所有与主进程交互都走 window.kkapi。
// 初始化 payload: { dataURL, bounds }。窗口尺寸由主进程按 bounds 设好，这里只负责填图与交互。

(function () {
  'use strict';

  // ---- DOM 引用 ----
  var imgEl = document.getElementById('pinImg');
  var wrapEl = document.getElementById('pinWrap');
  var toolbarEl = document.getElementById('pinToolbar');
  var ctxMenu = document.getElementById('ctxMenu');
  var ctxMenuItems = Array.prototype.slice.call(ctxMenu.querySelectorAll('[role="menuitem"]'));
  var ctxMenuReturnFocus = null;
  var toastEl = document.getElementById('pinToast');
  var annotationCanvas = document.getElementById('pinAnnotationCanvas');
  var annotationToolbar = document.getElementById('pinAnnotationToolbar');
  var annotationColor = document.getElementById('pinAnnotationColor');
  var annotationApi = window.PinAnnotations || null;
  var contentApi = window.PinContentUpdate || null;
  var annotationDoc = annotationApi ? new annotationApi.AnnotationDocument() : null;
  var contentUpdater = null;
  var ocrRequestToken = 0;
  var closeBarrierMode = ''; // '' | ordinary | application
  var closeAttempt = null;
  var applicationClosePreparation = null;
  var applicationCloseEpoch = 0;
  var finishActiveAnnotationForClose = function () {
    if (!annotationDoc || typeof annotationDoc.commitActive !== 'function') return false;
    var changed = annotationDoc.commitActive();
    if (changed) redrawAnnotations();
    return changed;
  };

  // 当前贴图数据
  var state = {
    dataURL: '',
    sourceDataURL: '',
    bounds: null,
    opacity: 1,
    scale: 1, // 当前缩放倍数（相对初始贴图尺寸）
    baseW: 0, // 初始窗口宽（CSS px）
    baseH: 0, // 初始窗口高
    selectMode: false, // 选字模式：点击文字块复制文字
    ocrLines: null, // OCR 行级坐标缓存（切换模式复用，不重复识别）
    ocrBusy: false, // 识别中，防连点重复请求
    kind: 'image', // image | text | color | file
    text: '',
    color: '',
    file: '',
    locked: false, // 锁定：禁止拖动/缩放/调透明度
    onTop: true, // 置顶
    passthrough: false, // 鼠标穿透
    thumbScale: null, // 缩略图模式前的缩放（R 恢复用）
    title: '',
    annotationMode: false,
    annotationTool: 'pen',
  };

  // ---- 轻提示 ----
  var toastTimer = null;
  function toast(msg, kind) {
    if (!toastEl) return;
    toastEl.textContent = msg;
    toastEl.className = 'pin-toast show' + (kind ? ' ' + kind : '');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      toastEl.className = 'pin-toast';
    }, 1600);
  }

  // ---- 内置快捷键（设置页可自定义）----
  var PKEYS = { lock: 'l', top: 't', select: 's', pass: 'p', thumb: 'r' };
  var PKEY_CONFIG = { lock: 'pinLock', top: 'pinTop', select: 'pinSelect', pass: 'pinPass', thumb: 'pinThumb' };
  function pinKeyMatches(e, want) {
    if (!want) return false;
    return String(e.key || '').toLowerCase() === String(want).toLowerCase();
  }

  // ---- 安全调用 kkapi（防止某接口缺失导致整页报错）----
  function api() {
    return window.kkapi || null;
  }

  function currentWindowState() {
    return {
      opacity: state.opacity,
      locked: state.locked,
      onTop: state.onTop,
      title: state.title,
    };
  }

  function notifyPinState(update) {
    if (!annotationApi) return;
    var merged = annotationApi.mergePinWindowState(currentWindowState(), update);
    state.opacity = merged.opacity;
    state.locked = merged.locked;
    state.onTop = merged.onTop;
    state.title = merged.title;
    // 新版预加载使用 window.kunkun；兼容旧版 window.kkapi。
    var bridge = (window.kunkun && typeof window.kunkun.pinUpdateState === 'function')
      ? window.kunkun
      : api();
    if (!bridge || typeof bridge.pinUpdateState !== 'function') return;
    try {
      Promise.resolve(bridge.pinUpdateState(merged)).catch(function () {});
    } catch (_) {}
  }

  function applyWindowState(input) {
    if (!annotationApi) return;
    var restored = annotationApi.normalizePinWindowState(input);
    state.opacity = restored.opacity;
    state.locked = restored.locked;
    state.onTop = restored.onTop;
    state.title = restored.title;
    wrapEl.style.opacity = String(restored.opacity);
    document.body.classList.toggle('locked', restored.locked);
    document.body.classList.toggle('not-on-top', !restored.onTop);
    var bar = document.getElementById('pinTitle');
    if (bar) {
      bar.textContent = restored.title;
      bar.hidden = !restored.title;
    }
  }

  function createContentUpdater(sourceDataURL, initialRevision) {
    if (!contentApi || !annotationApi) return null;
    var nextUpdater = contentApi.createOrderedPinContentUpdater({
      sourceDataURL: sourceDataURL,
      initialRevision: Number.isSafeInteger(initialRevision) ? initialRevision : 0,
      compose: function (source, commands) {
        // composeAnnotatedDataURL 在图片异步解码后才 render，不能直接传可变的当前文档。
        // 有序更新器已深拷贝 commands，这里用独立文档完成对应 revision 的合成。
        var snapshotDocument = new annotationApi.AnnotationDocument();
        snapshotDocument.commands = Array.isArray(commands) ? commands : [];
        return annotationApi.composeAnnotatedDataURL(source, snapshotDocument);
      },
      publish: function (payload) {
        if (contentUpdater !== nextUpdater) {
          return Promise.reject(new Error('贴图内容已切换。'));
        }
        var bridge = api();
        if (!bridge || typeof bridge.pinUpdateContent !== 'function') {
          return Promise.reject(new Error('当前版本不支持贴图内容同步。'));
        }
        return Promise.resolve(bridge.pinUpdateContent(payload));
      },
    });
    return nextUpdater;
  }

  function queueContentUpdate(includeActive) {
    ocrRequestToken += 1;
    state.ocrLines = null;
    state.ocrBusy = false;
    if (!contentUpdater || !annotationDoc) return Promise.resolve(state.dataURL);
    return contentUpdater.update(annotationDoc.snapshot(includeActive === true))
      .then(function (dataURL) {
        state.dataURL = dataURL;
        return dataURL;
      })
      .catch(function (error) {
        toast('标注内容同步失败：' + ((error && error.message) || error), 'err');
        throw error;
      });
  }

  function getCurrentDataURL() {
    if (contentUpdater) {
      return contentUpdater.flush().then(function (dataURL) {
        state.dataURL = dataURL;
        return dataURL;
      });
    }
    if (!annotationApi || !annotationDoc || annotationDoc.isEmpty()) {
      return Promise.resolve(state.dataURL);
    }
    return annotationApi.composeAnnotatedDataURL(state.sourceDataURL || state.dataURL, annotationDoc);
  }

  // 保留单一导出入口名：复制、保存与其他内容消费者都等待同一条有序队列。
  function getComposedDataURL() {
    return getCurrentDataURL();
  }

  function isCloseBarrierActive() {
    return closeBarrierMode !== '';
  }

  function activateCloseBarrier(mode) {
    var activeWasCommitted = false;
    if (!closeBarrierMode) {
      closeBarrierMode = mode;
      document.body.classList.add('pin-close-pending');
      // pointer 事件和 IPC 命令在同一个 renderer 事件循环中串行执行。
      // 先提交眼前这一笔，再开启异步合成；后续标注入口全部由屏障拒绝。
      activeWasCommitted = finishActiveAnnotationForClose();
    } else if (mode === 'application') {
      // 应用退出拥有更强的屏障：普通关闭的异步任务完成后也不能自行关窗，
      // 必须先让主进程收到最终内容 ACK。
      closeBarrierMode = 'application';
    }
    return activeWasCommitted;
  }

  function releaseCloseBarrier(mode) {
    if (closeBarrierMode !== mode) return;
    closeBarrierMode = '';
    document.body.classList.remove('pin-close-pending');
  }

  function publishOrdinaryCloseContent(activeWasCommitted) {
    // 已提交的 active 笔画从未入过更新队列，必须新增一次最终 revision；
    // 没有 active 笔画时 flush 既可覆盖所有已入队更新，也避免无意义 revision。
    if (activeWasCommitted && contentUpdater && annotationDoc) return queueContentUpdate(false);
    return getCurrentDataURL();
  }

  function publishApplicationCloseContent() {
    // 应用退出总是排入一个冻结后的最终快照。这样首次发布失败后，主进程的
    // “重试”请求也能重新合成，而不是永远停在一个已 reject 的 flush tail。
    if (contentUpdater && annotationDoc) return queueContentUpdate(false);
    return getCurrentDataURL();
  }

  // ====== 五个核心动作 ======
  function doCopy() {
    var k = api();
    if (!k) return;
    if (state.kind === 'text') {
      Promise.resolve(k.copyText(state.text))
        .then(function () { toast('已复制文字', 'ok'); })
        .catch(function () { toast('复制失败', 'err'); });
      return;
    }
    if (state.kind === 'color') {
      Promise.resolve(k.copyText(state.color))
        .then(function () { toast('已复制颜色 ' + state.color, 'ok'); })
        .catch(function () { toast('复制失败', 'err'); });
      return;
    }
    if (state.kind === 'file') {
      Promise.resolve(k.copyText(state.file))
        .then(function () { toast('已复制文件路径', 'ok'); })
        .catch(function () { toast('复制失败', 'err'); });
      return;
    }
    if (!state.dataURL) return;
    getComposedDataURL()
      .then(function (dataURL) { return k.copyImage(dataURL); })
      .then(function () {
        toast('已复制图片', 'ok');
      })
      .catch(function () {
        toast('复制失败', 'err');
      });
  }

  function doSave() {
    var k = api();
    if (!k || !state.dataURL) return;
    getComposedDataURL()
      .then(function (dataURL) { return k.saveImage(dataURL); })
      .then(function (res) {
        if (res && res.saved) {
          toast('已保存', 'ok');
        } else {
          // 用户取消保存对话框等情况
          toast('未保存');
        }
      })
      .catch(function () {
        toast('保存失败', 'err');
      });
  }

  function doOcr() {
    var k = api();
    if (!k || !state.dataURL) return;
    // 打开 AI 面板进行 OCR
    getCurrentDataURL()
      .then(function (dataURL) { return k.openAIPanel({ mode: 'ocr', dataURL: dataURL }); })
      .catch(function (error) { toast('OCR 启动失败：' + ((error && error.message) || error), 'err'); });
  }

  function doAsk() {
    var k = api();
    if (!k || !state.dataURL) return;
    // 打开 AI 面板进行问图
    getCurrentDataURL()
      .then(function (dataURL) { return k.openAIPanel({ mode: 'ask', dataURL: dataURL }); })
      .catch(function (error) { toast('问图启动失败：' + ((error && error.message) || error), 'err'); });
  }

  function confirmDiscardClose(error) {
    var detail = String((error && error.message) || error || '未知错误').slice(0, 500);
    return window.confirm(
      '贴图内容同步失败，放弃未同步内容并关闭吗？\n\n' +
      detail + '\n\n确定：放弃并关闭\n取消：保留贴图，稍后重试'
    );
  }

  function doClose(options) {
    options = options && typeof options === 'object' ? options : {};
    var interactive = options.interactive !== false;
    var k = api();
    function closeNow() {
      if (k && typeof k.closeSelf === 'function') k.closeSelf();
      else window.close();
    }
    if (closeBarrierMode === 'application') return Promise.resolve(false);
    if (closeAttempt) return closeAttempt;

    var activeWasCommitted = activateCloseBarrier('ordinary');
    var attempt = Promise.resolve()
      .then(function () { return publishOrdinaryCloseContent(activeWasCommitted); })
      .then(function () {
        // prepare-close 可能在普通关闭等待 IPC 时到达。此时由应用退出
        // 协议接管，不能在回执前提前销毁 renderer。
        if (closeBarrierMode !== 'ordinary') return false;
        closeNow();
        return true;
      }, function (error) {
        toast('关闭失败：贴图内容尚未同步', 'err');
        if (closeBarrierMode !== 'ordinary') return false;
        var discard = false;
        if (interactive) {
          try { discard = confirmDiscardClose(error); } catch (_) { discard = false; }
        }
        // confirm 同 prompt 一样可能运行原生嵌套事件循环。若确认框打开期间
        // 收到 prepare-close，应用退出协议已经接管，不能再抢先销毁窗口。
        if (closeBarrierMode !== 'ordinary') return false;
        if (discard) {
          closeNow();
          return true;
        }
        // 批量关闭不在多个窗口同时弹确认框；失败的窗口留下并
        // 恢复可编辑，用户可再次点关闭进行重试或明确放弃。
        releaseCloseBarrier('ordinary');
        return false;
      });
    closeAttempt = attempt;
    attempt.then(function () {
      if (closeAttempt === attempt) closeAttempt = null;
    }, function () {
      if (closeAttempt === attempt) closeAttempt = null;
    });
    return attempt;
  }

  function prepareApplicationClose(requestId) {
    var k = api();
    if (!k || typeof k.pinCloseReady !== 'function') return;
    function sendCloseReady(payload) {
      try {
        // 重试时旧 requestId 可能已被主进程替换。这只是过期 ACK，
        // 不应在 renderer 里形成未处理的 Promise rejection。
        return Promise.resolve(k.pinCloseReady(payload)).catch(function () {});
      } catch (_) {
        return Promise.resolve();
      }
    }
    activateCloseBarrier('application');
    var closeEpoch = applicationCloseEpoch;
    if (!applicationClosePreparation) {
      var preparation = Promise.resolve().then(publishApplicationCloseContent);
      applicationClosePreparation = preparation;
      // 发布失败后保持屏障，但允许主进程的下一个 prepare-close
      // 请求真正重试最终快照。
      preparation.catch(function () {
        if (applicationClosePreparation === preparation) applicationClosePreparation = null;
      });
    }
    var pending = applicationClosePreparation;
    Promise.resolve(pending)
      .then(function () {
        if (closeBarrierMode !== 'application' || closeEpoch !== applicationCloseEpoch) return;
        return sendCloseReady({ requestId: requestId, ok: true });
      }, function (error) {
        if (closeBarrierMode !== 'application' || closeEpoch !== applicationCloseEpoch) return;
        return sendCloseReady({
          requestId: requestId,
          ok: false,
          error: String((error && error.message) || error || '未知错误').slice(0, 1000),
        });
      });
  }

  function cancelApplicationClose() {
    if (closeBarrierMode !== 'application') return;
    applicationCloseEpoch += 1;
    applicationClosePreparation = null;
    releaseCloseBarrier('application');
  }

  // ====== 贴图内选字（PixPin 式：OCR 行级坐标 → 悬停高亮 → 点击复制）======
  var ocrTexts = []; // 与 pin-ocr-layer 内 span 的 data-idx 一一对应

  function clampPct(v) {
    v = Number(v);
    if (isNaN(v)) return 0;
    return v < 0 ? 0 : v > 100 ? 100 : v;
  }

  function buildOcrSpans(lines) {
    var layer = document.getElementById('pinOcrLayer');
    if (!layer) return;
    layer.innerHTML = '';
    ocrTexts = [];
    (lines || []).forEach(function (ln) {
      if (!ln || typeof ln.t !== 'string' || !ln.t.trim()) return;
      var x = clampPct(ln.x);
      var y = clampPct(ln.y);
      var w = clampPct(ln.w);
      var h = clampPct(ln.h);
      if (w < 0.5 || h < 0.5) return; // 忽略过小的噪声框
      var s = document.createElement('span');
      s.className = 'pin-ocr-span';
      s.style.left = x + '%';
      s.style.top = y + '%';
      s.style.width = w + '%';
      s.style.height = h + '%';
      s.setAttribute('data-idx', String(ocrTexts.length));
      s.title = ln.t.trim(); // 悬停原生提示，方便长文本预览
      layer.appendChild(s);
      ocrTexts.push(ln.t.trim());
    });
  }

  function exitTextSelect() {
    state.selectMode = false;
    document.body.classList.remove('ocr-mode');
    var layer = document.getElementById('pinOcrLayer');
    if (layer) layer.hidden = true;
    var btn = document.getElementById('btnText');
    if (btn) btn.classList.remove('active');
  }

  function togglePassthrough() {
    state.passthrough = !state.passthrough;
    document.body.classList.toggle('passthrough', state.passthrough);
    var k = api();
    if (k && typeof k.setPinState === 'function') {
      Promise.resolve(k.setPinState({ ignoreMouse: state.passthrough })).catch(function () {});
    }
    toast(state.passthrough ? '已穿透：点下面窗口 · 按 Cmd+Alt+P 恢复' : '已恢复', '');
  }
  function toggleThumb() {
    // 缩略图模式（简化版）：R 缩到 35%，再按 R 还原原缩放
    if (state.thumbScale == null) {
      state.thumbScale = state.scale;
      setScale(0.35);
      toast('缩略图模式 · 按 R 还原', 'ok');
    } else {
      const back = state.thumbScale;
      state.thumbScale = null;
      setScale(back);
      toast('已还原大小', 'ok');
    }
  }
  function promptTitle() {
    const input = document.getElementById('pinTitleInput');
    if (!input) return;
    input.hidden = false;
    input.value = state.title || '';
    input.focus();
  }
  function commitTitle() {
    const input = document.getElementById('pinTitleInput');
    const bar = document.getElementById('pinTitle');
    if (!input || !bar) return;
    const v = input.value.trim();
    input.hidden = true;
    state.title = v.slice(0, 120);
    bar.textContent = state.title;
    bar.hidden = !state.title;
    notifyPinState({ title: state.title });
  }
  function toggleLock() {
    state.locked = !state.locked;
    document.body.classList.toggle('locked', state.locked);
    notifyPinState({ locked: state.locked });
    toast(state.locked ? '已锁定（L 解锁）' : '已解锁', state.locked ? '' : 'ok');
  }
  function toggleOnTop() {
    state.onTop = !state.onTop;
    document.body.classList.toggle('not-on-top', !state.onTop);
    var k = api();
    if (k && typeof k.setPinState === 'function') {
      Promise.resolve(k.setPinState({ onTop: state.onTop })).catch(function () {});
    }
    notifyPinState({ onTop: state.onTop });
    toast(state.onTop ? '已置顶' : '已取消置顶');
  }
  function toggleTextSelect() {
    if (state.selectMode) {
      exitTextSelect();
      return;
    }
    if (state.annotationMode) setAnnotationMode(false);
    var k = api();
    if (!k || typeof k.ocrBoxes !== 'function') {
      toast('当前版本不支持贴图选字', 'err');
      return;
    }
    if (!state.dataURL) {
      toast('图片尚未就绪，稍后再试', 'err');
      return;
    }
    state.selectMode = true;
    document.body.classList.add('ocr-mode');
    var layer = document.getElementById('pinOcrLayer');
    if (layer) layer.hidden = false;
    var btn = document.getElementById('btnText');
    if (btn) btn.classList.add('active');

    if (state.ocrLines) {
      // 已有缓存：直接重建文字块
      buildOcrSpans(state.ocrLines);
      toast(state.ocrLines.length ? '点击文字即可复制 · S 退出' : '未识别到文字', state.ocrLines.length ? 'ok' : 'err');
      return;
    }
    if (state.ocrBusy) return;
    state.ocrBusy = true;
    var requestToken = ++ocrRequestToken;
    toast('正在识别文字…');
    getCurrentDataURL()
      .then(function (dataURL) { return k.ocrBoxes({ dataURL: dataURL }); })
      .then(function (res) {
        if (requestToken !== ocrRequestToken) return;
        state.ocrBusy = false;
        var lines = res && Array.isArray(res.lines) ? res.lines : [];
        state.ocrLines = lines;
        buildOcrSpans(lines);
        toast(lines.length ? '点击文字即可复制 · S 退出' : '未识别到文字', lines.length ? 'ok' : 'err');
      })
      .catch(function (err) {
        if (requestToken !== ocrRequestToken) return;
        state.ocrBusy = false;
        toast('识别失败：' + ((err && err.message) || err), 'err');
      });
  }

  function bindPinCmd() {
    var k = api();
    if (k && typeof k.onPinCmd === 'function') {
      k.onPinCmd(function (msg) {
        if (!msg) return;
        if (msg.cmd === 'passthrough-off') {
          state.passthrough = false;
          document.body.classList.remove('passthrough');
          toast('已退出穿透', 'ok');
        } else if (msg.cmd === 'thumb') {
          if (msg.on && state.thumbScale == null) {
            state.thumbScale = state.scale;
            setScale(0.35);
          } else if (!msg.on && state.thumbScale != null) {
            const back = state.thumbScale;
            state.thumbScale = null;
            setScale(back);
          }
        } else if (msg.cmd === 'save') {
          doSave();
        } else if (msg.cmd === 'close') {
          doClose({ interactive: false });
        } else if (msg.cmd === 'prepare-close') {
          prepareApplicationClose(msg.requestId);
        } else if (msg.cmd === 'cancel-prepare-close') {
          cancelApplicationClose();
        }
      });
    }
  }
  function bindFileClick() {
    var f = document.getElementById('pinFile');
    if (!f) return;
    f.addEventListener('click', function () {
      if (state.kind !== 'file' || !state.file) return;
      var k = api();
      if (k && typeof k.openPath === 'function') {
        Promise.resolve(k.openPath(state.file)).catch(function () { toast('打开失败', 'err'); });
      }
    });
  }
  function bindOcrLayer() {
    var layer = document.getElementById('pinOcrLayer');
    if (!layer) return;
    layer.addEventListener('click', function (e) {
      if (!state.selectMode) return;
      var s = e.target && e.target.closest ? e.target.closest('.pin-ocr-span') : null;
      if (!s) return;
      var idx = Number(s.getAttribute('data-idx'));
      var text = ocrTexts[idx];
      if (!text) return;
      var k = api();
      if (k && typeof k.copyText === 'function') {
        Promise.resolve(k.copyText(text))
          .then(function () {
            toast('已复制：' + (text.length > 18 ? text.slice(0, 18) + '…' : text), 'ok');
          })
          .catch(function () {
            toast('复制失败', 'err');
          });
      }
      e.preventDefault();
      e.stopPropagation();
    });
  }

  // ====== 贴图标注（命令模型 + 独立透明画布）======
  function annotationStyle(tool) {
    var rect = annotationCanvas ? annotationCanvas.getBoundingClientRect() : null;
    var unit = rect ? Math.max(1, Math.min(rect.width, rect.height)) : 400;
    return {
      color: annotationColor ? annotationColor.value : '#ff3b30',
      width: (tool === 'eraser' ? 18 : 4) / unit,
      fontSize: 22 / unit,
    };
  }

  function annotationPoint(e) {
    var rect = annotationCanvas.getBoundingClientRect();
    return {
      x: rect.width ? (e.clientX - rect.left) / rect.width : 0,
      y: rect.height ? (e.clientY - rect.top) / rect.height : 0,
    };
  }

  function redrawAnnotations() {
    if (!annotationCanvas || !annotationDoc) return;
    var ctx = annotationCanvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, annotationCanvas.width, annotationCanvas.height);
    annotationDoc.render(ctx, annotationCanvas.width, annotationCanvas.height, true);
  }

  function syncAnnotationCanvas() {
    if (!annotationCanvas || annotationCanvas.hidden) return;
    var rect = annotationCanvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    var ratio = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    var width = Math.max(1, Math.round(rect.width * ratio));
    var height = Math.max(1, Math.round(rect.height * ratio));
    if (annotationCanvas.width !== width || annotationCanvas.height !== height) {
      annotationCanvas.width = width;
      annotationCanvas.height = height;
    }
    redrawAnnotations();
  }

  function updateAnnotationToolUI() {
    if (!annotationToolbar) return;
    annotationToolbar.querySelectorAll('[data-pin-tool]').forEach(function (button) {
      button.classList.toggle('active', button.getAttribute('data-pin-tool') === state.annotationTool);
    });
    if (annotationCanvas) {
      annotationCanvas.style.cursor = state.annotationTool === 'text' ? 'text' : 'crosshair';
    }
  }

  function setAnnotationMode(enabled) {
    if (isCloseBarrierActive()) return;
    if (!annotationDoc || !annotationCanvas || state.kind !== 'image') {
      if (enabled) toast('只有图片贴图可以标注', 'err');
      return;
    }
    state.annotationMode = Boolean(enabled);
    if (state.annotationMode && state.selectMode) exitTextSelect();
    document.body.classList.toggle('annotation-mode', state.annotationMode);
    annotationCanvas.hidden = !state.annotationMode && annotationDoc.isEmpty();
    annotationToolbar.hidden = !state.annotationMode;
    var button = document.getElementById('btnAnnotate');
    if (button) button.classList.toggle('active', state.annotationMode);
    if (state.annotationMode) {
      syncAnnotationCanvas();
      updateAnnotationToolUI();
      toast('标注模式 · Esc 退出', 'ok');
    } else {
      annotationDoc.cancel();
      redrawAnnotations();
    }
  }

  function toggleAnnotation() {
    setAnnotationMode(!state.annotationMode);
  }

  function editAnnotations(action) {
    if (isCloseBarrierActive()) return;
    if (!annotationDoc) return;
    var changed = false;
    if (action === 'undo') changed = annotationDoc.undo();
    else if (action === 'redo') changed = annotationDoc.redo();
    else if (action === 'clear') changed = annotationDoc.clear();
    if (!changed) return;
    annotationCanvas.hidden = !state.annotationMode && annotationDoc.isEmpty();
    redrawAnnotations();
    queueContentUpdate().catch(function () {});
  }

  function bindAnnotations() {
    if (!annotationDoc || !annotationCanvas || !annotationToolbar) return;
    var activePointer = null;

    finishActiveAnnotationForClose = function () {
      var pointerId = activePointer;
      activePointer = null;
      if (
        pointerId != null &&
        annotationCanvas.releasePointerCapture &&
        annotationCanvas.hasPointerCapture &&
        annotationCanvas.hasPointerCapture(pointerId)
      ) {
        annotationCanvas.releasePointerCapture(pointerId);
      }
      if (!annotationDoc || typeof annotationDoc.commitActive !== 'function') return false;
      var changed = annotationDoc.commitActive();
      redrawAnnotations();
      return changed;
    };

    annotationToolbar.addEventListener('click', function (e) {
      if (isCloseBarrierActive()) return;
      var toolButton = e.target.closest ? e.target.closest('[data-pin-tool]') : null;
      var editButton = e.target.closest ? e.target.closest('[data-pin-edit]') : null;
      if (toolButton) {
        state.annotationTool = toolButton.getAttribute('data-pin-tool');
        updateAnnotationToolUI();
      } else if (editButton) {
        editAnnotations(editButton.getAttribute('data-pin-edit'));
      }
      e.stopPropagation();
    });

    annotationCanvas.addEventListener('pointerdown', function (e) {
      if (isCloseBarrierActive()) return;
      if (!state.annotationMode || e.button !== 0) return;
      var point = annotationPoint(e);
      if (state.annotationTool === 'text') {
        var text = window.prompt('输入标注文字');
        // 原生 prompt 可能运行嵌套事件循环；若期间收到 prepare-close，
        // 返回后不得再把文本追加到已冻结的文档。
        if (isCloseBarrierActive()) return;
        if (annotationDoc.addText(point, text || '', annotationStyle('text'))) {
          redrawAnnotations();
          queueContentUpdate().catch(function () {});
        }
        return;
      }
      if (!annotationDoc.begin(state.annotationTool, point, annotationStyle(state.annotationTool))) return;
      activePointer = e.pointerId;
      if (annotationCanvas.setPointerCapture) annotationCanvas.setPointerCapture(e.pointerId);
      redrawAnnotations();
      e.preventDefault();
    });

    annotationCanvas.addEventListener('pointermove', function (e) {
      if (isCloseBarrierActive()) return;
      if (activePointer !== e.pointerId) return;
      annotationDoc.update(annotationPoint(e));
      redrawAnnotations();
      e.preventDefault();
    });

    function finishPointer(e) {
      if (isCloseBarrierActive()) return;
      if (activePointer !== e.pointerId) return;
      var changed = annotationDoc.finish(annotationPoint(e));
      if (annotationCanvas.releasePointerCapture && annotationCanvas.hasPointerCapture && annotationCanvas.hasPointerCapture(e.pointerId)) {
        annotationCanvas.releasePointerCapture(e.pointerId);
      }
      activePointer = null;
      redrawAnnotations();
      if (changed) queueContentUpdate().catch(function () {});
      e.preventDefault();
    }
    annotationCanvas.addEventListener('pointerup', finishPointer);
    annotationCanvas.addEventListener('pointercancel', function (e) {
      if (isCloseBarrierActive()) return;
      if (activePointer !== e.pointerId) return;
      activePointer = null;
      annotationDoc.cancel();
      redrawAnnotations();
    });

    if (typeof ResizeObserver === 'function') {
      new ResizeObserver(syncAnnotationCanvas).observe(wrapEl);
    } else {
      window.addEventListener('resize', syncAnnotationCanvas);
    }
  }

  // 动作分发表（右键菜单与工具栏共用）
  var ACTIONS = {
    copy: doCopy,
    save: doSave,
    ocr: doOcr,
    ask: doAsk,
    lock: toggleLock,
    topToggle: toggleOnTop,
    passthrough: togglePassthrough,
    title: promptTitle,
    textSel: toggleTextSelect,
    annotate: toggleAnnotation,
    zoomIn: zoomIn,
    zoomOut: zoomOut,
    zoomReset: zoomReset,
    close: doClose,
  };

  // ====== 工具栏按钮绑定 ======
  function bindToolbar() {
    var map = {
      btnCopy: 'copy',
      btnSave: 'save',
      btnOcr: 'ocr',
      btnAsk: 'ask',
      btnText: 'textSel',
      btnAnnotate: 'annotate',
      btnClose: 'close',
    };
    Object.keys(map).forEach(function (id) {
      var el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        var act = ACTIONS[map[id]];
        if (act) act();
      });
    });
  }

  // ====== 悬停显示工具栏（CSS 已有 :hover，这里加 body class 兼容拖动期间）======
  function bindHover() {
    document.addEventListener('mouseenter', function () {
      document.body.classList.add('hovering');
    });
    document.addEventListener('mouseleave', function () {
      document.body.classList.remove('hovering');
      hideCtxMenu();
    });
    // 鼠标在窗口内移动也保持显示
    document.addEventListener('mousemove', function () {
      document.body.classList.add('hovering');
    });
  }

  // ====== 滚轮：捏合(ctrlKey)缩放 / 普通滚轮调透明度 ======
  // macOS 触控板双指捏合在 Chromium/Electron 中以 wheel 事件 + ctrlKey=true 上报。
  function bindWheel() {
    window.addEventListener(
      'wheel',
      function (e) {
        e.preventDefault();
        if (state.annotationMode) return;
        if (state.locked) return; // 锁定：不缩放不调透明度
        if (e.ctrlKey) {
          doPinchZoom(e);
        } else {
          adjustOpacity(e);
        }
      },
      { passive: false }
    );
  }

  function adjustOpacity(e) {
    // 向上滚增加不透明度，向下滚减少
    var step = e.deltaY > 0 ? -0.06 : 0.06;
    var next = state.opacity + step;
    if (next > 1) next = 1;
    if (next < 0.3) next = 0.3;
    state.opacity = next;
    // 改图片容器透明度（不动 body，避免连工具栏一起糊掉影响阅读）
    wrapEl.style.opacity = String(next);
    notifyPinState({ opacity: next });
    toast('透明度 ' + Math.round(next * 100) + '%');
  }

  // 统一缩放入口：next = 相对初始尺寸的目标倍数（0.2 ~ 8）。
  // 通过 IPC 让主进程以中心为锚点缩放窗口，图片随窗口等比放大。
  function setScale(next) {
    var k = api();
    if (!k || typeof k.resizeSelf !== 'function') return;
    if (!state.baseW || !state.baseH) {
      // 兜底：用当前窗口尺寸推算初始尺寸
      state.baseW = Math.round(window.innerWidth / (state.scale || 1));
      state.baseH = Math.round(window.innerHeight / (state.scale || 1));
    }
    if (next < 0.2) next = 0.2;
    if (next > 8) next = 8;
    state.scale = next; // 乐观更新，保证连续捏合手感顺滑
    var nw = Math.max(48, Math.round(state.baseW * next));
    var nh = Math.max(48, Math.round(state.baseH * next));
    var sent = next;
    Promise.resolve(k.resizeSelf(nw, nh)).then(function (applied) {
      // 主进程会把尺寸 clamp 到 [48,8000]px。若被 clamp，按实际应用尺寸回算真实缩放，
      // 避免 state.scale 与窗口脱钩导致「放大到顶后再缩小要点好几下才有反应」的迟滞。
      // 仅在期间没有更新的缩放（state.scale 仍等于本次发送值）时回正，避免覆盖用户的新捏合。
      if (applied && applied.width && state.baseW && state.scale === sent) {
        state.scale = applied.width / state.baseW;
      }
    }).catch(function () {});
    toast('缩放 ' + Math.round(next * 100) + '%');
  }
  // 触控板双指捏合（wheel + ctrlKey）
  function doPinchZoom(e) {
    setScale(state.scale * (1 - e.deltaY / 100));
  }
  function zoomIn() { setScale(state.scale * 1.2); }
  function zoomOut() { setScale(state.scale / 1.2); }
  function zoomReset() { setScale(1); }

  // ====== JS 拖动移窗（替代 -webkit-app-region:drag，避免吞掉滚轮/捏合）======
  function bindDrag() {
    var dragging = false;
    var lastX = 0;
    var lastY = 0;
    var dragOutArmed = false; // Ctrl+拖拽 = 把内容拖出窗口（拖到其它应用）
    var dragOutFired = false;
    var downX = 0;
    var downY = 0;
    wrapEl.addEventListener('mousedown', function (e) {
      if (e.button !== 0) return; // 仅左键
      // 锁定 / 选字模式下点击不触发窗口拖动
      if (state.locked || state.selectMode || state.annotationMode) return;
      // Ctrl+左键：准备拖出内容
      if (e.ctrlKey || e.metaKey) {
        dragOutArmed = true;
        dragOutFired = false;
        downX = e.screenX;
        downY = e.screenY;
        return;
      }
      // 工具栏 / 右键菜单上的点击不触发拖动
      if ((toolbarEl && toolbarEl.contains(e.target)) || (ctxMenu && ctxMenu.contains(e.target))) return;
      dragging = true;
      lastX = e.screenX;
      lastY = e.screenY;
      e.preventDefault();
    });
    window.addEventListener('mousemove', function (e) {
      if (dragOutArmed) {
        var odx = e.screenX - downX;
        var ody = e.screenY - downY;
        if (odx * odx + ody * ody > 64 && !dragOutFired) {
          dragOutFired = true;
          var k2 = api();
          if (k2 && typeof k2.pinStartDrag === 'function') {
            getCurrentDataURL()
              .then(function () { return k2.pinStartDrag(); })
              .then(function (result) {
                if (result && result.ok === false) throw new Error(result.error || '无法拖出贴图。');
              })
              .catch(function (error) {
                toast('拖出失败：' + ((error && error.message) || error), 'err');
              });
          }
          toast('正在准备已合成的贴图…');
        }
        return;
      }
      if (!dragging) return;
      var dx = e.screenX - lastX;
      var dy = e.screenY - lastY;
      if (dx === 0 && dy === 0) return;
      lastX = e.screenX;
      lastY = e.screenY;
      var k = api();
      if (k && typeof k.moveSelf === 'function') k.moveSelf(dx, dy);
    });
    window.addEventListener('mouseup', function () {
      dragging = false;
      dragOutArmed = false;
      dragOutFired = false;
    });
  }

  // ====== 双击 / Esc 关闭 ======
  function bindCloseGestures() {
    // 双击图片区关闭（选字模式下双击文字块不关闭窗口）
    wrapEl.addEventListener('dblclick', function (e) {
      if (state.selectMode || state.annotationMode) {
        e.preventDefault();
        return;
      }
      e.preventDefault();
      doClose();
    });
    // 键盘：Esc 关闭（选字模式先退出选字），T 切换选字，+/- 缩放，0 还原
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        // 标题输入框开着时先关它
        var ti0 = document.getElementById('pinTitleInput');
        if (ti0 && !ti0.hidden) {
          ti0.hidden = true;
          return;
        }
        // 若右键菜单开着，先关菜单
        if (ctxMenu.classList.contains('show')) {
          e.preventDefault();
          hideCtxMenu(true);
          return;
        }
        if (state.annotationMode) {
          setAnnotationMode(false);
          return;
        }
        if (state.selectMode) {
          exitTextSelect();
          return;
        }
        doClose();
        return;
      }
      if (state.annotationMode && (e.metaKey || e.ctrlKey) && String(e.key).toLowerCase() === 'z') {
        e.preventDefault();
        editAnnotations(e.shiftKey ? 'redo' : 'undo');
        return;
      }
      if (pinKeyMatches(e, PKEYS.lock)) {
        e.preventDefault();
        toggleLock();
        return;
      }
      if (pinKeyMatches(e, PKEYS.top)) {
        e.preventDefault();
        toggleOnTop();
        return;
      }
      if (pinKeyMatches(e, PKEYS.select)) {
        e.preventDefault();
        toggleTextSelect();
        return;
      }
      if (pinKeyMatches(e, PKEYS.pass)) {
        e.preventDefault();
        togglePassthrough();
        return;
      }
      if (pinKeyMatches(e, PKEYS.thumb)) {
        e.preventDefault();
        toggleThumb();
        return;
      }
      if (e.key === 'F2') {
        e.preventDefault();
        promptTitle();
        return;
      }
      if (e.key === 'Enter') {
        var ti = document.getElementById('pinTitleInput');
        if (ti && !ti.hidden) {
          e.preventDefault();
          commitTitle();
          return;
        }
      }
      if (e.key === '+' || e.key === '=') {
        e.preventDefault();
        zoomIn();
      } else if (e.key === '-' || e.key === '_') {
        e.preventDefault();
        zoomOut();
      } else if (e.key === '0') {
        e.preventDefault();
        zoomReset();
      }
    });
  }

  // ====== 自绘右键菜单 ======
  function focusCtxItem(index) {
    if (!ctxMenuItems.length) return;
    var itemCount = ctxMenuItems.length;
    var nextIndex = ((index % itemCount) + itemCount) % itemCount;
    ctxMenuItems.forEach(function (item, itemIndex) {
      item.setAttribute('tabindex', itemIndex === nextIndex ? '0' : '-1');
    });
    ctxMenuItems[nextIndex].focus();
  }

  function showCtxMenu(x, y) {
    if (!ctxMenu.classList.contains('show')) {
      ctxMenuReturnFocus = document.activeElement;
    }
    ctxMenu.classList.add('show');
    ctxMenu.setAttribute('aria-hidden', 'false');
    // 先显示再测量，避免越界出窗
    var mw = ctxMenu.offsetWidth;
    var mh = ctxMenu.offsetHeight;
    var vw = window.innerWidth;
    var vh = window.innerHeight;
    var px = x;
    var py = y;
    if (px + mw > vw) px = Math.max(0, vw - mw - 2);
    if (py + mh > vh) py = Math.max(0, vh - mh - 2);
    ctxMenu.style.left = px + 'px';
    ctxMenu.style.top = py + 'px';
    focusCtxItem(0);
  }

  function hideCtxMenu(restoreFocus) {
    var returnFocus = ctxMenuReturnFocus;
    ctxMenu.classList.remove('show');
    ctxMenu.setAttribute('aria-hidden', 'true');
    ctxMenuItems.forEach(function (item) {
      item.setAttribute('tabindex', '-1');
    });
    ctxMenuReturnFocus = null;
    if (
      restoreFocus === true &&
      returnFocus &&
      returnFocus.isConnected &&
      typeof returnFocus.focus === 'function'
    ) {
      returnFocus.focus();
    }
  }

  function bindContextMenu() {
    document.addEventListener('contextmenu', function (e) {
      e.preventDefault();
      showCtxMenu(e.clientX, e.clientY);
    });
    // 点击菜单项执行动作
    ctxMenu.addEventListener('click', function (e) {
      var item = e.target.closest ? e.target.closest('.ctx-item') : null;
      if (!item) return;
      var act = ACTIONS[item.getAttribute('data-act')];
      hideCtxMenu(true);
      if (act) act();
    });
    ctxMenu.addEventListener('keydown', function (e) {
      if (!ctxMenu.classList.contains('show')) return;
      var index = ctxMenuItems.indexOf(document.activeElement);
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        e.stopPropagation();
        focusCtxItem(index + 1);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        e.stopPropagation();
        focusCtxItem(index - 1);
      } else if (e.key === 'Home') {
        e.preventDefault();
        e.stopPropagation();
        focusCtxItem(0);
      } else if (e.key === 'End') {
        e.preventDefault();
        e.stopPropagation();
        focusCtxItem(ctxMenuItems.length - 1);
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        e.stopPropagation();
        if (index >= 0) ctxMenuItems[index].click();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        hideCtxMenu(true);
      } else if (e.key === 'Tab') {
        hideCtxMenu();
      }
    });
    // 点击空白处关闭菜单（用 mousedown 抢在拖动前）
    document.addEventListener('mousedown', function (e) {
      if (ctxMenu.classList.contains('show') && !ctxMenu.contains(e.target)) {
        hideCtxMenu();
      }
    });
    // 失焦关闭
    window.addEventListener('blur', hideCtxMenu);
  }

  // ====== 接收初始化 payload ======
  function applyInit(payload) {
    if (!payload) return;
    if (payload.state) applyWindowState(payload.state);
    if (payload.text) {
      state.kind = 'text';
      state.text = payload.text;
      const t = document.getElementById('pinText');
      if (t) {
        t.textContent = payload.text;
        t.hidden = false;
      }
      imgEl.hidden = true;
    }
    if (payload.color) {
      state.kind = 'color';
      state.color = payload.color;
      const c = document.getElementById('pinColor');
      if (c) {
        c.style.background = payload.color;
        c.setAttribute('data-hex', payload.color);
        c.hidden = false;
      }
      imgEl.hidden = true;
    }
    if (payload.file) {
      state.kind = 'file';
      state.file = payload.file;
      const f = document.getElementById('pinFile');
      const fn = document.getElementById('pinFileName');
      if (f && fn) {
        fn.textContent = payload.file.split('/').pop() || payload.file;
        f.hidden = false;
      }
      imgEl.hidden = true;
    }
    if (payload.dataURL) {
      if (state.sourceDataURL && state.sourceDataURL !== payload.dataURL) {
        // 换了新图：退出选字模式并清空 OCR 缓存，避免旧坐标/旧文字张冠李戴
        exitTextSelect();
        state.ocrLines = null;
        state.ocrBusy = false;
        setAnnotationMode(false);
        annotationDoc = annotationApi ? new annotationApi.AnnotationDocument() : null;
        if (annotationCanvas) annotationCanvas.hidden = true;
      }
      ocrRequestToken += 1;
      state.ocrLines = null;
      state.ocrBusy = false;
      state.sourceDataURL = payload.dataURL;
      state.dataURL = payload.dataURL;
      contentUpdater = createContentUpdater(payload.dataURL, payload.contentRevision);
      imgEl.src = payload.dataURL;
    }
    if (payload.bounds) {
      state.bounds = payload.bounds;
      // 记录初始尺寸作为捏合缩放的基准
      if (payload.bounds.width) state.baseW = Math.round(payload.bounds.width);
      if (payload.bounds.height) state.baseH = Math.round(payload.bounds.height);
      state.scale = 1;
    }
  }

  // ====== 启动 ======
  function init() {
    bindToolbar();
    bindHover();
    bindWheel();
    bindDrag();
    bindCloseGestures();
    bindContextMenu();
    bindOcrLayer();
    bindPinCmd();
    bindFileClick();
    bindAnnotations();

    var k = api();
    if (k && typeof k.getConfig === 'function') {
      Promise.resolve(k.getConfig())
        .then(function (cfg) {
          if (cfg && cfg.builtinKeys) {
            Object.keys(PKEYS).forEach(function (key) {
              var configKey = PKEY_CONFIG[key];
              if (cfg.builtinKeys[configKey]) PKEYS[key] = String(cfg.builtinKeys[configKey]);
            });
          }
        })
        .catch(function () {});
    }
    if (k && typeof k.onInit === 'function') {
      // 主进程窗口加载完成后会推送 { dataURL, bounds }
      k.onInit(function (payload) {
        applyInit(payload);
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
