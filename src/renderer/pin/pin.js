// 贴图窗逻辑：纯渲染层，禁止 require，所有与主进程交互都走 window.kkapi。
// 初始化 payload: { dataURL, bounds }。窗口尺寸由主进程按 bounds 设好，这里只负责填图与交互。

(function () {
  'use strict';

  // ---- DOM 引用 ----
  var imgEl = document.getElementById('pinImg');
  var wrapEl = document.getElementById('pinWrap');
  var toolbarEl = document.getElementById('pinToolbar');
  var ctxMenu = document.getElementById('ctxMenu');
  var toastEl = document.getElementById('pinToast');

  // 当前贴图数据
  var state = {
    dataURL: '',
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
    Promise.resolve(k.copyImage(state.dataURL))
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
    Promise.resolve(k.saveImage(state.dataURL))
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
    Promise.resolve(k.openAIPanel({ mode: 'ocr', dataURL: state.dataURL })).catch(function () {});
  }

  function doAsk() {
    var k = api();
    if (!k || !state.dataURL) return;
    // 打开 AI 面板进行问图
    Promise.resolve(k.openAIPanel({ mode: 'ask', dataURL: state.dataURL })).catch(function () {});
  }

  function doClose() {
    var k = api();
    if (k && typeof k.closeSelf === 'function') {
      k.closeSelf();
    } else {
      window.close();
    }
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
    input.value = '';
    input.focus();
  }
  function commitTitle() {
    const input = document.getElementById('pinTitleInput');
    const bar = document.getElementById('pinTitle');
    if (!input || !bar) return;
    const v = input.value.trim();
    input.hidden = true;
    if (v) {
      bar.textContent = v;
      bar.hidden = false;
    }
  }
  function toggleLock() {
    state.locked = !state.locked;
    document.body.classList.toggle('locked', state.locked);
    toast(state.locked ? '已锁定（L 解锁）' : '已解锁', state.locked ? '' : 'ok');
  }
  function toggleOnTop() {
    state.onTop = !state.onTop;
    var k = api();
    if (k && typeof k.setPinState === 'function') {
      Promise.resolve(k.setPinState({ onTop: state.onTop })).catch(function () {});
    }
    toast(state.onTop ? '已置顶' : '已取消置顶');
  }
  function toggleTextSelect() {
    if (state.selectMode) {
      exitTextSelect();
      return;
    }
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
    toast('正在识别文字…');
    Promise.resolve(k.ocrBoxes({ dataURL: state.dataURL }))
      .then(function (res) {
        state.ocrBusy = false;
        var lines = res && Array.isArray(res.lines) ? res.lines : [];
        state.ocrLines = lines;
        buildOcrSpans(lines);
        toast(lines.length ? '点击文字即可复制 · S 退出' : '未识别到文字', lines.length ? 'ok' : 'err');
      })
      .catch(function (err) {
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
      if (state.locked || state.selectMode) return;
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
            try { k2.pinStartDrag(); } catch (_) {}
          }
          toast('已开始拖出（松手即投放）');
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
      if (state.selectMode) {
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
          hideCtxMenu();
          return;
        }
        if (state.selectMode) {
          exitTextSelect();
          return;
        }
        doClose();
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
  function showCtxMenu(x, y) {
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
  }

  function hideCtxMenu() {
    ctxMenu.classList.remove('show');
    ctxMenu.setAttribute('aria-hidden', 'true');
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
      hideCtxMenu();
      if (act) act();
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
      if (state.dataURL && state.dataURL !== payload.dataURL) {
        // 换了新图：退出选字模式并清空 OCR 缓存，避免旧坐标/旧文字张冠李戴
        exitTextSelect();
        state.ocrLines = null;
        state.ocrBusy = false;
      }
      state.dataURL = payload.dataURL;
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
