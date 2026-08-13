/* 困困截图工具 · 标注覆盖层逻辑
 * 纯渲染层，禁止 require / import；一切与主进程交互走 window.kkapi。
 *
 * 坐标系说明：
 *  - 显示器 CSS 像素：window/body 尺寸 = displayCssW × displayCssH（= payload.width × height）。
 *  - 背景截图为物理像素，分辨率 = displayCssW*scaleFactor × displayCssH*scaleFactor。
 *  - 选区 rect 用 CSS px（相对显示器左上角）。
 *  - 标注画在 annoCanvas，其内部分辨率与选区 CSS 尺寸 1:1，绘制时用 CSS px 坐标。
 *  - 提交合成时：新 canvas 物理分辨率 = rect 尺寸 × scaleFactor，从背景物理像素裁剪 + 把标注放大叠加。
 */
(function () {
  'use strict';

  // ---------- 全局状态 ----------
  var S = {
    payload: null, // onInit 数据
    scaleFactor: 1,
    displayCssW: 0,
    displayCssH: 0,
    displayBounds: { x: 0, y: 0, width: 0, height: 0 },
    displayId: null,
    mode: 'region',

    bgImage: null, // 背景 Image（物理像素）
    bgReady: false,

    // 选区（CSS px，相对显示器）
    rect: null, // {x,y,width,height} 或 null
    selecting: false, // 正在初次框选
    startPt: null, // 初次框选起点

    // 取色（PixPin 式放大镜取色）：记录鼠标位置与当前像素颜色，C 键复制
    lastMouse: { x: 0, y: 0 },
    curColor: null, // {r,g,b} 或 null
    qrData: null,
    ratioLock: 0, // 锁定宽高比(>0)；0=不锁
    rounded: false, // 圆角截图
    // 历史浏览 / 选区历史（PixPin 式 < > / R）
    histItems: null, // 历史列表缓存
    histIdx: -1, // -1=当前截图；>=0 表示正在看第几张历史
    recentRects: [], // 本会话最近 10 个选区
    rectHistIdx: -1, // 选区历史游标 // 当前选区识别出的二维码内容

    // 选区拖动 / 缩放
    dragMode: null, // null | 'move' | 'resize'
    resizeHandle: null,
    dragStart: null, // {mx,my, rect}

    // 标注
    tool: null, // null | rect|ellipse|arrow|pen|text|mosaic|number
    color: '#ef4444',
    width: 4,
    shapes: [], // 已确认的标注
    history: [], // 撤销栈：整状态快照 {shapes, numberSeq}
    redoStack: [], // 重做栈：整状态快照
    drawing: false,
    cur: null, // 正在绘制的临时图形
    numberSeq: 1, // 序号笔递增计数

    // 标注选择 / 再编辑
    selected: null, // 当前选中的标注（S.shapes 中的引用）
    shapeDrag: null, // 标注拖动/缩放状态
    editingTextShape: null, // 正在再编辑的文字标注
    _dragSnapshot: null,
    _dragMoved: false,

    finished: false, // 已提交，防止重复
  };

  // ---------- DOM ----------
  var bgCanvas = document.getElementById('bgCanvas');
  var bgCtx = bgCanvas.getContext('2d');
  var maskTop = document.getElementById('maskTop');
  var maskLeft = document.getElementById('maskLeft');
  var maskRight = document.getElementById('maskRight');
  var maskBottom = document.getElementById('maskBottom');
  var hint = document.getElementById('hint');
  var selectionEl = document.getElementById('selection');
  var annoCanvas = document.getElementById('annoCanvas');
  var annoCtx = annoCanvas.getContext('2d');
  var sizeLabel = document.getElementById('sizeLabel');
  var magnifier = document.getElementById('magnifier');
  var magCanvas = document.getElementById('magCanvas');
  var magCtx = magCanvas.getContext('2d');
  var magInfo = document.getElementById('magInfo');
  var magColor = document.getElementById('magColor');
  var qrPanel = document.getElementById('qrPanel');
  var qrText = document.getElementById('qrText');
  var btnQR = document.getElementById('btnQR');
  var btnQrCopy = document.getElementById('btnQrCopy');
  var btnQrOpen = document.getElementById('btnQrOpen');
  var btnQrClose = document.getElementById('btnQrClose');
  var btnRatioLock = document.getElementById('btnRatioLock');
  var btnRounded = document.getElementById('btnRounded');
  var toolbar = document.getElementById('toolbar');
  var textInput = document.getElementById('textInput');
  var btnUndo = document.getElementById('btnUndo');
  var btnRedo = document.getElementById('btnRedo');
  var btnDelete = document.getElementById('btnDelete');
  var trLang = document.getElementById('trLang'); // 翻译目标语言选择

  // ---------- 工具函数 ----------
  function clamp(v, a, b) {
    return v < a ? a : v > b ? b : v;
  }
  function dpr() {
    return S.scaleFactor || 1;
  }
  // CSS 坐标 → 背景物理像素坐标
  function toPhys(v) {
    return Math.round(v * dpr());
  }

  // ---------- 初始化 ----------
  var off = kkapi.onInit(function (payload) {
    if (!payload) return;
    S.payload = payload;
    S.scaleFactor = payload.scaleFactor || 1;
    S.displayCssW = payload.width || window.innerWidth;
    S.displayCssH = payload.height || window.innerHeight;
    S.displayBounds = payload.displayBounds || payload.bounds || { x: 0, y: 0, width: S.displayCssW, height: S.displayCssH };
    S.displayId = payload.displayId;
    S.mode = payload.mode || 'region';

    // 背景 canvas 用物理像素，CSS 缩放到显示器尺寸（铺满 body）
    var img = new Image();
    img.onload = function () {
      S.bgImage = img;
      bgCanvas.width = img.naturalWidth;
      bgCanvas.height = img.naturalHeight;
      // CSS 尺寸已由样式 100vw/100vh 控制
      bgCtx.drawImage(img, 0, 0);
      S.bgReady = true;
    };
    img.onerror = function () {
      // 背景加载失败也允许框选，只是没有底图
      S.bgReady = true;
    };
    img.src = payload.dataURL;

    layoutMask();
  });

  // ---------- 蒙层布局：选区外变暗，选区内透明 ----------
  function layoutMask() {
    var r = S.rect;
    if (!r || r.width < 1 || r.height < 1) {
      // 无选区：整屏盖一块蒙层（top 铺满，其余清零）
      setBox(maskTop, 0, 0, '100vw', '100vh');
      setBox(maskLeft, 0, 0, 0, 0);
      setBox(maskRight, 0, 0, 0, 0);
      setBox(maskBottom, 0, 0, 0, 0);
      return;
    }
    var W = S.displayCssW;
    var H = S.displayCssH;
    // 上
    setBox(maskTop, 0, 0, W + 'px', r.y + 'px');
    // 下
    setBox(maskBottom, 0, r.y + r.height, W + 'px', H - (r.y + r.height) + 'px');
    // 左
    setBox(maskLeft, 0, r.y, r.x + 'px', r.height + 'px');
    // 右
    setBox(maskRight, r.x + r.width, r.y, W - (r.x + r.width) + 'px', r.height + 'px');
  }
  function setBox(el, left, top, w, h) {
    el.style.left = (typeof left === 'number' ? left + 'px' : left);
    el.style.top = (typeof top === 'number' ? top + 'px' : top);
    el.style.width = (typeof w === 'number' ? w + 'px' : w);
    el.style.height = (typeof h === 'number' ? h + 'px' : h);
  }

  // ---------- 选区视图更新 ----------
  function updateSelectionView() {
    var r = S.rect;
    if (!r) {
      selectionEl.hidden = true;
      sizeLabel.hidden = true;
      return;
    }
    selectionEl.hidden = false;
    selectionEl.style.borderRadius = S.rounded ? '12px' : '0px';
    selectionEl.style.left = r.x + 'px';
    selectionEl.style.top = r.y + 'px';
    selectionEl.style.width = r.width + 'px';
    selectionEl.style.height = r.height + 'px';

    // annoCanvas 内部分辨率 = 选区 CSS 尺寸（整数）
    var w = Math.max(1, Math.round(r.width));
    var h = Math.max(1, Math.round(r.height));
    if (annoCanvas.width !== w || annoCanvas.height !== h) {
      annoCanvas.width = w;
      annoCanvas.height = h;
    }
    redrawAnno();

    // 尺寸标签（显示物理像素尺寸，更符合用户对清晰度的预期）
    sizeLabel.hidden = false;
    var pw = Math.round(r.width * dpr());
    var ph = Math.round(r.height * dpr());
    sizeLabel.textContent = pw + ' × ' + ph;
    var ly = r.y - 24;
    if (ly < 2) ly = r.y + 4;
    sizeLabel.style.left = r.x + 'px';
    sizeLabel.style.top = ly + 'px';

    layoutMask();
  }

  // ---------- 鼠标坐标 → 显示器 CSS 坐标 ----------
  function evtPt(e) {
    return { x: e.clientX, y: e.clientY };
  }
  // 鼠标坐标 → 选区内部坐标（annoCanvas 坐标系）
  function evtToAnno(e) {
    var r = S.rect;
    return { x: e.clientX - r.x, y: e.clientY - r.y };
  }

  // ================= 阶段一：初次框选 =================
  document.addEventListener('mousedown', function (e) {
    if (S.finished) return;
    // 右键必须在「S.aiOpen 关面板」之前就 return、完全交给 contextmenu 处理（它会判 S.aiOpen 只关面板、否则才取消截图）。
    // 否则右键的 mousedown 先把面板关了(S.aiOpen→false)，紧接着的 contextmenu 判 S.aiOpen 已为 false → 误取消整张截图、丢选区和标注。
    if (e.button === 2) return;
    // 内联 AI 面板打开时，点面板外的区域先关面板（面板内点击已 stopPropagation）
    if (S.aiOpen) {
      closeAIPanel();
      return;
    }
    // 点在工具栏 / 文字输入框上 → 不处理框选
    if (toolbar.contains(e.target) || e.target === textInput) return;

    // 已有选区时：判断是控制点/移动/标注
    if (S.rect) {
      // 控制点
      if (e.target.classList && e.target.classList.contains('handle')) {
        startResize(e, e.target.getAttribute('data-pos'));
        return;
      }
      // 选择工具：选中 / 移动 / 缩放 / 再编辑已有标注
      if (S.tool === 'select') {
        handleSelectDown(e);
        return;
      }
      // 选区内 + 有激活标注工具 → 画标注
      if (S.tool && isInsideSelection(e)) {
        startAnnotate(e);
        return;
      }
      // 选区内 + 无标注工具 → 整体移动
      if (isInsideSelection(e) && !S.tool) {
        startMove(e);
        return;
      }
      // 选区外点击：若无标注工具，重新开始框选
      if (!S.tool && !toolbar.contains(e.target)) {
        beginSelect(e);
        return;
      }
      return;
    }

    // 无选区：开始框选
    beginSelect(e);
  });

  function beginSelect(e) {
    // 提交未完成的文字
    commitText();
    S.selecting = true;
    S.startPt = evtPt(e);
    S.rect = { x: e.clientX, y: e.clientY, width: 0, height: 0 };
      if (typeof clearInlineTranslate === 'function') clearInlineTranslate();
    S.shapes = [];
    S.history = [];
    S.redoStack = [];
    S.numberSeq = 1;
    S.tool = null;
    S.selected = null;
    S.shapeDrag = null;
    S.editingTextShape = null;
    if (typeof updateEditButtons === 'function') updateEditButtons();
    selectionEl.classList.remove('annotating');
    toolbar.hidden = true;
    hint.hidden = true;
    S.qrData = null;
    btnQR.hidden = true;
    hideQrPanel();
    updateSelectionView();
    showMagnifier(e);
  }

  function isInsideSelection(e) {
    var r = S.rect;
    return (
      e.clientX >= r.x &&
      e.clientX <= r.x + r.width &&
      e.clientY >= r.y &&
      e.clientY <= r.y + r.height
    );
  }

  // ================= 移动整个选区 =================
  function startMove(e) {
    S.dragMode = 'move';
    // 译文层是按屏幕绝对坐标贴的，不会跟随选区移动；移动前先清除，避免译文与底图错位、且无法消除。
    if (typeof clearInlineTranslate === 'function') clearInlineTranslate();
    S.dragStart = { mx: e.clientX, my: e.clientY, rect: { x: S.rect.x, y: S.rect.y, width: S.rect.width, height: S.rect.height } };
    toolbar.hidden = true;
    e.preventDefault();
  }

  // ================= 缩放选区 =================
  function startResize(e, pos) {
    S.dragMode = 'resize';
    S.resizeHandle = pos;
    // 译文层不随选区缩放，缩放前先清除，避免错位残留。
    if (typeof clearInlineTranslate === 'function') clearInlineTranslate();
    S.dragStart = { mx: e.clientX, my: e.clientY, rect: { x: S.rect.x, y: S.rect.y, width: S.rect.width, height: S.rect.height } };
    toolbar.hidden = true;
    showMagnifier(e);
    e.preventDefault();
    e.stopPropagation();
  }

  // ================= 全局 mousemove =================
  document.addEventListener('mousemove', function (e) {
    if (S.finished) return;
    S.lastMouse = { x: e.clientX, y: e.clientY };

    if (S.selecting) {
      var sx = S.startPt.x, sy = S.startPt.y;
      var x = Math.min(sx, e.clientX);
      var y = Math.min(sy, e.clientY);
      var w = Math.abs(e.clientX - sx);
      var h = Math.abs(e.clientY - sy);
      if (e.shiftKey) {
        // Shift 固定 1:1：以较大边为准，并沿拖拽方向收缩
        var side = Math.max(w, h);
        w = side;
        h = side;
        if (e.clientX < sx) x = sx - side;
        if (e.clientY < sy) y = sy - side;
      }
      // 限制在显示器范围内
      x = clamp(x, 0, S.displayCssW);
      y = clamp(y, 0, S.displayCssH);
      w = clamp(w, 0, S.displayCssW - x);
      h = clamp(h, 0, S.displayCssH - y);
      S.rect = { x: x, y: y, width: w, height: h };
      updateSelectionView();
      showMagnifier(e);
      return;
    }

    if (S.dragMode === 'move') {
      var dx = e.clientX - S.dragStart.mx;
      var dy = e.clientY - S.dragStart.my;
      var nr = S.dragStart.rect;
      var nx = clamp(nr.x + dx, 0, S.displayCssW - nr.width);
      var ny = clamp(nr.y + dy, 0, S.displayCssH - nr.height);
      S.rect = { x: nx, y: ny, width: nr.width, height: nr.height };
      updateSelectionView();
      return;
    }

    if (S.dragMode === 'resize') {
      var ox = S.rect.x, oy = S.rect.y;
      applyResize(e);
      // 缩放若改变了选区原点(x/y)，把标注按原点位移反向平移，保持其锚定在原底图内容上，避免漂移。
      // 无条件调用：shiftShapes 内部已对 dx=dy=0 早退、对空数组安全，且它同时平移 history/redo 快照——
      // 若用 S.shapes.length 门控，撤销后(live 空但 redo 非空)缩放再重做会让标注漂移。
      shiftShapes(ox - S.rect.x, oy - S.rect.y);
      updateSelectionView();
      showMagnifier(e);
      return;
    }

    if (S.shapeDrag) {
      applyShapeDrag(e);
      return;
    }

    if (S.drawing) {
      continueAnnotate(e);
      return;
    }

    // 选择工具下：悬停时给出移动/缩放光标反馈
    if (S.tool === 'select' && S.rect) updateHoverCursor(e);

    // 取色放大镜：未激活标注工具（默认移动/选择态，tool 为 null 或 'select'）+ 已框选 + 未在拖拽/标注时，
    // 悬停常显（PixPin 式取色）。初始框选 / 拖动 / 缩放过程中的放大镜由对应分支自己调用。
    if (
      (!S.tool || S.tool === 'select') &&
      S.rect &&
      !toolbar.hidden &&
      !S.aiOpen &&
      !S.drawing &&
      !S.shapeDrag
    ) {
      showMagnifier(e);
    } else if (!S.selecting && !S.dragMode && !S.drawing && !S.shapeDrag) {
      hideMagnifier();
    }
  });

  function applyResize(e) {
    var or = S.dragStart.rect;
    var pos = S.resizeHandle;
    var left = or.x;
    var top = or.y;
    var right = or.x + or.width;
    var bottom = or.y + or.height;
    var mx = clamp(e.clientX, 0, S.displayCssW);
    var my = clamp(e.clientY, 0, S.displayCssH);

    if (pos.indexOf('w') !== -1) left = mx;
    if (pos.indexOf('e') !== -1) right = mx;
    if (pos.indexOf('n') !== -1) top = my;
    if (pos.indexOf('s') !== -1) bottom = my;

    // 处理翻转：保证 left<right, top<bottom
    var nx = Math.min(left, right);
    var ny = Math.min(top, bottom);
    var nw = Math.abs(right - left);
    var nh = Math.abs(bottom - top);
    if (S.ratioLock > 0) {
      // 锁定比例：仅左右边 → 高度跟随；仅上下边 → 宽度跟随；角点 → 取更大者
      var ratio = S.ratioLock;
      var hEdge = pos.indexOf('n') !== -1 || pos.indexOf('s') !== -1;
      var wEdge = pos.indexOf('w') !== -1 || pos.indexOf('e') !== -1;
      if (wEdge && !hEdge) {
        nh = nw / ratio;
      } else if (hEdge && !wEdge) {
        nw = nh * ratio;
      } else {
        nw = Math.max(nw, nh * ratio);
        nh = nw / ratio;
      }
      if (pos.indexOf('n') !== -1) top = bottom - nh;
      else bottom = top + nh;
      if (pos.indexOf('w') !== -1) left = right - nw;
      else right = left + nw;
      // 比例调整可能改变了左/上边，重算原点
      nx = Math.min(left, right);
      ny = Math.min(top, bottom);
    }
    S.rect = { x: nx, y: ny, width: nw, height: nh };
  }

  // ================= 全局 mouseup =================
  document.addEventListener('mouseup', function (e) {
    if (S.finished) return;

    if (S.selecting) {
      S.selecting = false;
      hideMagnifier();
      finalizeSelectionStart();
      return;
    }
    if (S.dragMode === 'move' || S.dragMode === 'resize') {
      S.dragMode = null;
      S.resizeHandle = null;
      hideMagnifier();
      // 拖动/缩放期间 startMove/startResize 把 toolbar.hidden 置 true；positionToolbar 开头有
      // `if (toolbar.hidden) return` 守卫，故必须先复位 hidden 再定位，否则工具栏拖动后永久消失。
      if (S.rect) toolbar.hidden = false;
      positionToolbar();
      scanQr();
      return;
    }
    if (S.shapeDrag) {
      endShapeDrag();
      return;
    }
    if (S.drawing) {
      endAnnotate(e);
      return;
    }
  });

  // 框选结束：若太小则取消选区；否则进入标注/工具栏阶段
  function finalizeSelectionStart() {
    if (!S.rect || S.rect.width < 3 || S.rect.height < 3) {
      S.rect = null;
      updateSelectionView();
      toolbar.hidden = true;
      hint.hidden = false;
      return;
    }
    updateSelectionView();
    showToolbar();
    scanQr();
    recordRecentRect();
  }

  // ================= 工具栏 =================
  function showToolbar() {
    // record / long 模式不需要标注与工具栏，选完直接提交
    if (S.mode === 'record') {
      finishAction('record');
      return;
    }
    if (S.mode === 'long') {
      finishAction('long');
      return;
    }
    toolbar.hidden = false;
    positionToolbar();
    applyDefaultAction();
    updateUndoRedo();
  }

  function positionToolbar() {
    if (toolbar.hidden || !S.rect) return;
    var r = S.rect;
    // 先显示以测量尺寸
    toolbar.style.visibility = 'hidden';
    toolbar.hidden = false;
    var tw = toolbar.offsetWidth;
    var th = toolbar.offsetHeight;
    var gap = 8;
    // 默认放选区下方
    var top = r.y + r.height + gap;
    if (top + th > S.displayCssH - 2) {
      // 越界 → 放上方
      top = r.y - th - gap;
      if (top < 2) {
        // 上下都放不下 → 贴选区内底部
        top = clamp(r.y + r.height - th - gap, 2, S.displayCssH - th - 2);
      }
    }
    var left = r.x + r.width - tw; // 右对齐选区右边
    left = clamp(left, 2, S.displayCssW - tw - 2);
    toolbar.style.left = left + 'px';
    toolbar.style.top = top + 'px';
    toolbar.style.visibility = 'visible';
  }

  // 根据 mode 设定默认高亮动作
  function applyDefaultAction() {
    var map = { ocr: 'ocr', ask: 'ask', region: 'copy' };
    var def = map[S.mode] || 'copy';
    var btns = toolbar.querySelectorAll('.action-btn');
    for (var i = 0; i < btns.length; i++) {
      btns[i].classList.toggle('default-action', btns[i].getAttribute('data-action') === def);
    }
    S.defaultAction = def;
  }

  // ---------- 工具栏点击 ----------
  toolbar.addEventListener('mousedown', function (e) {
    // 防止冒泡到 document 触发框选/移动
    e.stopPropagation();
  });
  toolbar.addEventListener('click', function (e) {
    var toolBtn = e.target.closest('.tool-btn[data-tool]');
    if (toolBtn) {
      selectTool(toolBtn.getAttribute('data-tool'));
      return;
    }
    var colorBtn = e.target.closest('.color-btn');
    if (colorBtn) {
      setColor(colorBtn.getAttribute('data-color'));
      return;
    }
    var widthBtn = e.target.closest('.width-btn');
    if (widthBtn) {
      setWidth(parseInt(widthBtn.getAttribute('data-width'), 10));
      return;
    }
    if (e.target.closest('#btnUndo')) {
      undo();
      return;
    }
    if (e.target.closest('#btnRedo')) {
      redo();
      return;
    }
    if (e.target.closest('#btnDelete')) {
      deleteSelected();
      return;
    }
    var actBtn = e.target.closest('.action-btn[data-action]');
    if (actBtn) {
      var action = actBtn.getAttribute('data-action');
      if (action === 'cancel') {
        doCancel();
      } else if (action === 'qr') {
        showQrPanel();
      } else if (action === 'ask' || action === 'translate' || action === 'polish') {
        // 翻译 / 问 AI / 润色：在截图层内就地完成，不另开窗口
        openInlineAI(action);
      } else {
        finishAction(action);
      }
      return;
    }
  });

  function selectTool(tool) {
    commitText();
    if (S.tool === tool) {
      // 再次点击同一工具 → 取消激活（回到选区移动模式）
      S.tool = null;
    } else {
      S.tool = tool;
    }
    // 离开选择工具时，清除标注选中态
    if (S.tool !== 'select') setSelected(null);
    var btns = toolbar.querySelectorAll('.tool-btn[data-tool]');
    for (var i = 0; i < btns.length; i++) {
      btns[i].classList.toggle('active', btns[i].getAttribute('data-tool') === S.tool);
    }
    selectionEl.classList.toggle('annotating', !!S.tool);
    // 选择工具用默认箭头光标（覆盖 annotating 的十字光标）；其它工具回退到样式表
    annoCanvas.style.cursor = S.tool === 'select' ? 'default' : '';
    redrawAnno();
  }

  function setColor(c) {
    S.color = c;
    var btns = toolbar.querySelectorAll('.color-btn');
    for (var i = 0; i < btns.length; i++) {
      btns[i].classList.toggle('active', btns[i].getAttribute('data-color') === c);
    }
    // 选中标注时，改色直接作用于该标注
    if (S.tool === 'select' && S.selected) {
      pushHistory();
      S.selected.color = c;
      redrawAnno();
      updateUndoRedo();
    }
  }
  function setWidth(w) {
    S.width = w;
    var btns = toolbar.querySelectorAll('.width-btn');
    for (var i = 0; i < btns.length; i++) {
      btns[i].classList.toggle('active', parseInt(btns[i].getAttribute('data-width'), 10) === w);
    }
    // 选中带描边的标注时，改粗细直接作用于该标注（文字/序号用缩放手柄改大小）
    if (S.tool === 'select' && S.selected && typeof S.selected.width === 'number') {
      pushHistory();
      S.selected.width = w;
      redrawAnno();
      updateUndoRedo();
    }
  }

  // 初始化默认色/粗细高亮
  setColor('#ef4444');
  setWidth(4);

  // 翻译目标语言：从配置载入默认值，用户改动即存回配置（下次默认沿用）
  if (trLang) {
    trLang.addEventListener('mousedown', function (e) { e.stopPropagation(); });
    trLang.addEventListener('click', function (e) { e.stopPropagation(); });
    trLang.addEventListener('change', function () {
      try { kkapi.setConfig({ translate: { target: trLang.value } }); } catch (_) {}
    });
    Promise.resolve(kkapi.getConfig())
      .then(function (cfg) {
        var t = cfg && cfg.translate && cfg.translate.target;
        if (t) trLang.value = t;
      })
      .catch(function () {});
  }

  // ================= 标注绘制 =================
  function startAnnotate(e) {
    e.preventDefault();
    var p = evtToAnno(e);
    if (S.tool === 'text') {
      openTextEditor(e);
      return;
    }
    if (S.tool === 'number') {
      // 序号笔：单击即放置一个递增数字圆圈（计数由 pushShape 统一推进）
      pushShape({
        type: 'number',
        x: p.x,
        y: p.y,
        n: S.numberSeq,
        color: S.color,
        size: Math.max(14, S.width * 4),
      });
      return;
    }
    S.drawing = true;
    if (S.tool === 'pen' || S.tool === 'mosaic' || S.tool === 'highlight') {
      S.cur = { type: S.tool, points: [{ x: p.x, y: p.y }], color: S.color, width: S.width };
    } else {
      // rect / ellipse / arrow
      S.cur = { type: S.tool, x1: p.x, y1: p.y, x2: p.x, y2: p.y, color: S.color, width: S.width };
    }
    redrawAnno();
  }

  function continueAnnotate(e) {
    if (!S.cur) return;
    var p = evtToAnno(e);
    p.x = clamp(p.x, 0, annoCanvas.width);
    p.y = clamp(p.y, 0, annoCanvas.height);
    if (S.cur.type === 'pen' || S.cur.type === 'mosaic' || S.cur.type === 'highlight') {
      S.cur.points.push({ x: p.x, y: p.y });
    } else {
      S.cur.x2 = p.x;
      S.cur.y2 = p.y;
    }
    redrawAnno();
  }

  function endAnnotate(e) {
    S.drawing = false;
    if (!S.cur) return;
    var c = S.cur;
    S.cur = null;
    // 丢弃过小的图形
    if (c.type === 'pen' || c.type === 'mosaic' || c.type === 'highlight') {
      if (c.points.length < 2) {
        redrawAnno();
        return;
      }
    } else {
      if (Math.abs(c.x2 - c.x1) < 3 && Math.abs(c.y2 - c.y1) < 3) {
        redrawAnno();
        return;
      }
    }
    pushShape(c);
  }

  function pushShape(shape) {
    pushHistory();
    S.shapes.push(shape);
    if (shape.type === 'number') S.numberSeq = Math.max(S.numberSeq, (shape.n || 0) + 1);
    redrawAnno();
    updateUndoRedo();
  }

  // 平移一组标注的坐标 (dx,dy)（anno 坐标系）。
  function shiftShapeList(shapes, dx, dy) {
    for (var i = 0; i < shapes.length; i++) {
      var s = shapes[i];
      if (s.type === 'rect' || s.type === 'ellipse' || s.type === 'arrow' || s.type === 'line') {
        s.x1 += dx; s.y1 += dy; s.x2 += dx; s.y2 += dy;
      } else if (s.type === 'pen' || s.type === 'mosaic' || s.type === 'highlight') {
        for (var j = 0; j < s.points.length; j++) { s.points[j].x += dx; s.points[j].y += dy; }
      } else { // text / number
        s.x += dx; s.y += dy;
      }
    }
  }
  // 缩放选区改变原点时，把标注反向平移使其继续盖在原底图内容上、不随原点漂移。
  // 同时平移 history/redo 快照里的坐标——快照存的是相对原点的 anno 坐标，原点变了若不同步，
  // 缩放后撤销会按旧原点坐标还原、配上新原点导致标注漂走。
  function shiftShapes(dx, dy) {
    if (!dx && !dy) return;
    shiftShapeList(S.shapes, dx, dy);
    for (var h = 0; h < S.history.length; h++) shiftShapeList(S.history[h].shapes, dx, dy);
    for (var k = 0; k < S.redoStack.length; k++) shiftShapeList(S.redoStack[k].shapes, dx, dy);
  }

  // ================= 标注选择 / 再编辑 =================
  // ---- 状态快照（撤销/重做基于整状态，故移动/缩放/改样式/删除都可撤销）----
  function currentSnapshot() {
    return { shapes: JSON.parse(JSON.stringify(S.shapes)), numberSeq: S.numberSeq };
  }
  function restoreSnapshot(s) {
    S.shapes = JSON.parse(JSON.stringify(s.shapes));
    S.numberSeq = s.numberSeq;
    S.selected = null;
  }
  function pushHistory() {
    S.history.push(currentSnapshot());
    if (S.history.length > 100) S.history.shift();
    S.redoStack = [];
  }

  // ---- 包围盒 ----
  function getBBox(s) {
    if (s.type === 'rect' || s.type === 'ellipse' || s.type === 'arrow' || s.type === 'line') {
      return { x: Math.min(s.x1, s.x2), y: Math.min(s.y1, s.y2), w: Math.abs(s.x2 - s.x1), h: Math.abs(s.y2 - s.y1) };
    }
    if (s.type === 'pen' || s.type === 'mosaic' || s.type === 'highlight') {
      var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (var i = 0; i < s.points.length; i++) {
        var p = s.points[i];
        if (p.x < minX) minX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x;
        if (p.y > maxY) maxY = p.y;
      }
      return { x: minX, y: minY, w: Math.max(1, maxX - minX), h: Math.max(1, maxY - minY) };
    }
    if (s.type === 'text') {
      annoCtx.save();
      annoCtx.font = s.size + 'px ' + '-apple-system, "PingFang SC", "Microsoft YaHei", system-ui, sans-serif';
      var lines = String(s.text).split('\n');
      var w = 8;
      for (var li = 0; li < lines.length; li++) w = Math.max(w, annoCtx.measureText(lines[li]).width);
      annoCtx.restore();
      return { x: s.x, y: s.y, w: w, h: Math.max(8, lines.length * s.size * 1.25) };
    }
    if (s.type === 'number') {
      var rad = s.size / 2;
      return { x: s.x - rad, y: s.y - rad, w: s.size, h: s.size };
    }
    return { x: 0, y: 0, w: 0, h: 0 };
  }
  function paddedBox(b) {
    return { x: b.x - 2, y: b.y - 2, w: b.w + 4, h: b.h + 4 };
  }

  // ---- 命中测试 ----
  function pointInShape(s, p) {
    var b = getBBox(s);
    var pad = Math.max(6, s.width || 4);
    return p.x >= b.x - pad && p.x <= b.x + b.w + pad && p.y >= b.y - pad && p.y <= b.y + b.h + pad;
  }
  function hitTestShapes(p) {
    for (var i = S.shapes.length - 1; i >= 0; i--) {
      if (pointInShape(S.shapes[i], p)) return S.shapes[i];
    }
    return null;
  }
  function selectionHandles(b) {
    var cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    return [
      { pos: 'nw', x: b.x, y: b.y }, { pos: 'n', x: cx, y: b.y }, { pos: 'ne', x: b.x + b.w, y: b.y },
      { pos: 'e', x: b.x + b.w, y: cy }, { pos: 'se', x: b.x + b.w, y: b.y + b.h }, { pos: 's', x: cx, y: b.y + b.h },
      { pos: 'sw', x: b.x, y: b.y + b.h }, { pos: 'w', x: b.x, y: cy },
    ];
  }
  function handleAtPoint(s, p) {
    var hs = selectionHandles(paddedBox(getBBox(s)));
    var tol = 7;
    for (var i = 0; i < hs.length; i++) {
      if (Math.abs(p.x - hs[i].x) <= tol && Math.abs(p.y - hs[i].y) <= tol) return hs[i].pos;
    }
    return null;
  }

  // ---- 变换（基于原始快照计算，避免累积误差）----
  function translateShape(src, dx, dy) {
    var s = JSON.parse(JSON.stringify(src));
    if (s.type === 'pen' || s.type === 'mosaic' || s.type === 'highlight') {
      for (var i = 0; i < s.points.length; i++) {
        s.points[i].x += dx;
        s.points[i].y += dy;
      }
    } else if (s.type === 'text' || s.type === 'number') {
      s.x += dx;
      s.y += dy;
    } else {
      s.x1 += dx; s.y1 += dy; s.x2 += dx; s.y2 += dy;
    }
    return s;
  }
  function remap(v, oldA, oldLen, newA, newLen) {
    if (oldLen <= 0) return newA;
    return newA + (v - oldA) * (newLen / oldLen);
  }
  function resizeShape(src, ob, nb) {
    var s = JSON.parse(JSON.stringify(src));
    function rx(x) { return remap(x, ob.x, ob.w, nb.x, nb.w); }
    function ry(y) { return remap(y, ob.y, ob.h, nb.y, nb.h); }
    if (s.type === 'pen' || s.type === 'mosaic' || s.type === 'highlight') {
      for (var i = 0; i < s.points.length; i++) {
        s.points[i].x = rx(s.points[i].x);
        s.points[i].y = ry(s.points[i].y);
      }
    } else if (s.type === 'text') {
      s.x = rx(s.x);
      s.y = ry(s.y);
      s.size = Math.max(8, s.size * (ob.h > 0 ? nb.h / ob.h : 1));
    } else if (s.type === 'number') {
      var sc = ((ob.w > 0 ? nb.w / ob.w : 1) + (ob.h > 0 ? nb.h / ob.h : 1)) / 2;
      s.x = rx(s.x);
      s.y = ry(s.y);
      s.size = Math.max(10, s.size * sc);
    } else {
      s.x1 = rx(s.x1); s.x2 = rx(s.x2); s.y1 = ry(s.y1); s.y2 = ry(s.y2);
    }
    return s;
  }

  // ---- 选择交互 ----
  function setSelected(shape) {
    S.selected = shape || null;
    if (shape) syncStyleButtons();
    updateEditButtons();
    redrawAnno();
  }
  function syncStyleButtons() {
    if (!S.selected) return;
    var c = S.selected.color;
    S.color = c || S.color;
    var cbtns = toolbar.querySelectorAll('.color-btn');
    for (var i = 0; i < cbtns.length; i++) cbtns[i].classList.toggle('active', cbtns[i].getAttribute('data-color') === c);
    if (typeof S.selected.width === 'number') {
      var wbtns = toolbar.querySelectorAll('.width-btn');
      for (var j = 0; j < wbtns.length; j++) {
        wbtns[j].classList.toggle('active', parseInt(wbtns[j].getAttribute('data-width'), 10) === S.selected.width);
      }
    }
  }
  function handleSelectDown(e) {
    var p = evtToAnno(e);
    if (!isInsideSelection(e)) {
      setSelected(null);
      return;
    }
    // 已选中时优先判断缩放控制点
    if (S.selected) {
      var pos = handleAtPoint(S.selected, p);
      if (pos) {
        startShapeResize(e, pos);
        return;
      }
    }
    var hit = hitTestShapes(p);
    if (hit) {
      setSelected(hit);
      startShapeMove(e);
    } else {
      setSelected(null);
    }
  }
  function startShapeMove(e) {
    var p = evtToAnno(e);
    S.shapeDrag = { mode: 'move', startMx: p.x, startMy: p.y, origShape: JSON.parse(JSON.stringify(S.selected)) };
    S._dragSnapshot = currentSnapshot();
    S._dragMoved = false;
    e.preventDefault();
  }
  function startShapeResize(e, pos) {
    S.shapeDrag = { mode: 'resize', handle: pos, origShape: JSON.parse(JSON.stringify(S.selected)), origBox: getBBox(S.selected) };
    S._dragSnapshot = currentSnapshot();
    S._dragMoved = false;
    e.preventDefault();
  }
  function applyShapeDrag(e) {
    if (!S.selected || !S.shapeDrag) return;
    var p = evtToAnno(e);
    var d = S.shapeDrag;
    if (d.mode === 'move') {
      Object.assign(S.selected, translateShape(d.origShape, p.x - d.startMx, p.y - d.startMy));
    } else {
      var ob = d.origBox;
      var left = ob.x, top = ob.y, right = ob.x + ob.w, bottom = ob.y + ob.h;
      var pos = d.handle;
      if (pos.indexOf('w') !== -1) left = p.x;
      if (pos.indexOf('e') !== -1) right = p.x;
      if (pos.indexOf('n') !== -1) top = p.y;
      if (pos.indexOf('s') !== -1) bottom = p.y;
      var nb = { x: Math.min(left, right), y: Math.min(top, bottom), w: Math.max(2, Math.abs(right - left)), h: Math.max(2, Math.abs(bottom - top)) };
      Object.assign(S.selected, resizeShape(d.origShape, ob, nb));
    }
    S._dragMoved = true;
    redrawAnno();
  }
  function endShapeDrag() {
    if (S._dragMoved && S._dragSnapshot) {
      S.history.push(S._dragSnapshot);
      if (S.history.length > 100) S.history.shift();
      S.redoStack = [];
    }
    S.shapeDrag = null;
    S._dragSnapshot = null;
    S._dragMoved = false;
    updateUndoRedo();
  }
  function deleteSelected() {
    if (!S.selected) return;
    pushHistory();
    var idx = S.shapes.indexOf(S.selected);
    if (idx !== -1) S.shapes.splice(idx, 1);
    S.selected = null;
    updateEditButtons();
    redrawAnno();
    updateUndoRedo();
  }
  function updateHoverCursor(e) {
    if (S.shapeDrag) return;
    var p = evtToAnno(e);
    var cur = 'default';
    var overHandle = S.selected ? handleAtPoint(S.selected, p) : null;
    if (overHandle) {
      var map = { n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize', nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize' };
      cur = map[overHandle] || 'default';
    } else if (hitTestShapes(p)) {
      cur = 'move';
    }
    annoCanvas.style.cursor = cur;
  }
  function updateEditButtons() {
    if (btnDelete) btnDelete.disabled = !S.selected;
  }

  // ---------- 文字标注 ----------
  function openTextEditor(e) {
    commitText();
    var p = evtToAnno(e);
    S._textPos = { x: p.x, y: p.y };
    textInput.hidden = false;
    textInput.value = '';
    textInput.style.left = e.clientX + 'px';
    textInput.style.top = e.clientY + 'px';
    textInput.style.color = S.color;
    var fontSize = Math.max(14, S.width * 5);
    textInput.style.fontSize = fontSize + 'px';
    textInput.style.lineHeight = '1.25';
    S._textFontSize = fontSize;
    setTimeout(function () {
      textInput.focus();
    }, 0);
  }

  // 再编辑已有文字标注：把输入框定位到该文字处并填入原内容
  function openTextEditorForShape(shape, e) {
    commitText();
    S.editingTextShape = shape;
    shape._editing = true; // 渲染时跳过，避免与输入框重影
    S._textPos = { x: shape.x, y: shape.y };
    S._textFontSize = shape.size;
    textInput.hidden = false;
    textInput.value = shape.text;
    textInput.style.left = (S.rect.x + shape.x) + 'px';
    textInput.style.top = (S.rect.y + shape.y) + 'px';
    textInput.style.color = shape.color;
    textInput.style.fontSize = shape.size + 'px';
    textInput.style.lineHeight = '1.25';
    redrawAnno();
    setTimeout(function () {
      textInput.focus();
      // 触发一次自适应宽高
      textInput.dispatchEvent(new Event('input'));
    }, 0);
  }

  // 双击：在选择工具下双击文字标注可再编辑
  document.addEventListener('dblclick', function (e) {
    if (S.finished || !S.rect) return;
    if (toolbar.contains(e.target) || e.target === textInput) return;
    if (S.tool !== 'select') return;
    var hit = hitTestShapes(evtToAnno(e));
    if (hit && hit.type === 'text') {
      setSelected(hit);
      openTextEditorForShape(hit, e);
    }
  });

  textInput.addEventListener('mousedown', function (e) {
    e.stopPropagation();
  });
  textInput.addEventListener('input', function () {
    // 自适应宽高
    textInput.style.width = 'auto';
    textInput.style.height = 'auto';
    textInput.style.width = Math.min(textInput.scrollWidth + 8, S.displayCssW) + 'px';
    textInput.style.height = textInput.scrollHeight + 'px';
  });
  textInput.addEventListener('keydown', function (e) {
    e.stopPropagation();
    if (e.key === 'Escape') {
      // 再编辑中按 Esc：放弃改动，还原原文字
      if (S.editingTextShape) {
        delete S.editingTextShape._editing;
        S.editingTextShape = null;
      }
      textInput.value = '';
      textInput.hidden = true;
      redrawAnno();
    } else if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      commitText();
    }
  });
  textInput.addEventListener('blur', function () {
    commitText();
  });

  function commitText() {
    if (textInput.hidden) return;
    var val = textInput.value;
    var pos = S._textPos;
    textInput.hidden = true;

    // 再编辑已有文字
    if (S.editingTextShape) {
      var sh = S.editingTextShape;
      S.editingTextShape = null;
      delete sh._editing;
      pushHistory();
      if (val && val.trim() !== '') {
        sh.text = val;
      } else {
        // 清空 → 删除该文字标注
        var idx = S.shapes.indexOf(sh);
        if (idx !== -1) S.shapes.splice(idx, 1);
        if (S.selected === sh) S.selected = null;
        updateEditButtons();
      }
      redrawAnno();
      updateUndoRedo();
      return;
    }

    // 新建文字
    if (val && val.trim() !== '' && pos) {
      pushShape({
        type: 'text',
        x: pos.x,
        y: pos.y,
        text: val,
        color: S.color,
        size: S._textFontSize || 18,
      });
    }
  }

  // ================= 重绘标注画布 =================
  function redrawAnno() {
    if (!annoCanvas.width || !annoCanvas.height) return;
    annoCtx.clearRect(0, 0, annoCanvas.width, annoCanvas.height);
    var all = S.shapes.slice();
    if (S.cur) all.push(S.cur);
    for (var i = 0; i < all.length; i++) {
      if (all[i]._editing) continue; // 正在再编辑的文字暂不绘制（由输入框接管）
      drawShape(annoCtx, all[i], 1);
    }
    drawSelectionChrome();
  }

  // 选中标注的虚线框 + 八个控制点
  function drawSelectionChrome() {
    if (S.tool !== 'select' || !S.selected) return;
    if (S.shapes.indexOf(S.selected) === -1) return;
    var pb = paddedBox(getBBox(S.selected));
    var ctx = annoCtx;
    ctx.save();
    ctx.setLineDash([4, 3]);
    ctx.lineWidth = 1;
    ctx.strokeStyle = '#2563eb';
    ctx.strokeRect(pb.x, pb.y, pb.w, pb.h);
    ctx.setLineDash([]);
    var hs = selectionHandles(pb);
    for (var i = 0; i < hs.length; i++) {
      ctx.beginPath();
      ctx.rect(hs[i].x - 3.5, hs[i].y - 3.5, 7, 7);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.lineWidth = 1.2;
      ctx.strokeStyle = '#2563eb';
      ctx.stroke();
    }
    ctx.restore();
  }

  // scale：1 表示画在 annoCanvas（CSS 坐标）；合成时传 scaleFactor 放大
  function drawShape(ctx, s, scale) {
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    var lw = (s.width || S.width) * scale;
    ctx.strokeStyle = s.color;
    ctx.fillStyle = s.color;

    if (s.type === 'rect') {
      ctx.lineWidth = lw;
      var x = Math.min(s.x1, s.x2) * scale;
      var y = Math.min(s.y1, s.y2) * scale;
      var w = Math.abs(s.x2 - s.x1) * scale;
      var h = Math.abs(s.y2 - s.y1) * scale;
      ctx.strokeRect(x, y, w, h);
    } else if (s.type === 'ellipse') {
      ctx.lineWidth = lw;
      var cx = ((s.x1 + s.x2) / 2) * scale;
      var cy = ((s.y1 + s.y2) / 2) * scale;
      var rx = (Math.abs(s.x2 - s.x1) / 2) * scale;
      var ry = (Math.abs(s.y2 - s.y1) / 2) * scale;
      ctx.beginPath();
      ctx.ellipse(cx, cy, Math.max(1, rx), Math.max(1, ry), 0, 0, Math.PI * 2);
      ctx.stroke();
    } else if (s.type === 'arrow') {
      drawArrow(ctx, s.x1 * scale, s.y1 * scale, s.x2 * scale, s.y2 * scale, lw, s.color);
    } else if (s.type === 'line') {
      ctx.lineWidth = lw;
      ctx.beginPath();
      ctx.moveTo(s.x1 * scale, s.y1 * scale);
      ctx.lineTo(s.x2 * scale, s.y2 * scale);
      ctx.stroke();
    } else if (s.type === 'highlight') {
      // 荧光笔：加粗 + 半透明，盖在文字上仍可读
      ctx.globalAlpha = 0.42;
      ctx.lineWidth = Math.max(10, lw * 2.6);
      ctx.beginPath();
      var hpts = s.points;
      ctx.moveTo(hpts[0].x * scale, hpts[0].y * scale);
      for (var hi = 1; hi < hpts.length; hi++) {
        ctx.lineTo(hpts[hi].x * scale, hpts[hi].y * scale);
      }
      ctx.stroke();
    } else if (s.type === 'pen') {
      ctx.lineWidth = lw;
      ctx.beginPath();
      var pts = s.points;
      ctx.moveTo(pts[0].x * scale, pts[0].y * scale);
      for (var i = 1; i < pts.length; i++) {
        ctx.lineTo(pts[i].x * scale, pts[i].y * scale);
      }
      ctx.stroke();
    } else if (s.type === 'mosaic') {
      drawMosaic(ctx, s, scale);
    } else if (s.type === 'text') {
      var fs = s.size * scale;
      ctx.font = fs + 'px ' + '-apple-system, "PingFang SC", "Microsoft YaHei", system-ui, sans-serif';
      ctx.textBaseline = 'top';
      var lines = String(s.text).split('\n');
      for (var li = 0; li < lines.length; li++) {
        ctx.fillText(lines[li], s.x * scale, s.y * scale + li * fs * 1.25);
      }
    } else if (s.type === 'number') {
      var rad = (s.size / 2) * scale;
      var ncx = s.x * scale;
      var ncy = s.y * scale;
      ctx.beginPath();
      ctx.arc(ncx, ncy, rad, 0, Math.PI * 2);
      ctx.fillStyle = s.color;
      ctx.fill();
      ctx.fillStyle = pickContrast(s.color);
      ctx.font = 'bold ' + Math.round(rad * 1.1) + 'px -apple-system, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(s.n), ncx, ncy + 1 * scale);
      ctx.textAlign = 'start';
    }
    ctx.restore();
  }

  function drawArrow(ctx, x1, y1, x2, y2, lw, color) {
    var angle = Math.atan2(y2 - y1, x2 - x1);
    var headLen = Math.max(10, lw * 3.2);
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = lw;
    // 主干（缩短一点，给箭头让位）
    var bx = x2 - Math.cos(angle) * headLen * 0.6;
    var by = y2 - Math.sin(angle) * headLen * 0.6;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(bx, by);
    ctx.stroke();
    // 箭头三角
    ctx.beginPath();
    ctx.moveTo(x2, y2);
    ctx.lineTo(
      x2 - headLen * Math.cos(angle - Math.PI / 7),
      y2 - headLen * Math.sin(angle - Math.PI / 7)
    );
    ctx.lineTo(
      x2 - headLen * Math.cos(angle + Math.PI / 7),
      y2 - headLen * Math.sin(angle + Math.PI / 7)
    );
    ctx.closePath();
    ctx.fill();
  }

  // 马赛克：沿笔迹涂抹，把底图对应区域像素化
  function drawMosaic(ctx, s, scale) {
    if (!S.bgImage || !S.rect) return;
    var block = Math.max(6, (s.width || S.width) * 2) * scale; // 马赛克块大小
    var radius = Math.max(block, (s.width || S.width) * 3) * scale; // 涂抹笔半径
    var pts = s.points;
    var phys = dpr();
    // 背景在选区内对应的物理像素起点
    var baseX = S.rect.x * phys;
    var baseY = S.rect.y * phys;
    ctx.save();
    // 用裁剪路径限定在笔迹圆形区域内
    ctx.beginPath();
    for (var i = 0; i < pts.length; i++) {
      ctx.moveTo(pts[i].x * scale + radius, pts[i].y * scale);
      ctx.arc(pts[i].x * scale, pts[i].y * scale, radius, 0, Math.PI * 2);
    }
    ctx.clip();
    // 在裁剪区域内逐块绘制马赛克：从背景采样块中心颜色，填充整块
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (var j = 0; j < pts.length; j++) {
      minX = Math.min(minX, pts[j].x);
      minY = Math.min(minY, pts[j].y);
      maxX = Math.max(maxX, pts[j].x);
      maxY = Math.max(maxY, pts[j].y);
    }
    minX = (minX * scale) - radius;
    minY = (minY * scale) - radius;
    maxX = (maxX * scale) + radius;
    maxY = (maxY * scale) + radius;
    minX = clamp(minX, 0, annoCanvas.width * scale);
    minY = clamp(minY, 0, annoCanvas.height * scale);
    for (var by = Math.floor(minY / block) * block; by < maxY; by += block) {
      for (var bx = Math.floor(minX / block) * block; bx < maxX; bx += block) {
        // 该块在背景物理像素中的源位置（块中心）
        var srcX = baseX + (bx + block / 2) / scale * phys;
        var srcY = baseY + (by + block / 2) / scale * phys;
        srcX = clamp(srcX, 0, S.bgImage.naturalWidth - 1);
        srcY = clamp(srcY, 0, S.bgImage.naturalHeight - 1);
        // 直接把背景对应 1px 放大成整块，实现像素化
        try {
          ctx.drawImage(S.bgImage, srcX, srcY, 1, 1, bx, by, block, block);
        } catch (err) {
          /* 忽略越界采样 */
        }
      }
    }
    ctx.restore();
  }

  function pickContrast(hex) {
    // 简单亮度判断：浅色背景用黑字，深色用白字
    var c = hex.replace('#', '');
    if (c.length === 3) c = c[0] + c[0] + c[1] + c[1] + c[2] + c[2];
    var r = parseInt(c.substr(0, 2), 16);
    var g = parseInt(c.substr(2, 2), 16);
    var b = parseInt(c.substr(4, 2), 16);
    var lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return lum > 0.6 ? '#111111' : '#ffffff';
  }

  // ================= 撤销 / 重做（整状态快照）=================
  function undo() {
    if (!S.history.length) return;
    S.redoStack.push(currentSnapshot());
    restoreSnapshot(S.history.pop());
    updateEditButtons();
    redrawAnno();
    updateUndoRedo();
  }
  function redo() {
    if (!S.redoStack.length) return;
    S.history.push(currentSnapshot());
    restoreSnapshot(S.redoStack.pop());
    updateEditButtons();
    redrawAnno();
    updateUndoRedo();
  }
  function updateUndoRedo() {
    if (btnUndo) btnUndo.disabled = S.history.length === 0;
    if (btnRedo) btnRedo.disabled = S.redoStack.length === 0;
  }

  // ================= 放大镜 =================
  // 颜色格式工具：RGB 字符串 / HEX 字符串
  function colorToRGB(c) {
    return 'RGB(' + c.r + ', ' + c.g + ', ' + c.b + ')';
  }
  function colorToHex(c) {
    var h = function (v) {
      var s = v.toString(16).toUpperCase();
      return s.length === 1 ? '0' + s : s;
    };
    return '#' + h(c.r) + h(c.g) + h(c.b);
  }
  function colorStr(c, hex) {
    return c ? (hex ? colorToHex(c) : colorToRGB(c)) : '';
  }

  // 读取背景底图上某 CSS 坐标处的像素颜色（物理像素采样）。越界 / 未就绪返回 null。
  function colorAt(x, y) {
    if (!S.bgReady || !S.bgImage) return null;
    var phys = dpr();
    var px = Math.round(x * phys);
    var py = Math.round(y * phys);
    var W = bgCanvas.width;
    var H = bgCanvas.height;
    if (px < 0 || py < 0 || px >= W || py >= H) return null;
    try {
      var d = bgCtx.getImageData(px, py, 1, 1).data;
      return { r: d[0], g: d[1], b: d[2] };
    } catch (err) {
      return null;
    }
  }

  function showMagnifier(e) {
    if (!S.bgImage) return;
    magnifier.hidden = false;
    var phys = dpr();
    var srcW = 24; // 采样区域（CSS px）
    var srcH = 18;
    var sx = e.clientX * phys - (srcW * phys) / 2;
    var sy = e.clientY * phys - (srcH * phys) / 2;
    magCtx.imageSmoothingEnabled = false;
    magCtx.clearRect(0, 0, magCanvas.width, magCanvas.height);
    try {
      magCtx.drawImage(
        bgCanvas,
        sx,
        sy,
        srcW * phys,
        srcH * phys,
        0,
        0,
        magCanvas.width,
        magCanvas.height
      );
    } catch (err) {
      /* 越界忽略 */
    }
    // 取色：读光标下的像素颜色。Shift 按住时显示 HEX，否则显示 RGB（与 PixPin 一致）。
    S.curColor = colorAt(e.clientX, e.clientY);
    magColor.textContent = colorStr(S.curColor, e.shiftKey);
    magColor.hidden = !S.curColor;
    magInfo.textContent =
      '(' + Math.round(e.clientX) + ', ' + Math.round(e.clientY) + ')';

    // 放大镜放在鼠标右下，越界则换边
    var mw = 124;
    var mh = 110;
    var mx = e.clientX + 16;
    var my = e.clientY + 16;
    if (mx + mw > S.displayCssW) mx = e.clientX - mw - 16;
    if (my + mh > S.displayCssH) my = e.clientY - mh - 16;
    magnifier.style.left = mx + 'px';
    magnifier.style.top = my + 'px';
  }
  function hideMagnifier() {
    magnifier.hidden = true;
  }

  // 轻提示（复制颜色等短暂反馈，仿 pin 的 toast）
  var tipTimer = null;
  // ================= 二维码识别（PixPin 式：框选后自动检测）=================
  function scanQr() {
    if (!S.rect || !S.bgReady || !S.bgImage) return;
    if (typeof jsQR !== 'function') return;
    var phys = dpr();
    var r = S.rect;
    var w = Math.round(r.width * phys);
    var h = Math.round(r.height * phys);
    if (w < 40 || h < 40) {
      S.qrData = null;
      btnQR.hidden = true;
      return;
    }
    // 长边超过 1024 时降采样，避免大选区全分辨率扫描卡顿
    var MAX = 1024;
    var sc = Math.min(1, MAX / Math.max(w, h));
    var cw = Math.max(1, Math.round(w * sc));
    var ch = Math.max(1, Math.round(h * sc));
    var tmp = document.createElement('canvas');
    tmp.width = cw;
    tmp.height = ch;
    var tctx = tmp.getContext('2d');
    try {
      tctx.drawImage(bgCanvas, Math.round(r.x * phys), Math.round(r.y * phys), w, h, 0, 0, cw, ch);
    } catch (_) {
      return;
    }
    var img = tctx.getImageData(0, 0, cw, ch);
    var code = null;
    try {
      code = jsQR(img.data, cw, ch, { inversionAttempts: 'dontInvert' });
    } catch (_) {}
    if (!code) {
      try {
        code = jsQR(img.data, cw, ch, { inversionAttempts: 'attemptBoth' });
      } catch (_) {}
    }
    S.qrData = code ? String(code.data) : null;
    btnQR.hidden = !S.qrData;
  }
  function showQrPanel() {
    if (!S.qrData) return;
    qrText.textContent = S.qrData;
    btnQrOpen.hidden = !/^https?:\/\//i.test(S.qrData);
    qrPanel.hidden = false;
  }
  function hideQrPanel() {
    qrPanel.hidden = true;
  }
  function bindQrPanel() {
    btnQrCopy.addEventListener('click', function () {
      if (!S.qrData) return;
      Promise.resolve(kkapi.copyText(S.qrData))
        .then(function () { showTip('已复制二维码内容'); })
        .catch(function () { showTip('复制失败'); });
    });
    btnQrOpen.addEventListener('click', function () {
      if (!S.qrData || !/^https?:\/\//i.test(S.qrData)) return;
      Promise.resolve(kkapi.openExternal(S.qrData))
        .then(function () { hideQrPanel(); })
        .catch(function () { showTip('打开失败'); });
    });
    btnQrClose.addEventListener('click', hideQrPanel);
  }
  function showTip(msg) {
    var t = document.getElementById('kkTip');
    if (!t) return;
    t.textContent = msg;
    t.classList.add('show');
    if (tipTimer) clearTimeout(tipTimer);
    tipTimer = setTimeout(function () {
      t.classList.remove('show');
    }, 1400);
  }

  // ================= 合成最终图像 =================
  // opts.clean=true：只输出纯底图裁剪（不叠加标注 / 译文层），用于原位翻译的 OCR 输入，
  // 避免把箭头/文字标注或上一次译文也当成文字识别进去，导致译文错乱。
  function composeImage(opts) {
    if (!S.rect) return null;
    var clean = !!(opts && opts.clean);
    var phys = dpr();
    var r = S.rect;
    var outW = Math.max(1, Math.round(r.width * phys));
    var outH = Math.max(1, Math.round(r.height * phys));
    var out = document.createElement('canvas');
    out.width = outW;
    out.height = outH;
    var ctx = out.getContext('2d');

    // 圆角截图：先把整张导出图裁剪成圆角（背景+标注+译文都在圆角内）
    if (S.rounded) {
      var rad = Math.round((S.roundedRadius || 12) * phys);
      try {
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(0, 0, outW, outH, rad);
        else {
          // 兜底手动圆角路径
          ctx.moveTo(rad, 0);
          ctx.lineTo(outW - rad, 0);
          ctx.quadraticCurveTo(outW, 0, outW, rad);
          ctx.lineTo(outW, outH - rad);
          ctx.quadraticCurveTo(outW, outH, outW - rad, outH);
          ctx.lineTo(rad, outH);
          ctx.quadraticCurveTo(0, outH, 0, outH - rad);
          ctx.lineTo(0, rad);
          ctx.quadraticCurveTo(0, 0, rad, 0);
        }
        ctx.closePath();
        ctx.clip();
      } catch (_) {}
    }

    // 1) 从背景物理像素裁剪选区
    if (S.bgImage && bgCanvas.width > 0) {
      var srcX = Math.round(r.x * phys);
      var srcY = Math.round(r.y * phys);
      try {
        ctx.drawImage(bgCanvas, srcX, srcY, outW, outH, 0, 0, outW, outH);
      } catch (err) {
        /* 忽略 */
      }
    }

    // clean 模式到此结束：只要纯底图（OCR 输入用）。
    if (clean) return out.toDataURL('image/png');

    // 2) 叠加标注（按 phys 放大）
    ctx.imageSmoothingEnabled = true;
    for (var i = 0; i < S.shapes.length; i++) {
      drawShape(ctx, S.shapes[i], phys);
    }

    // 3) 叠加原位译文层（若已翻译）：把屏幕上的译文格子按相对坐标画进导出图，使保存/复制也含译文。
    //    复刻 DOM 渲染：每行用采样的背景色(c.bg)+对比文字色(c.fg)无缝盖回、字号≈格高*0.7、超宽横向压缩、按格裁剪。
    if (S.trCells && S.trCells.length) {
      for (var k = 0; k < S.trCells.length; k++) {
        var c = S.trCells[k];
        var cx = (c.xp / 100) * outW;
        var cy = (c.yp / 100) * outH;
        var cw = (c.wp / 100) * outW;
        var ch = (c.hp / 100) * outH;
        if (cw <= 0 || ch <= 0) continue;
        var txt = c.text == null ? '' : String(c.text);
        ctx.save();
        ctx.beginPath();
        ctx.rect(cx, cy, cw, ch);
        ctx.clip(); // 等价 overflow:hidden
        ctx.fillStyle = c.bg || '#fff';
        ctx.fillRect(cx, cy, cw, ch);
        if (txt) {
          // 字号先在 CSS 单位上算好可读下限再乘 phys，使导出图与屏幕层一致——
          // 否则 HiDPI 下 max(8,…) 下限不随 phys 线性变换，短行字号最多偏差约 33%。
          var cssH = ch / phys;
          var domFont = Math.max(1, Math.min(Math.max(8, Math.floor(cssH * 0.72)), Math.floor(cssH)));
          var fontPx = Math.max(1, Math.round(domFont * phys));
          ctx.fillStyle = c.fg || '#111';
          ctx.textBaseline = 'middle';
          ctx.font = fontPx + 'px -apple-system, BlinkMacSystemFont, sans-serif';
          var availW = cw - 2;
          var tw = ctx.measureText(txt).width;
          var ty = cy + ch / 2;
          if (tw > availW && tw > 0) {
            var sx = Math.max(0.35, availW / tw);
            ctx.translate(cx + 1, ty);
            ctx.scale(sx, 1);
            ctx.fillText(txt, 0, 0);
          } else {
            ctx.fillText(txt, cx + 1, ty);
          }
        }
        ctx.restore();
      }
    }
    return out.toDataURL('image/png');
  }

  // ================= 提交动作 =================
  function finishAction(action) {
    if (S.finished) return;
    if (!S.rect) {
      doCancel();
      return;
    }
    commitText();
    S.finished = true;

    var r = S.rect;
    var rectOut = {
      x: Math.round(r.x),
      y: Math.round(r.y),
      width: Math.round(r.width),
      height: Math.round(r.height),
    };
    var boundsOut = {
      x: Math.round(S.displayBounds.x + r.x),
      y: Math.round(S.displayBounds.y + r.y),
      width: Math.round(r.width),
      height: Math.round(r.height),
    };

    // record / long 不需要图像合成
    // OCR 要识别原文：若做过原位翻译，白底译文会盖住原文，先清掉译文层再合成，避免 OCR 读到译文而非原文
    //（copy/save/pin 不清——用户翻译后保存/复制的本就该是带译文的图；与 openInlineAI 对 ask/polish 的处理对称）。
    if (action === 'ocr') clearInlineTranslate();
    var imageDataURL = action === 'record' || action === 'long' ? null : composeImage();

    var result = {
      action: action,
      imageDataURL: imageDataURL,
      rect: rectOut,
      bounds: boundsOut,
      displayId: S.displayId,
    };
    try {
      kkapi.finishCapture(result);
    } catch (err) {
      /* 主进程会自行关闭窗口 */
    }
  }

  function doCancel() {
    hideQrPanel();
    S.qrData = null;
    btnQR.hidden = true;
    if (S.finished) return;
    S.finished = true;
    try {
      kkapi.cancelCapture();
    } catch (err) {}
  }

  // ================= 截图层内联 AI（翻译就地 / 问AI 浮窗，不另开窗口）=================
  var IMG_TRANSLATE_PROMPT =
    '你是翻译引擎。把以下内容翻译出来：如果原文是中文就翻译成英文，否则一律翻译成简体中文。直接输出译文，保持原有分行；不要重复或保留原文，不要任何解释、标注或引号。';
  var IMG_POLISH_PROMPT =
    '请提取这张图片里的文字并润色，使其更通顺、专业、自然，保持原意。只输出润色后的文字，保持原有分行，不要解释、不要引号。';
  var aiPanel = null;

  function ensureAIStream() {
    if (S._aiStreamBound) return;
    S._aiStreamBound = true;
    if (typeof kkapi.onStream === 'function') {
      kkapi.onStream(function (ev) {
        if (!ev || ev.streamId !== S.aiStreamId) return;
        if (ev.canceled) { S.aiStreamId = null; aiRemoveReasoning(); aiSetBusy(false); return; }
        if (ev.error) { aiOnError(ev.error); return; }
        if (ev.reasoning) { S.aiLiveReasoning = (S.aiLiveReasoning || '') + ev.reasoning; aiRenderReasoning(); }
        if (ev.delta) { S.aiLiveText += ev.delta; aiRenderLive(); }
        if (ev.done) { aiOnDone(); }
      });
    }
  }
  function aiRenderLive() {
    if (S.aiLiveEl) S.aiLiveEl.textContent = S.aiLiveText;
    if (S.aiBody) S.aiBody.scrollTop = S.aiBody.scrollHeight;
  }
  // 思考流（reasoning）：盖一个淡色「💭」块在当前回答气泡上方，与独立 AI 窗一致。
  function aiEnsureReasoningEl() {
    if (S.aiReasoningEl) return S.aiReasoningEl;
    if (!S.aiBody) return null;
    var box = document.createElement('div');
    box.className = 'aii-msg aii-ai aii-reasoning';
    box.style.cssText = 'opacity:.6;font-size:12px;line-height:1.5;white-space:pre-wrap;';
    var answerMsg = S.aiLiveEl && S.aiLiveEl.parentNode;
    if (answerMsg && answerMsg.parentNode === S.aiBody) S.aiBody.insertBefore(box, answerMsg);
    else S.aiBody.appendChild(box);
    S.aiReasoningEl = box;
    return box;
  }
  function aiRenderReasoning() {
    var el = aiEnsureReasoningEl();
    if (!el) return;
    el.textContent = '💭 ' + (S.aiLiveReasoning || '');
    if (S.aiBody) S.aiBody.scrollTop = S.aiBody.scrollHeight;
  }
  // 移除「💭」思考块（出错/取消/完成时清理，避免残留孤儿块，与 ai/ai.js、pages/ai.js 一致）
  function aiRemoveReasoning() {
    if (S.aiReasoningEl && S.aiReasoningEl.parentNode) S.aiReasoningEl.parentNode.removeChild(S.aiReasoningEl);
    S.aiReasoningEl = null;
  }
  function aiOnError(msg) {
    S.aiStreamId = null;
    aiRemoveReasoning();
    if (S.aiLiveEl) {
      S.aiLiveEl.textContent = (S.aiLiveText ? S.aiLiveText + '\n\n' : '') + '⚠ ' + msg;
      S.aiLiveEl.classList.add('ai-err');
    }
    aiSetBusy(false);
  }
  function aiOnDone() {
    S.aiStreamId = null;
    // 完成时保留「💭」思考块供查看（与 pages/ai.js、ai/ai.js 的 finishStream 一致，仅出错/取消才清）。
    if (S.aiKind === 'ask' && S.aiLiveText) S.aiMessages.push({ role: 'assistant', content: S.aiLiveText });
    aiSetBusy(false);
  }
  function aiSetBusy(b) {
    S.aiBusy = b;
    if (!aiPanel) return;
    var send = aiPanel.querySelector('.aii-send');
    if (send) send.disabled = b;
    var spin = aiPanel.querySelector('.aii-spin');
    if (spin) spin.style.display = b ? '' : 'none';
  }
  function aiAppendMsg(role) {
    var msg = document.createElement('div');
    msg.className = 'aii-msg aii-' + role;
    if (role === 'user') {
      var lbl = document.createElement('b');
      lbl.textContent = '我';
      msg.appendChild(lbl);
    }
    var mb = document.createElement('div');
    mb.className = 'aii-text';
    msg.appendChild(mb);
    S.aiBody.appendChild(msg);
    S.aiBody.scrollTop = S.aiBody.scrollHeight;
    return mb;
  }
  // 取消当前在途的内联 AI 流（关面板 / 切 kind / 连发新请求前调用），
  // 否则旧流在主进程会继续空跑到自然结束 / 90s 超时，白烧 API 额度。
  function aiCancelStream() {
    if (S.aiStreamId) { try { if (kkapi.cancelStream) kkapi.cancelStream(S.aiStreamId); } catch (_) {} }
    S.aiStreamId = null;
  }
  function aiStartImage(prompt) {
    aiCancelStream(); // 发起新流前先取消上一条在途流
    S.aiLiveText = '';
    S.aiLiveReasoning = '';
    S.aiReasoningEl = null;
    S.aiLiveEl = aiAppendMsg('ai');
    aiSetBusy(true);
    var id = kkapi.uid();
    S.aiStreamId = id;
    Promise.resolve(kkapi.askImage({ dataURL: S.aiImageDataURL, prompt: prompt, streamId: id, think: true })).catch(function (e) {
      aiOnError(e && e.message ? e.message : String(e));
    });
  }
  function aiStartChat() {
    aiCancelStream(); // 发起新流前先取消上一条在途流
    S.aiLiveText = '';
    S.aiLiveReasoning = '';
    S.aiReasoningEl = null;
    S.aiLiveEl = aiAppendMsg('ai');
    aiSetBusy(true);
    var id = kkapi.uid();
    S.aiStreamId = id;
    Promise.resolve(kkapi.chat({ messages: S.aiMessages.slice(), streamId: id, think: true })).catch(function (e) {
      aiOnError(e && e.message ? e.message : String(e));
    });
  }
  // 原位覆盖翻译：识别选区每行文字+坐标 → 翻译 → 把译文盖在每行原文位置上
  (function () {
    if (window.__kkErrHooked) return;
    window.__kkErrHooked = true;
    function showTrErr(msg) {
      try {
        var d = document.createElement('div');
        d.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:2147483647;max-width:82vw;background:#c0392b;color:#fff;font:12px/1.55 -apple-system,sans-serif;padding:8px 12px;border-radius:8px;white-space:pre-wrap;';
        d.textContent = '[翻译诊断] ' + String(msg).slice(0, 500);
        document.body.appendChild(d);
        setTimeout(function () { if (d.parentNode) d.parentNode.removeChild(d); }, 10000);
      } catch (_) {}
    }
    window.__kkShowErr = showTrErr;
    window.addEventListener('error', function (e) { showTrErr('JS错误: ' + (e.message || (e.error && e.error.message) || e.error)); });
    window.addEventListener('unhandledrejection', function (e) { showTrErr('未处理拒绝: ' + ((e.reason && e.reason.message) || e.reason)); });
  })();
  function clearInlineTranslate() {
    if (S.trLayer && S.trLayer.parentNode) S.trLayer.parentNode.removeChild(S.trLayer);
    S.trLayer = null;
  }
  async function startInlineTranslate() {
    if (!S.rect || S.rect.width < 3 || S.rect.height < 3) return;
    commitText();
    var r = { x: S.rect.x, y: S.rect.y, width: S.rect.width, height: S.rect.height };
    var dataURL = composeImage();
    if (!dataURL) return;
    if (!kkapi.ocrBoxes || !kkapi.translateLines) {
      if (window.__kkShowErr) window.__kkShowErr('接口缺失：ocrBoxes/translateLines 未暴露，preload 没生效，请彻底重启 app');
      return;
    }
    clearInlineTranslate();
    var layer = document.createElement('div');
    layer.className = 'kk-tr-layer';
    layer.style.cssText = 'position:fixed;left:0;top:0;right:0;bottom:0;z-index:90;pointer-events:none;';
    document.body.appendChild(layer);
    S.trLayer = layer;
    var tip = document.createElement('div');
    tip.style.cssText = 'position:fixed;z-index:96;left:' + r.x + 'px;top:' + Math.max(2, r.y - 26) + 'px;background:rgba(20,20,22,.92);color:#fff;font:12px/1.5 -apple-system,sans-serif;padding:3px 9px;border-radius:6px;';
    tip.textContent = '正在识别…';
    layer.appendChild(tip);
    try {
      var vr = await kkapi.ocrBoxes({ dataURL: dataURL });
      if (!vr || vr.error || !vr.lines || !vr.lines.length) {
        tip.textContent = vr && vr.error ? '识别失败：' + vr.error : '未识别到文字';
        setTimeout(clearInlineTranslate, 1600);
        return;
      }
      tip.textContent = '正在翻译…';
      var texts = vr.lines.map(function (l) { return l.t; });
      var tr = await kkapi.translateLines({ lines: texts, target: '中文' });
      if (!tr || tr.error) {
        tip.textContent = '翻译失败：' + ((tr && tr.error) || '');
        setTimeout(clearInlineTranslate, 1600);
        return;
      }
      var outs = tr.lines || [];
      if (tip.parentNode) tip.parentNode.removeChild(tip);
      for (var i = 0; i < vr.lines.length; i++) {
        var ln = vr.lines[i];
        var x = r.x + (ln.x / 100) * r.width;
        var y = r.y + (ln.y / 100) * r.height;
        var w = (ln.w / 100) * r.width;
        var h = (ln.h / 100) * r.height;
        var cell = document.createElement('div');
        cell.style.cssText = 'position:fixed;overflow:hidden;display:flex;align-items:center;left:' + x + 'px;top:' + y + 'px;width:' + w + 'px;height:' + h + 'px;background:#fff;color:#111;border-radius:2px;box-sizing:border-box;padding:0 1px;white-space:nowrap;';
        var span = document.createElement('span');
        span.textContent = outs[i] || '';
        span.style.cssText = 'display:inline-block;transform-origin:left center;line-height:1;font-family:-apple-system,BlinkMacSystemFont,sans-serif;';
        span.style.fontSize = Math.max(8, Math.floor(h * 0.7)) + 'px';
        cell.appendChild(span);
        layer.appendChild(cell);
        (function (sp, availW) {
          requestAnimationFrame(function () {
            var sw = sp.scrollWidth;
            if (sw > availW && sw > 0) sp.style.transform = 'scaleX(' + Math.max(0.35, availW / sw) + ')';
          });
        })(span, w - 2);
      }
    } catch (e) {
      tip.textContent = '出错：' + (e && e.message ? e.message : e);
      if (window.__kkShowErr) window.__kkShowErr('翻译流程异常: ' + (e && e.message ? e.message : e));
      setTimeout(clearInlineTranslate, 2600);
    }
  }

  async function openInlineAI(kind) {
    if (!S.rect || S.rect.width < 3 || S.rect.height < 3) return;
    if (kind === 'translate') return startInlineTranslate();
    if (S.aiOpen && S.aiKind === kind) return;
    if (S.aiOpening) return; // 防 await(getConfig) 间隙内二次触发的 check-then-act 竞态：避免重复建面板 + 重复发看图 API
    S.aiOpening = true;
    commitText();
    ensureAIStream();
    if (!S.aiConfig) {
      try { S.aiConfig = await kkapi.getConfig(); } catch (_) { S.aiConfig = {}; }
    }
    var ds = (S.aiConfig && S.aiConfig.deepseek) || {};
    // 先清掉原位翻译层：否则若用户先做了原位翻译（白底译文盖在原文上），composeImage() 会把译文格烤进图，
    // 送给 AI 问图 / 润色的就是译文而非原文，结果走偏。标注(shapes)保留——那是用户主动画的。
    clearInlineTranslate();
    S.aiImageDataURL = composeImage();
    S.aiKind = kind;
    S.aiMessages = [];
    buildAIPanel(kind);
    S.aiOpen = true;
    S.aiOpening = false; // 占位结束，之后由 S.aiOpen 守卫接管
    toolbar.hidden = true;
    if (kind === 'translate') {
      aiStartImage(IMG_TRANSLATE_PROMPT);
    } else if (kind === 'polish') {
      aiStartImage(IMG_POLISH_PROMPT);
    } else {
      var prompt =
        ds.askImagePrompt ||
        '请识别并解释这张截图的内容；如果是题目请给出解题过程与答案；如果是报错请说明原因与修复方法。用中文回答。';
      S.aiMessages.push({ role: 'user', content: '（针对刚才的截图）' + prompt });
      aiStartImage(prompt);
    }
  }
  function buildAIPanel(kind) {
    closeAIPanelDom();
    var p = document.createElement('div');
    p.className = 'aii ' + (kind === 'translate' ? 'aii-translate' : 'aii-ask');
    p.addEventListener('mousedown', function (e) { e.stopPropagation(); });
    p.addEventListener('wheel', function (e) { e.stopPropagation(); });

    var head = document.createElement('div');
    head.className = 'aii-head';
    var title = document.createElement('span');
    title.className = 'aii-title';
    title.textContent = kind === 'translate' ? '译文 · 就地翻译' : '问 AI';
    var spin = document.createElement('span');
    spin.className = 'aii-spin';
    spin.textContent = '生成中…';
    var tools = document.createElement('div');
    tools.className = 'aii-tools';
    var copyBtn = document.createElement('button');
    copyBtn.className = 'aii-btn';
    copyBtn.type = 'button';
    copyBtn.textContent = '复制';
    copyBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      if (S.aiLiveText) {
        try { kkapi.copyText(S.aiLiveText); } catch (_) {}
        copyBtn.textContent = '已复制';
        setTimeout(function () { copyBtn.textContent = '复制'; }, 1200);
      }
    });
    var closeBtn = document.createElement('button');
    closeBtn.className = 'aii-btn aii-x';
    closeBtn.type = 'button';
    closeBtn.textContent = '✕';
    closeBtn.addEventListener('click', function (e) { e.stopPropagation(); closeAIPanel(); });
    tools.appendChild(copyBtn);
    tools.appendChild(closeBtn);
    head.appendChild(title);
    head.appendChild(spin);
    head.appendChild(tools);

    var body = document.createElement('div');
    body.className = 'aii-body';
    p.appendChild(head);
    p.appendChild(body);
    S.aiBody = body;

    if (kind === 'ask') {
      var inputRow = document.createElement('div');
      inputRow.className = 'aii-input';
      var ta = document.createElement('textarea');
      ta.className = 'aii-ta';
      ta.rows = 1;
      ta.placeholder = '继续追问，回车发送';
      var sendFollow = function () {
        var t = ta.value.trim();
        if (!t || S.aiBusy) return;
        ta.value = '';
        S.aiMessages.push({ role: 'user', content: t });
        var mb = aiAppendMsg('user');
        mb.textContent = t;
        aiStartChat();
      };
      ta.addEventListener('keydown', function (e) {
        e.stopPropagation();
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendFollow(); }
      });
      var send = document.createElement('button');
      send.className = 'aii-send';
      send.type = 'button';
      send.textContent = '发送';
      send.addEventListener('click', function (e) { e.stopPropagation(); sendFollow(); });
      inputRow.appendChild(ta);
      inputRow.appendChild(send);
      p.appendChild(inputRow);
    }

    // —— 拖动：按住标题栏移动整个面板 ——
    var drag = null;
    head.style.cursor = 'move';
    function onMove(e) {
      if (!drag) return;
      e.preventDefault();
      var nx = clamp(e.clientX - drag.dx, 4, S.displayCssW - p.offsetWidth - 4);
      var ny = clamp(e.clientY - drag.dy, 4, S.displayCssH - p.offsetHeight - 4);
      p.style.left = Math.round(nx) + 'px';
      p.style.top = Math.round(ny) + 'px';
    }
    function onUp() {
      drag = null;
      document.removeEventListener('mousemove', onMove, true);
      document.removeEventListener('mouseup', onUp, true);
    }
    head.addEventListener('mousedown', function (e) {
      if (e.target.closest('.aii-btn')) return; // 点工具按钮不触发拖动
      e.preventDefault();
      e.stopPropagation();
      drag = { dx: e.clientX - p.offsetLeft, dy: e.clientY - p.offsetTop };
      document.addEventListener('mousemove', onMove, true);
      document.addEventListener('mouseup', onUp, true);
    });

    document.body.appendChild(p);
    aiPanel = p;
    positionAIPanel(kind);
  }
  // 默认把面板放在选区【旁边】（右→左→下→上 择优），不遮挡截图；之后可自由拖动。
  function positionAIPanel(kind) {
    if (!aiPanel || !S.rect) return;
    var r = S.rect;
    var vw = S.displayCssW;
    var vh = S.displayCssH;
    var gap = 12;
    var w = kind === 'ask' ? 360 : Math.max(240, Math.min(420, Math.round(r.width)));
    aiPanel.style.width = w + 'px';
    var h = aiPanel.offsetHeight || 160; // 初始较小，靠 maxHeight 限高
    var x, y;
    if (kind === 'translate') {
      // 翻译：优先放在选区正下方（微信式），放不下再往上、再退右侧
      if (r.y + r.height + gap + 80 <= vh) {
        x = r.x;
        y = r.y + r.height + gap;
      } else if (r.y - gap - 80 >= 4) {
        x = r.x;
        y = Math.max(4, r.y - gap - Math.min(h, Math.round(vh * 0.5)));
      } else if (r.x + r.width + gap + w <= vw - 4) {
        x = r.x + r.width + gap;
        y = r.y;
      } else {
        x = r.x;
        y = r.y + r.height + gap;
      }
    } else if (r.x + r.width + gap + w <= vw - 4) {
      x = r.x + r.width + gap; // 右侧
      y = r.y;
    } else if (r.x - gap - w >= 4) {
      x = r.x - gap - w; // 左侧
      y = r.y;
    } else if (r.y + r.height + gap + 120 <= vh) {
      x = r.x; // 下方
      y = r.y + r.height + gap;
    } else if (r.y - gap - 120 >= 4) {
      x = r.x; // 上方
      y = Math.max(4, r.y - gap - Math.min(h, Math.round(vh * 0.5)));
    } else {
      x = vw - w - 8; // 实在放不下 → 右上角
      y = 8;
    }
    x = clamp(x, 4, vw - w - 4);
    y = clamp(y, 4, vh - 60);
    aiPanel.style.left = Math.round(x) + 'px';
    aiPanel.style.top = Math.round(y) + 'px';
    aiPanel.style.maxHeight = Math.round(Math.min(vh * 0.7, vh - y - 8)) + 'px';
  }
  function closeAIPanelDom() {
    if (aiPanel && aiPanel.parentNode) aiPanel.parentNode.removeChild(aiPanel);
    aiPanel = null;
    S.aiBody = null;
    S.aiLiveEl = null;
  }
  function closeAIPanel() {
    aiCancelStream(); // 关面板时取消在途流，别让它在主进程空跑烧额度
    S.aiOpen = false;
    S.aiBusy = false;
    closeAIPanelDom();
    if (S.rect && !S.finished) {
      toolbar.hidden = false;
      positionToolbar();
    }
  }

  // ================= 键盘 =================
  document.addEventListener('keydown', function (e) {
    // 文字编辑中由 textInput 自己处理
    if (!textInput.hidden) return;
    if (S.finished) return;

    var meta = e.metaKey || e.ctrlKey;

    // 删除选中标注（不影响整屏取消）
    if ((e.key === 'Delete' || e.key === 'Backspace') && S.selected) {
      e.preventDefault();
      deleteSelected();
      return;
    }

    if (e.key === 'Escape') {
      e.preventDefault();
      // 内联 AI 面板打开时，Esc 先关面板（不关整个截图）
      if (S.aiOpen) {
        closeAIPanel();
        return;
      }
      // 有选中标注时，Esc 先取消选中而非关闭截图
      if (S.tool === 'select' && S.selected) {
        setSelected(null);
        return;
      }
      doCancel();
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (S.rect && !toolbar.hidden) {
        var da = S.defaultAction || 'copy';
        if (da === 'ask' || da === 'translate' || da === 'polish') openInlineAI(da);
        else finishAction(da);
      }
      return;
    }
    // 撤销 / 重做
    if (meta && (e.key === 'z' || e.key === 'Z')) {
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
      return;
    }
    if (meta && (e.key === 'y' || e.key === 'Y')) {
      e.preventDefault();
      redo();
      return;
    }
    // V：切换选择/移动工具
    if (!meta && (e.key === 'v' || e.key === 'V') && !toolbar.hidden) {
      e.preventDefault();
      selectTool('select');
      return;
    }

    // C：复制光标下像素颜色（Shift 按住取 HEX，否则 RGB）——PixPin 式取色
    if (!meta && (e.key === 'c' || e.key === 'C')) {
      if (S.aiOpen || S.finished) return;
      if (!S.bgReady || !S.bgImage) return;
      e.preventDefault();
      var c = colorAt(S.lastMouse.x, S.lastMouse.y);
      if (!c) {
        showTip('光标位置取不到颜色');
        return;
      }
      var fmt = colorStr(c, e.shiftKey);
      Promise.resolve(kkapi.copyText(fmt))
        .then(function () {
          showTip('已复制 ' + fmt);
        })
        .catch(function () {
          showTip('复制失败');
        });
      return;
    }

    // < > ：浏览截图历史；R / Shift+R：载入最近选区（PixPin 式）
    if (!meta && (e.key === '<' || (e.key === ',' && e.shiftKey))) {
      if (S.aiOpen) return;
      e.preventDefault();
      browseHistory(-1);
      return;
    }
    if (!meta && (e.key === '>' || (e.key === '.' && e.shiftKey))) {
      if (S.aiOpen) return;
      e.preventDefault();
      browseHistory(1);
      return;
    }
    if (!meta && (e.key === 'r' || e.key === 'R')) {
      if (S.aiOpen || S.selecting || S.dragMode || S.drawing) return;
      e.preventDefault();
      applyRecentRect(e.shiftKey ? 1 : -1);
      return;
    }

    // 方向键：选框 1px 微调（PixPin 式）
    //   方向键            → 整体移动 1px
    //   Shift + 方向键    → 对应边收缩 1px
    //   Ctrl/Cmd + 方向键 → 对应边扩展 1px
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      if (S.aiOpen || S.selecting || S.dragMode) return;
      if (!S.rect || toolbar.hidden) return;
      e.preventDefault();
      var delta = e.shiftKey ? -1 : meta ? 1 : 0;
      nudgeRect(e.key, delta);
      return;
    }
  });

  // 键盘 1px 微调选区：delta 0=移动；-1=收缩对应边；+1=扩展对应边
  function nudgeRect(key, delta) {
    if (!S.rect) return;
    // 译文层不随选区微调，先清除避免错位残留（与拖动/缩放一致）
    if (typeof clearInlineTranslate === 'function') clearInlineTranslate();
    var r = S.rect;
    if (delta === 0) {
      var dx = key === 'ArrowLeft' ? -1 : key === 'ArrowRight' ? 1 : 0;
      var dy = key === 'ArrowUp' ? -1 : key === 'ArrowDown' ? 1 : 0;
      S.rect = {
        x: clamp(r.x + dx, 0, S.displayCssW - r.width),
        y: clamp(r.y + dy, 0, S.displayCssH - r.height),
        width: r.width,
        height: r.height,
      };
    } else {
      var edge = key === 'ArrowLeft' ? 'w' : key === 'ArrowRight' ? 'e' : key === 'ArrowUp' ? 'n' : 's';
      var left = r.x;
      var top = r.y;
      var right = r.x + r.width;
      var bottom = r.y + r.height;
      if (edge === 'w') left += delta;
      else if (edge === 'e') right += delta;
      else if (edge === 'n') top += delta;
      else bottom += delta;
      var MIN = 3; // 与最终选区最小尺寸一致
      if (right - left < MIN) {
        if (edge === 'w') left = right - MIN;
        else right = left + MIN;
      }
      if (bottom - top < MIN) {
        if (edge === 'n') top = bottom - MIN;
        else bottom = top + MIN;
      }
      left = clamp(left, 0, S.displayCssW);
      right = clamp(right, 0, S.displayCssW);
      top = clamp(top, 0, S.displayCssH);
      bottom = clamp(bottom, 0, S.displayCssH);
      var ox = r.x;
      var oy = r.y;
      S.rect = { x: left, y: top, width: right - left, height: bottom - top };
      // 原点变化时把标注反向平移，保持锚定在原底图内容上（与鼠标缩放一致）
      shiftShapes(ox - S.rect.x, oy - S.rect.y);
    }
    updateSelectionView();
    positionToolbar();
    scanQr();
    // 键盘微调后可立即用 C 取色：把放大镜刷到当前位置
    var lm = S.lastMouse;
    if ((!S.tool || S.tool === 'select') && S.bgImage && !toolbar.hidden) {
      showMagnifier({ clientX: lm.x, clientY: lm.y, shiftKey: false });
    }
  }

  // 比例锁定 / 圆角开关
  btnRatioLock.addEventListener('click', function () {
    if (S.ratioLock) {
      S.ratioLock = 0;
    } else {
      S.ratioLock = S.rect && S.rect.height > 0 ? S.rect.width / S.rect.height : 1;
    }
    btnRatioLock.classList.toggle('active', !!S.ratioLock);
  });
  btnRounded.addEventListener('click', function () {
    S.rounded = !S.rounded;
    btnRounded.classList.toggle('active', S.rounded);
    updateSelectionView(); // 选区预览同步圆角
  });
  // ================= 截图历史浏览 / 选区历史（PixPin 式 < > / R）=================
  function resetForHistoryImage(notice) {
    S.rect = null;
    S.shapes = [];
    S.history = [];
    S.redoStack = [];
    S.selected = null;
    S.numberSeq = 1;
    toolbar.hidden = true;
    S.qrData = null;
    btnQR.hidden = true;
    hideQrPanel();
    updateSelectionView();
    hint.hidden = false;
    hint.textContent = notice;
  }
  function loadHistoryImage(dataURL, notice) {
    var img = new Image();
    img.onload = function () {
      // 历史截图多为区域裁剪图：等比 contain 居中铺到全屏画布上，四周留黑边，
      // 这样选区/裁剪/放大镜/取色的坐标系全部保持不变。
      var phys = dpr();
      var W = Math.round(S.displayCssW * phys);
      var H = Math.round(S.displayCssH * phys);
      bgCanvas.width = W;
      bgCanvas.height = H;
      bgCtx.fillStyle = '#000';
      bgCtx.fillRect(0, 0, W, H);
      var iw = img.naturalWidth || 1;
      var ih = img.naturalHeight || 1;
      var r = Math.min(W / iw, H / ih);
      var dw = Math.max(1, Math.round(iw * r));
      var dh = Math.max(1, Math.round(ih * r));
      bgCtx.drawImage(img, Math.round((W - dw) / 2), Math.round((H - dh) / 2), dw, dh);
      S.bgImage = img;
      S.bgReady = true;
      resetForHistoryImage(notice);
    };
    img.onerror = function () {
      hint.hidden = false;
      hint.textContent = '历史图片加载失败';
    };
    img.src = dataURL;
  }
  async function browseHistory(dir) {
    if (S.aiOpen || S.selecting || S.dragMode || S.drawing) return;
    try {
      if (!S.histItems) {
        S.histItems = await kkapi.historyList();
        if (!Array.isArray(S.histItems)) S.histItems = [];
        S.histIdx = -1;
      }
      var n = S.histItems.length;
      if (!n) {
        showTip('暂无历史截图');
        return;
      }
      var next = S.histIdx + dir;
      if (next >= n) {
        showTip('已是最后一张');
        return;
      }
      if (next < -1) {
        showTip('已回到当前截图');
        return;
      }
      S.histIdx = next;
      if (next === -1) {
        // 回到当前截图：重新铺当前底图
        if (S.payload && S.payload.dataURL) {
          loadHistoryImage(S.payload.dataURL, '已回到当前截图 · < > 切换历史');
        }
        return;
      }
      var got = await kkapi.historyGet(S.histItems[next].id);
      if (!got || !got.dataURL) {
        showTip('这张历史图不可用');
        return;
      }
      loadHistoryImage(got.dataURL, '历史截图 ' + (next + 1) + '/' + n + ' · < > 切换 · Esc 返回');
    } catch (err) {
      showTip('历史浏览失败：' + ((err && err.message) || err));
    }
  }
  function recordRecentRect() {
    if (!S.rect) return;
    S.recentRects.push({ x: S.rect.x, y: S.rect.y, width: S.rect.width, height: S.rect.height });
    if (S.recentRects.length > 10) S.recentRects.shift();
    S.rectHistIdx = -1;
  }
  function applyRecentRect(step) {
    if (!S.recentRects.length) {
      showTip('暂无选区历史');
      return;
    }
    var idx = S.rectHistIdx + step;
    if (idx >= S.recentRects.length) idx = 0;
    if (idx < 0) idx = S.recentRects.length - 1;
    S.rectHistIdx = idx;
    var r = S.recentRects[idx];
    S.rect = { x: r.x, y: r.y, width: r.width, height: r.height };
    S.shapes = [];
    S.history = [];
    S.redoStack = [];
    S.selected = null;
    if (typeof clearInlineTranslate === 'function') clearInlineTranslate();
    updateSelectionView();
    toolbar.hidden = false;
    positionToolbar();
    scanQr();
    showTip('载入选区 ' + (idx + 1) + '/' + S.recentRects.length);
  }
  bindQrPanel();

  // 右键 → 取消
  document.addEventListener('contextmenu', function (e) {
    e.preventDefault();
    // 内联 AI 面板打开时，右键应只关面板（与 Esc 一致），不要取消整张截图、丢掉选区和标注。
    if (S.aiOpen) { closeAIPanel(); return; }
    doCancel();
  });

  // 防止拖拽选中、原生拖图
  document.addEventListener('dragstart', function (e) {
    e.preventDefault();
  });

  // 窗口卸载时取消监听
  window.addEventListener('beforeunload', function () {
    if (typeof off === 'function') off();
  });
})();
