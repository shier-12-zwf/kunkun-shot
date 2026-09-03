const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const pinHtml = fs.readFileSync(path.join(root, 'src/renderer/pin/pin.html'), 'utf8');
const pinSource = fs.readFileSync(path.join(root, 'src/renderer/pin/pin.js'), 'utf8');
const formulaHtml = fs.readFileSync(path.join(root, 'src/renderer/formula/formula.html'), 'utf8');
const formulaSource = fs.readFileSync(path.join(root, 'src/renderer/formula/formula.js'), 'utf8');
const formulaModelSource = fs.readFileSync(path.join(root, 'src/renderer/formula/formula-model.js'), 'utf8');
const mainSource = fs.readFileSync(path.join(root, 'src/main/main.js'), 'utf8');
const windowsSource = fs.readFileSync(path.join(root, 'src/main/windows.js'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

test('pin transform UI exposes crop, 90-degree rotation and both flips', () => {
  assert.match(pinHtml, /pin-image-transform\.js/);
  assert.match(pinHtml, /data-act="crop"/);
  assert.match(pinHtml, /data-act="rotateCW"/);
  assert.match(pinHtml, /data-act="rotateCCW"/);
  assert.match(pinHtml, /data-act="flipHorizontal"/);
  assert.match(pinHtml, /data-act="flipVertical"/);
  assert.match(pinHtml, /id="pinCropLayer"/);
  assert.match(pinHtml, /id="btnApplyCrop"/);
  assert.match(pinSource, /pinReplaceImage/);
  assert.match(pinSource, /getPublishedRevision/);
  assert.match(pinSource, /transformImageData/);
});

test('pin group UI supports grouping current pins, hiding siblings and ungrouping', () => {
  assert.match(pinHtml, /data-act="groupAll"/);
  assert.match(pinHtml, /data-act="groupVisibility"/);
  assert.match(pinHtml, /data-act="ungroup"/);
  assert.match(pinSource, /pinGroupAction/);
  assert.match(pinSource, /msg\.cmd\s*===\s*['"]group-state['"]/);
  assert.match(windowsSource, /movePinGroup/);
  assert.match(windowsSource, /toggle-visibility/);
});

test('formula pin is an offline local KaTeX window with a narrow creation IPC', () => {
  assert.equal(typeof pkg.dependencies.katex, 'string');
  assert.match(formulaHtml, /node_modules\/katex\/dist\/katex\.min\.css/);
  assert.match(formulaHtml, /node_modules\/katex\/dist\/katex\.min\.js/);
  assert.doesNotMatch(formulaHtml, /https?:\/\//);
  assert.match(formulaModelSource, /renderToString/);
  assert.match(formulaModelSource, /output:\s*['"]mathml['"]/);
  assert.match(formulaModelSource, /trust:\s*false/);
  assert.match(formulaSource, /createFormulaPin/);
  assert.doesNotMatch(formulaSource, /\bfetch\s*\(/);
  assert.match(windowsSource, /function createFormula/);
  assert.match(mainSource, /LaTeX 公式贴图/);
  assert.match(mainSource, /\[C\.FORMULA_CREATE_PIN\]\s*:\s*\['formula'\]/);
});

test('KaTeX dependency renders representative formulas without network access', () => {
  const katex = require('katex');
  const output = katex.renderToString(String.raw`\frac{-b\pm\sqrt{b^2-4ac}}{2a}`, {
    output: 'mathml',
    throwOnError: true,
    strict: 'error',
    trust: false,
  });
  assert.match(output, /<math/);
  assert.match(output, /<mfrac/);
});
