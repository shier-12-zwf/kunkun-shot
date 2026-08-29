'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  listBundledOCRLanguages,
  normalizeBundledOCRLanguage,
} = require('../src/main/ocr-languages');
const { SUPPORTED_OCR_LANGUAGES } = require('../src/shared/config-schema');

test('bundled OCR languages are enumerated only from regular traineddata files', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kk-ocr-langs-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'chi_sim.traineddata'), 'zh');
  fs.writeFileSync(path.join(dir, 'eng.traineddata'), 'en');
  fs.writeFileSync(path.join(dir, 'README.txt'), 'ignore');
  fs.symlinkSync(path.join(dir, 'eng.traineddata'), path.join(dir, 'fra.traineddata'));

  assert.deepEqual(listBundledOCRLanguages(dir), ['chi_sim', 'eng']);
});

test('OCR language selection accepts only shipped combinations and verifies every required file', () => {
  assert.deepEqual(SUPPORTED_OCR_LANGUAGES, ['chi_sim+eng', 'chi_sim', 'eng']);
  for (const lang of SUPPORTED_OCR_LANGUAGES) {
    assert.equal(normalizeBundledOCRLanguage(lang, ['chi_sim', 'eng']), lang);
  }
  assert.throws(
    () => normalizeBundledOCRLanguage('chi_sim+jpn', ['chi_sim', 'eng']),
    /OCR.*语言/,
  );
  assert.throws(
    () => normalizeBundledOCRLanguage('eng+chi_sim', ['chi_sim', 'eng']),
    /OCR.*语言/,
  );
  assert.throws(
    () => normalizeBundledOCRLanguage('chi_sim+eng+chi_sim', ['chi_sim', 'eng']),
    /OCR.*语言/,
  );
  assert.throws(
    () => normalizeBundledOCRLanguage('chi_sim+eng', ['eng']),
    /未安装.*chi_sim/,
  );
  assert.throws(
    () => normalizeBundledOCRLanguage('', ['chi_sim', 'eng']),
    /OCR.*语言/,
  );
});

test('settings and release docs expose a closed offline OCR contract', () => {
  const root = path.join(__dirname, '..');
  const settings = fs.readFileSync(path.join(root, 'src/renderer/main/pages/settings.js'), 'utf8');
  const readmeZh = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  const readmeEn = fs.readFileSync(path.join(root, 'README_EN.md'), 'utf8');
  const releaseChecklist = fs.readFileSync(path.join(root, 'docs/RELEASE_CHECKLIST.md'), 'utf8');

  assert.match(settings, /const selOcrLang = h\('select'/);
  assert.doesNotMatch(settings, /const inLang = h\('input'/);
  for (const lang of SUPPORTED_OCR_LANGUAGES) assert.match(settings, new RegExp(lang.replace('+', '\\+')));

  assert.match(readmeZh, /缺失[^\n]*明确失败[^\n]*(?:绝不|不会)[^\n]*(?:CDN|网络)/i);
  assert.doesNotMatch(readmeZh, /OCR[^\n]*可能回退[^\n]*网络/i);
  assert.match(readmeEn, /missing[^\n]*fail[^\n]*(?:never|no)[^\n]*(?:CDN|network)/i);
  assert.doesNotMatch(readmeEn, /OCR[^\n]*may fall back[^\n]*network/i);
  assert.match(releaseChecklist, /语言包缺失[^\n]*明确失败[^\n]*(?:绝不|不会)[^\n]*(?:CDN|网络)/i);
  assert.match(releaseChecklist, /missing[^\n]*explicit[^\n]*fail[^\n]*(?:never|no)[^\n]*(?:CDN|network)/i);
});
