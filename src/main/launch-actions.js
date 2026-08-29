'use strict';

const CAPTURE_MODES = new Set(['region', 'fullscreen', 'window', 'ocr', 'long', 'record']);

function readOption(argv, name) {
  const values = [];
  const prefix = `--${name}=`;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === `--${name}`) {
      const next = argv[index + 1];
      if (typeof next !== 'string' || !next || next.startsWith('--')) {
        throw new Error(`--${name} 缺少${name === 'capture' ? '模式' : '参数'}。`);
      }
      values.push(next);
      index += 1;
    } else if (typeof argument === 'string' && argument.startsWith(prefix)) {
      const value = argument.slice(prefix.length);
      if (!value) throw new Error(`--${name} 缺少${name === 'capture' ? '模式' : '参数'}。`);
      values.push(value);
    }
  }
  if (values.length > 1) throw new Error(`--${name} 只能指定一次。`);
  return values.length ? values[0] : null;
}

function parseLaunchAction(input) {
  const argv = Array.isArray(input) ? input.map((value) => String(value)) : [];
  if (argv.length > 256 || argv.some((value) => value.length > 8192)) {
    throw new Error('启动参数过多或过长。');
  }

  const mode = readOption(argv, 'capture');
  const delayText = readOption(argv, 'delay');
  if (!mode && delayText == null) return null;
  if (!mode) throw new Error('--delay 必须同时指定 --capture。');
  if (!CAPTURE_MODES.has(mode)) throw new Error(`截图模式无效：${mode}`);

  if (delayText != null) {
    if (!['region', 'fullscreen'].includes(mode)) {
      throw new Error('延时截图只支持区域或全屏模式。');
    }
    if (!/^\d+$/.test(delayText)) throw new Error('延时秒数必须是整数。');
    const delay = Number(delayText);
    if (!Number.isSafeInteger(delay) || delay < 1 || delay > 300) {
      throw new Error('延时秒数必须在 1 到 300 之间。');
    }
    return { type: 'timed', mode, delay };
  }

  return { type: 'capture', mode };
}

module.exports = { CAPTURE_MODES, parseLaunchAction };
