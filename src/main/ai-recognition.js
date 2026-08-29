'use strict';

// AI 表格 / 公式识别的主进程信任边界。
//
// 渲染层只能选择一个受支持的任务模式，不能传 prompt。固定提示词
// 留在主进程，避免被注入后把截图用于任意请求。这两项能力是 AI 辅助识别：
// 视觉提供方直接看图；纯文本提供方仅接收本地 OCR 的文本。

const {
  requireImageDataURL,
  normalizeStreamId,
} = require('./ipc-validation');

const RECOGNITION_TASKS = Object.freeze({
  table: Object.freeze({
    label: 'AI 表格识别',
    prompt: [
      '你是 AI 表格识别助手。只识别图片中的表格，不要补写图中没有的单元格或数据。',
      '结构规则：普通表格输出 GitHub Flavored Markdown 表格；只有在 Markdown 不能忠实表达时，才输出一个 ```csv 代码块。',
      '保留原始行列顺序、数字、单位和空单元格。看不清的内容写作 [无法识别]。',
      '只输出 Markdown 表格或 CSV，不要解释、总结或猜测。',
    ].join('\n'),
    textPrompt: [
      '你正在做 AI 表格识别，但当前提供方不支持看图，下方只有本地 OCR 文本。',
      'OCR 文本可能丢失单元格坐标，不得声称完美恢复了复杂跨行/跨列结构。',
      '若能可靠恢复，只输出 GitHub Flavored Markdown 表格，或在 Markdown 无法忠实表达时输出一个 ```csv 代码块。',
      '若信息不足，明确输出“无法可靠恢复表格结构”，不要猜测。',
    ].join('\n'),
  }),
  formula: Object.freeze({
    label: 'AI 公式识别',
    prompt: [
      '你是 AI 数学公式识别助手。把图片中的公式转写为 LaTeX。',
      '保留上下标、分数、根号、矩阵、分段函数、等号和换行结构。',
      '只输出 LaTeX，不要解题、解释或猜测。对不确定或无法识别的局部使用 \\text{[无法识别]}。',
    ].join('\n'),
    textPrompt: [
      '你正在做 AI 公式识别，但当前提供方不支持看图，下方只有本地 OCR 文本。',
      '将可确认的公式转写为 LaTeX；不要解题或补全丢失的符号。',
      '只输出 LaTeX。对不确定或无法识别的局部使用 \\text{[无法识别]}。',
    ].join('\n'),
  }),
});

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeAIRecognitionRequest(payload) {
  if (!isPlainObject(payload)) throw new Error('AI 识别请求无效。');
  const allowed = new Set(['mode', 'dataURL', 'streamId']);
  for (const key of Object.keys(payload)) {
    if (!allowed.has(key)) throw new Error(`AI 识别请求包含不支持字段：${key}`);
  }
  const mode = typeof payload.mode === 'string' ? payload.mode : '';
  if (!Object.prototype.hasOwnProperty.call(RECOGNITION_TASKS, mode)) {
    throw new Error('AI 识别模式无效。');
  }
  return {
    mode,
    dataURL: requireImageDataURL(payload.dataURL),
    streamId: normalizeStreamId(payload.streamId),
  };
}

function retryableFailure(mode, route, message, send) {
  const error = String(message || 'AI 识别失败。');
  if (typeof send === 'function') send({ error });
  return { ok: false, mode, route, retryable: true, error };
}

async function executeAIRecognition(rawRequest, dependencies) {
  const request = normalizeAIRecognitionRequest(rawRequest);
  const deps = dependencies || {};
  const provider = deps.provider;
  if (!isPlainObject(provider)) throw new Error('AI 提供方无效。');
  if (typeof deps.downscaleDataURL !== 'function') throw new Error('AI 图片缩放依赖缺失。');
  if (typeof deps.stream !== 'function') throw new Error('AI 流式请求依赖缺失。');

  const task = RECOGNITION_TASKS[request.mode];
  if (provider.vision) {
    if (typeof deps.imageMessage !== 'function') throw new Error('AI 视觉消息依赖缺失。');
    const image = deps.downscaleDataURL(request.dataURL, 2048);
    await deps.stream({
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      model: provider.visionModel,
      messages: [deps.imageMessage(task.prompt, image)],
      think: false,
    });
    return { ok: true, mode: request.mode, route: 'vision' };
  }

  if (typeof deps.recognize !== 'function') throw new Error('AI 本地 OCR 依赖缺失。');
  let text;
  try {
    const image = deps.downscaleDataURL(request.dataURL, 4096);
    text = await deps.recognize(image, deps.language);
  } catch (error) {
    return retryableFailure(
      request.mode,
      'ocr-text',
      '本地 OCR 失败：' + ((error && error.message) || String(error)),
      deps.send
    );
  }
  if (!text || !String(text).trim()) {
    return retryableFailure(
      request.mode,
      'ocr-text',
      '未识别到文字。当前 AI 提供方不支持看图，无法可靠恢复表格或公式；可切换到视觉提供方或重新框选后重试。',
      deps.send
    );
  }

  await deps.stream({
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    model: provider.textModel,
    messages: [{
      role: 'user',
      content: task.textPrompt + '\n\n【本地 OCR 文本】\n' + String(text).trim(),
    }],
    think: false,
  });
  return { ok: true, mode: request.mode, route: 'ocr-text' };
}

// 给 main.js 的薄适配层：只负责把 Electron sender / streamId 绑定到纯逻辑。
// IPC 注册和 sender URL allowlist 仍由 main.js 统一管理。
function createAIRecognitionHandler(dependencies) {
  const deps = dependencies || {};
  if (typeof deps.streamChannel !== 'string' || !deps.streamChannel) {
    throw new Error('AI 流式通道缺失。');
  }
  if (typeof deps.aiProvider !== 'function') throw new Error('AI 提供方依赖缺失。');
  if (typeof deps.getLanguage !== 'function') throw new Error('OCR 语言依赖缺失。');
  if (typeof deps.downscaleDataURL !== 'function') throw new Error('AI 图片缩放依赖缺失。');
  if (typeof deps.imageMessage !== 'function') throw new Error('AI 视觉消息依赖缺失。');
  if (typeof deps.recognize !== 'function') throw new Error('AI 本地 OCR 依赖缺失。');
  if (typeof deps.streamWithAbort !== 'function') throw new Error('AI 流式请求依赖缺失。');

  return async function handleAIRecognition(event, payload) {
    const request = normalizeAIRecognitionRequest(payload);
    const sender = event && event.sender;
    if (!sender || typeof sender.send !== 'function') throw new Error('AI 请求发起方无效。');

    const send = (streamEvent) => {
      if (typeof sender.isDestroyed === 'function' && sender.isDestroyed()) return;
      sender.send(deps.streamChannel, { ...(streamEvent || {}), streamId: request.streamId });
    };

    return executeAIRecognition(request, {
      provider: deps.aiProvider(true),
      language: deps.getLanguage(),
      downscaleDataURL: deps.downscaleDataURL,
      imageMessage: deps.imageMessage,
      recognize: deps.recognize,
      stream: (options) => deps.streamWithAbort(
        request.streamId,
        sender,
        options,
        send
      ),
      send,
    });
  };
}

module.exports = {
  RECOGNITION_TASKS,
  normalizeAIRecognitionRequest,
  executeAIRecognition,
  createAIRecognitionHandler,
};
