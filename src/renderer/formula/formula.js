(function () {
  'use strict';

  var model = window.FormulaModel;
  var input = document.getElementById('formulaInput');
  var preview = document.getElementById('formulaPreview');
  var errorEl = document.getElementById('formulaError');
  var fontSize = document.getElementById('fontSize');
  var fontSizeValue = document.getElementById('fontSizeValue');
  var color = document.getElementById('textColor');
  var background = document.getElementById('background');
  var createButton = document.getElementById('btnCreate');
  var previewMarkup = '';
  var previewTimer = null;

  function showError(error) {
    previewMarkup = '';
    preview.hidden = true;
    errorEl.hidden = false;
    errorEl.textContent = String((error && error.message) || error || '公式无法渲染。').slice(0, 500);
    createButton.disabled = true;
  }

  function renderPreview() {
    if (!model || !window.katex) {
      showError('本地 KaTeX 组件未加载。');
      return;
    }
    try {
      previewMarkup = model.renderFormulaMathML(window.katex, input.value);
      preview.innerHTML = previewMarkup;
      preview.style.fontSize = fontSize.value + 'px';
      preview.style.color = color.value;
      preview.style.background = background.value;
      fontSizeValue.textContent = fontSize.value;
      preview.hidden = false;
      errorEl.hidden = true;
      createButton.disabled = false;
    } catch (error) {
      showError(error);
    }
  }

  function schedulePreview() {
    if (previewTimer) clearTimeout(previewTimer);
    previewTimer = setTimeout(renderPreview, 80);
  }

  function decodeImage(dataURL) {
    return new Promise(function (resolve, reject) {
      var image = new Image();
      image.onload = function () { resolve(image); };
      image.onerror = function () { reject(new Error('公式图片栅格化失败。')); };
      image.src = dataURL;
    });
  }

  async function createPin() {
    if (!previewMarkup || createButton.disabled) return;
    var bridge = window.kkapi;
    if (!bridge || typeof bridge.createFormulaPin !== 'function') {
      showError('当前版本不支持公式贴图。');
      return;
    }
    createButton.disabled = true;
    createButton.textContent = '正在生成…';
    try {
      // scrollWidth/scrollHeight 取渲染后的实际内容尺寸，再由纯函数加安全边界和 2x 清晰度。
      var width = Math.max(32, Math.ceil(preview.scrollWidth));
      var height = Math.max(32, Math.ceil(preview.scrollHeight));
      var svg = model.buildFormulaSvg(previewMarkup, width, height, {
        fontSize: Number(fontSize.value),
        color: color.value,
        background: background.value,
        scale: 2,
      });
      var image = await decodeImage(model.toSvgDataURL(svg));
      var canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth || image.width;
      canvas.height = image.naturalHeight || image.height;
      var context = canvas.getContext('2d');
      if (!context) throw new Error('无法创建公式图片画布。');
      context.drawImage(image, 0, 0);
      var result = await bridge.createFormulaPin(canvas.toDataURL('image/png'));
      if (!result || result.ok !== true) throw new Error((result && result.error) || '公式贴图创建失败。');
      createButton.textContent = '已贴到屏幕';
      setTimeout(function () { createButton.textContent = '生成并贴到屏幕'; }, 1200);
    } catch (error) {
      showError(error);
    } finally {
      if (previewMarkup) createButton.disabled = false;
      if (createButton.textContent === '正在生成…') createButton.textContent = '生成并贴到屏幕';
    }
  }

  input.addEventListener('input', schedulePreview);
  [fontSize, color, background].forEach(function (control) { control.addEventListener('input', renderPreview); });
  createButton.addEventListener('click', createPin);
  document.getElementById('btnClose').addEventListener('click', function () {
    if (window.kkapi && typeof window.kkapi.closeSelf === 'function') window.kkapi.closeSelf();
  });
  document.addEventListener('keydown', function (event) {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      createPin();
    } else if (event.key === 'Escape') {
      if (window.kkapi && typeof window.kkapi.closeSelf === 'function') window.kkapi.closeSelf();
    }
  });
  renderPreview();
})();
