const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeFormulaInput,
  renderFormulaMathML,
  buildFormulaSvg,
  toSvgDataURL,
} = require('../src/renderer/formula/formula-model');

test('formula input is bounded and normalized without accepting empty documents', () => {
  assert.equal(normalizeFormulaInput('  x^2 + y^2  '), 'x^2 + y^2');
  assert.throws(() => normalizeFormulaInput('   '), /公式/);
  assert.throws(() => normalizeFormulaInput('x'.repeat(4001)), /过长/);
  assert.throws(() => normalizeFormulaInput('x\0y'), /公式/);
});

test('KaTeX rendering is strict, trust-disabled, and MathML-only', () => {
  let received = null;
  const fakeKatex = {
    renderToString(tex, options) {
      received = { tex, options };
      return '<span class="katex"><math><mi>x</mi></math></span>';
    },
  };
  const markup = renderFormulaMathML(fakeKatex, 'x');
  assert.match(markup, /<math/);
  assert.deepEqual(received, {
    tex: 'x',
    options: { output: 'mathml', throwOnError: true, strict: 'error', trust: false },
  });
});

test('formula SVG is self-contained and rejects active or externally loaded markup', () => {
  const math = '<span class="katex"><math><mi>x</mi></math></span>';
  const svg = buildFormulaSvg(math, 320, 120, { color: '#112233', background: 'transparent' });
  assert.match(svg, /^<svg[^>]+xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.match(svg, /<foreignObject/);
  assert.match(svg, /#112233/);
  assert.doesNotMatch(svg, /https?:\/\/(?!www\.w3\.org)/);
  assert.match(toSvgDataURL(svg), /^data:image\/svg\+xml;charset=utf-8,/);
  assert.throws(() => buildFormulaSvg('<script>alert(1)</script>', 100, 100), /标记/);
  assert.throws(() => buildFormulaSvg('<math><image href="https://example.com/x"\/><\/math>', 100, 100), /标记/);
});
