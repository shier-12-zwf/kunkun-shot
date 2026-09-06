(() => {
  'use strict';
  const get = (id) => document.getElementById(id);
  let currentLayout = null;
  let previewGeneration = 0;
  let selection = null;
  let display = null;
  let guideOffset = { x: 0, y: 0 };

  function place(element, rect) {
    element.style.left = (rect.x + guideOffset.x) + 'px';
    element.style.top = (rect.y + guideOffset.y) + 'px';
    element.style.width = Math.max(0, rect.width) + 'px';
    element.style.height = Math.max(0, rect.height) + 'px';
  }

  function placeSelection() {
    const r = selection;
    const d = display;
    if (!r || !d) return;
    place(get('selectionOutline'), r);
    get('selectionOutline').hidden = false;
    place(get('shadeTop'), { x: 0, y: 0, width: d.width, height: r.y });
    place(get('shadeBottom'), { x: 0, y: r.y + r.height, width: d.width, height: d.height - r.y - r.height });
    place(get('shadeLeft'), { x: 0, y: r.y, width: r.x, height: r.height });
    place(get('shadeRight'), { x: r.x + r.width, y: r.y, width: d.width - r.x - r.width, height: r.height });
  }

  function applyLayout(layout) {
    if (!layout) return;
    currentLayout = layout;
    get('previewPanel').hidden = !layout.preview;
    if (layout.preview) place(get('previewPanel'), layout.preview);
  }

  function update(state) {
    if (!state) return;
    if (Number.isFinite(state.guideOffset?.x) && Number.isFinite(state.guideOffset?.y)) {
      guideOffset = { ...state.guideOffset };
      placeSelection();
      if (currentLayout) applyLayout(currentLayout);
    }
    if (state.layout) applyLayout(state.layout);
    if (Number.isFinite(state.frameCount)) get('previewCount').textContent = state.frameCount + ' 帧';
    if (state.outputWidth > 0 && state.outputHeight > 0) {
      get('previewSize').textContent = state.outputWidth + ' × ' + state.outputHeight + ' px';
    }
    if (typeof state.capturing === 'boolean') get('previewTitle').textContent = state.capturing ? '实时拼接' : '已暂停';
    if (!Object.prototype.hasOwnProperty.call(state, 'previewDataURL')) return;
    const generation = ++previewGeneration;
    if (!state.previewDataURL) {
      get('previewImage').hidden = true;
      get('previewImage').removeAttribute('src');
      get('previewEmpty').hidden = false;
      return;
    }
    // 先解码再替换，避免滚动更新时闪出空白；迟到的旧缩略图不能覆盖新图。
    const next = new Image();
    next.onload = () => {
      if (generation !== previewGeneration) return;
      get('previewImage').src = next.src;
      get('previewImage').hidden = false;
      get('previewEmpty').hidden = true;
      get('previewPanel').hidden = !currentLayout || !currentLayout.preview;
    };
    next.src = state.previewDataURL;
  }

  kkapi.onInit((payload) => {
    if (!payload || !payload.rect) return;
    const r = payload.rect;
    const d = payload.displayBounds;
    if (!d || r.width <= 0 || r.height <= 0) return;
    selection = r;
    display = d;
    guideOffset = { x: 0, y: 0 };
    placeSelection();
    update({ ...payload.presentation, layout: payload.layout, guideOffset: payload.guideOffset });
  });
  kkapi.onLongshotUpdate(update);
})();
