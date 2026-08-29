'use strict';

const fs = require('node:fs');
const { SUPPORTED_OCR_LANGUAGES } = require('../shared/config-schema');

function listBundledOCRLanguages(directory, fsImpl) {
  const io = fsImpl || fs;
  let entries;
  try {
    entries = io.readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    throw new Error(`无法读取内置 OCR 语言目录：${error && error.message ? error.message : error}`);
  }

  return entries
    .filter((entry) => entry && typeof entry.isFile === 'function' && entry.isFile())
    .map((entry) => /^([a-z][a-z0-9_]{0,31})\.traineddata$/i.exec(String(entry.name || '')))
    .filter(Boolean)
    .map((match) => match[1])
    .sort((a, b) => a.localeCompare(b));
}

function normalizeBundledOCRLanguage(value, availableLanguages) {
  if (typeof value !== 'string' || !SUPPORTED_OCR_LANGUAGES.includes(value)) {
    throw new Error(`OCR 语言选择无效。仅支持：${SUPPORTED_OCR_LANGUAGES.join('、')}`);
  }

  const available = new Set(Array.isArray(availableLanguages) ? availableLanguages : []);
  for (const code of value.split('+')) {
    if (!available.has(code)) throw new Error(`未安装 OCR 语言数据：${code}`);
  }
  return value;
}

module.exports = {
  listBundledOCRLanguages,
  normalizeBundledOCRLanguage,
};
