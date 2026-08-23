'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const mainSource = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'main', 'main.js'),
  'utf8'
);
const settingsSource = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'renderer', 'main', 'pages', 'settings.js'),
  'utf8'
);
const aiPageSource = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'renderer', 'main', 'pages', 'ai.js'),
  'utf8'
);
const readmeZh = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
const readmeEn = fs.readFileSync(path.join(__dirname, '..', 'README_EN.md'), 'utf8');

function loadRouter(cfg) {
  const start = mainSource.indexOf('function openaiTextProvider(');
  const end = mainSource.indexOf('\nlet tray = null;', start);
  assert.ok(start >= 0 && end > start, 'AI provider router should remain discoverable for regression tests');
  const source = mainSource.slice(start, end);
  return Function('config', `${source}\nreturn aiProvider;`)({ get: () => cfg });
}

function configured(mode) {
  return {
    ai: { provider: mode },
    deepseek: {
      apiKey: 'deepseek-key',
      baseUrl: 'https://deepseek.example/v1',
      textModel: 'deepseek-text',
      visionModel: 'deepseek-vision-placeholder',
    },
    minimax: {
      apiKey: 'minimax-key',
      baseUrl: 'https://minimax.example/v1',
      textModel: 'minimax-text',
      visionModel: 'minimax-vision',
    },
    openai: {
      apiKey: 'openai-key',
      baseUrl: 'https://openai-compatible.example/v1',
      model: 'openai-text',
    },
  };
}

test('explicit providers never route a task to a different configured endpoint', () => {
  for (const mode of ['deepseek', 'minimax', 'openai']) {
    const cfg = configured(mode);
    const route = loadRouter(cfg);
    assert.equal(route(false).name, mode, `${mode} text must stay on ${mode}`);
    assert.equal(route(true).name, mode, `${mode} image/OCR flow must stay on ${mode}`);
  }
});

test('explicit provider missing configuration fails instead of using residual credentials', () => {
  for (const mode of ['deepseek', 'minimax', 'openai']) {
    const cfg = configured(mode);
    cfg[mode].apiKey = '';
    const route = loadRouter(cfg);
    assert.throws(
      () => route(false),
      new RegExp(`${mode === 'openai' ? 'OpenAI' : mode === 'deepseek' ? 'DeepSeek' : 'MiniMax'}.*API Key.*不会回退`),
      `${mode} must not fall back to another provider`
    );
  }
});

test('auto routing is deterministic: text uses DeepSeek and vision uses MiniMax', () => {
  const cfg = configured('auto');
  const route = loadRouter(cfg);
  assert.equal(route(false).name, 'deepseek');
  assert.equal(route(true).name, 'minimax');
});

test('auto routing fails closed when the task-specific provider is incomplete', () => {
  const noDeepSeek = configured('auto');
  noDeepSeek.deepseek.apiKey = '';
  assert.throws(
    () => loadRouter(noDeepSeek)(false),
    /智能分流.*DeepSeek.*API Key.*不会回退/
  );

  const noMiniMax = configured('auto');
  noMiniMax.minimax.apiKey = '';
  assert.throws(
    () => loadRouter(noMiniMax)(true),
    /智能分流.*MiniMax.*API Key.*不会回退/
  );
});

test('settings, AI workspace, and bilingual docs describe the same fixed auto route', () => {
  assert.match(settingsSource, /纯文字任务[^\n]+只用 DeepSeek/);
  assert.match(settingsSource, /看图任务[^\n]+只用 MiniMax/);
  assert.match(settingsSource, /缺少对应配置时会明确停止，不会改投其他服务商/);
  assert.match(settingsSource, /识别文字发给这里配置的端点，不会改投 DeepSeek 或 MiniMax/);
  assert.doesNotMatch(settingsSource, /文本可能走 openai/);
  assert.doesNotMatch(settingsSource, /识别文字发给 DeepSeek/);

  assert.match(aiPageSource, /“智能分流”采用固定路由/);
  assert.match(aiPageSource, /不会改投其他服务商/);
  assert.doesNotMatch(aiPageSource, /openai\(若配\)否则 deepseek/i);

  assert.match(readmeZh, /纯文本任务只发往 DeepSeek，看图任务只发往 MiniMax/);
  assert.match(readmeEn, /text-only tasks go only to DeepSeek and vision tasks go only to MiniMax/);
});
