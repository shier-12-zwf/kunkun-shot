(function (root, factory) {
  'use strict';
  var exported = factory();
  if (typeof module === 'object' && module.exports) module.exports = exported;
  if (root) root.FormulaModel = exported;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function normalizeFormulaInput(value) {
    if (typeof value !== 'string' || value.indexOf('\0') !== -1) throw new Error('公式内容无效。');
    var normalized = value.trim();
    if (!normalized) throw new Error('请输入 LaTeX 公式。');
    if (normalized.length > 4000) throw new Error('LaTeX 公式过长（最多 4000 字符）。');
    return normalized;
  }

  function renderFormulaMathML(katexApi, input) {
    if (!katexApi || typeof katexApi.renderToString !== 'function') {
      throw new Error('本地公式渲染组件未加载。');
    }
    var tex = normalizeFormulaInput(input);
    var output = katexApi.renderToString(tex, {
      output: 'mathml',
      throwOnError: true,
      strict: 'error',
      trust: false,
    });
    if (typeof output !== 'string' || output.length > 1024 * 1024 || !/<math(?:\s|>)/i.test(output)) {
      throw new Error('公式渲染结果无效。');
    }
    return output;
  }

  function requireMarkup(value) {
    if (typeof value !== 'string' || !value || value.length > 1024 * 1024 || !/<math(?:\s|>)/i.test(value)) {
      throw new Error('公式标记无效。');
    }
    // 公式标记只能来自 trust:false 的本地 KaTeX。这里再拒绝主动内容和任何资源加载属性，
    // 保证 SVG rasterize 过程不会把 renderer 变成网络或脚本入口。
    if (
      /<(?:script|iframe|object|embed|foreignObject)\b/i.test(value) ||
      /\son[a-z]+\s*=/i.test(value) ||
      /\s(?:href|src|xlink:href)\s*=/i.test(value)
    ) throw new Error('公式标记包含不安全内容。');
    return value;
  }

  function safeDimension(value, label) {
    var number = Number(value);
    if (!Number.isFinite(number)) throw new Error(label + '无效。');
    return Math.max(32, Math.min(4096, Math.ceil(number)));
  }

  function safeColor(value, fallback, allowTransparent) {
    if (allowTransparent && value === 'transparent') return value;
    return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;
  }

  function buildFormulaSvg(rawMarkup, rawWidth, rawHeight, options) {
    var markup = requireMarkup(rawMarkup);
    var width = safeDimension(rawWidth, '公式宽度');
    var height = safeDimension(rawHeight, '公式高度');
    options = options && typeof options === 'object' ? options : {};
    var scaleValue = Number(options.scale);
    var scale = Number.isFinite(scaleValue) ? Math.max(1, Math.min(3, scaleValue)) : 2;
    var pixelWidth = Math.ceil(width * scale);
    var pixelHeight = Math.ceil(height * scale);
    if (pixelWidth * pixelHeight > 36 * 1024 * 1024) throw new Error('公式图片尺寸过大。');
    var color = safeColor(options.color, '#111827', false);
    var background = safeColor(options.background, 'transparent', true);
    var fontSize = Number(options.fontSize);
    fontSize = Number.isFinite(fontSize) ? Math.max(14, Math.min(96, fontSize)) : 32;

    return '<svg xmlns="http://www.w3.org/2000/svg" width="' + pixelWidth + '" height="' + pixelHeight +
      '" viewBox="0 0 ' + width + ' ' + height + '">' +
      '<foreignObject x="0" y="0" width="' + width + '" height="' + height + '">' +
      '<div xmlns="http://www.w3.org/1999/xhtml" style="box-sizing:border-box;width:100%;height:100%;display:flex;' +
      'align-items:center;justify-content:center;padding:12px;background:' + background + ';color:' + color +
      ';font-size:' + fontSize + 'px;font-family:STIX Two Math,Cambria Math,Times New Roman,serif;overflow:hidden">' +
      markup + '</div></foreignObject></svg>';
  }

  function toSvgDataURL(svg) {
    if (typeof svg !== 'string' || !/^<svg\b/.test(svg) || svg.length > 2 * 1024 * 1024) {
      throw new Error('公式 SVG 无效。');
    }
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  }

  return {
    normalizeFormulaInput: normalizeFormulaInput,
    renderFormulaMathML: renderFormulaMathML,
    buildFormulaSvg: buildFormulaSvg,
    toSvgDataURL: toSvgDataURL,
  };
});
