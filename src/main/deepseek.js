// DeepSeek API 客户端（OpenAI 兼容）。使用 Node 内置 fetch + SSE 流式解析。
// 说明：图片多模态用 visionModel（默认 deepseek-v4-pro），纯文本用 textModel。
// 旧模型 deepseek-chat / deepseek-reasoner 官方已标注弃用且不支持图片，故默认使用 v4 系列。

const { normalizeProviderBaseUrl } = require('./ipc-validation');

const MAX_STREAM_BYTES = 4 * 1024 * 1024;
const MAX_ERROR_BODY_BYTES = 64 * 1024;
const MAX_MODEL_BODY_BYTES = 2 * 1024 * 1024;

function abortError() {
  const err = new Error('请求已中止。');
  err.name = 'AbortError';
  return err;
}

function readReaderChunk(reader, signal) {
  if (!signal) return reader.read();
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(abortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    reader.read().then(
      (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      },
      (err) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      }
    );
  });
}

async function readBoundedResponseText(response, maxBytes, signal, onWait) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let total = 0;
  let text = '';
  while (true) {
    if (onWait) onWait();
    const { value, done } = await readReaderChunk(reader, signal);
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      try { await reader.cancel(); } catch (_) {}
      throw new Error('服务端响应数据过大，已停止读取。');
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  return text;
}

// 把上游返回的原始错误（多为英文 JSON）翻成「中文原因 + 怎么办」。
// 既覆盖 MiniMax（authorized_error / base_resp.status_code 等），也兼容 OpenAI 风格的 error.code/message。
// 返回 null 表示没识别出已知错误，调用方退回原始文案。
function describeApiError({ provider, isMinimax, status, baseUrl, detail }) {
  const raw = String(detail || '');
  let msg = '';
  let code = '';
  try {
    const j = JSON.parse(raw);
    // MiniMax OpenAI 兼容错误：{ error: { type, message } }；原生错误：{ base_resp: { status_code, status_msg } }
    msg = (j && j.error && j.error.message) || (j && j.base_resp && j.base_resp.status_msg) || (typeof j.message === 'string' ? j.message : '') || '';
    code = String(
      (j && j.error && (j.error.code ?? '')) ||
      (j && j.base_resp && (j.base_resp.status_code ?? '')) ||
      ''
    );
  } catch (_) {
    msg = raw;
  }
  const hay = (raw + ' ' + msg).toLowerCase(); // 统一在「原始文本 + message」里搜关键词，鲁棒性更好
  const has = (...ks) => ks.some((k) => hay.includes(k));
  const tail = msg ? `（原始：${msg.slice(0, 140)}）` : '';

  // 1004 / 鉴权失败：本次截图就是这个。给出按概率排序的可操作清单。
  if (code === '1004' || status === 401 || has('carry the api secret key', 'authorized_error', 'login fail', 'invalid api key', 'unauthorized', '鉴权', '认证失败')) {
    if (isMinimax) {
      const cn = /minimaxi\.com/i.test(String(baseUrl || ''));
      const region = cn ? '国内站(api.minimaxi.com)' : '海外站(api.minimax.io)';
      const otherRegion = cn ? '海外站(api.minimax.io)' : '国内站(api.minimaxi.com)';
      return [
        `MiniMax 鉴权失败(1004)：密钥被拒。当前打的是${region}，请逐项排查：`,
        `① 套餐/Coding Plan 密钥（sk-cp- 开头）不能直连本接口，只能走 Coding Plan 专用端点——请改用「按量付费」接口密钥；`,
        `② 站点拿反：${region}只认本站密钥，若你的 key 是${otherRegion}申请的则不通用；`,
        `③ 密钥过期或复制残缺，去 platform.minimaxi.com 账户管理→接口密钥 重新生成。${tail}`,
      ].join('\n');
    }
    return `${provider} 鉴权失败(${status})：API Key 无效或已过期，请到对应平台重新生成并填入。${tail}`;
  }
  // 余额不足
  if (code === '1008' || has('insufficient balance', 'insufficient_quota', '余额不足', '欠费')) {
    return `${provider} 余额不足(${code || status})：请到平台充值后再试。${tail}`;
  }
  // 限流
  if (code === '1002' || code === '1039' || status === 429 || has('rate limit', 'too many requests', '限流', 'tpm', 'rpm')) {
    return `${provider} 触发限流(${code || status})：请稍后重试，或降低并发/升级配额。${tail}`;
  }
  // 参数错误：最常见是模型名写错（如把 MiniMax-M3 拼错）
  if (code === '2013' || status === 404 || has('invalid params', 'model not found', 'does not exist', '不存在', '参数错误', 'invalid model')) {
    return `${provider} 请求被拒(${code || status})：多为模型名填写有误。请确认模型名（MiniMax 用 MiniMax-M3）。${tail}`;
  }
  // 内容安全（注意：不能用裸子串 'content' 匹配，否则会把 "Invalid type for 'messages[0].content'"、
  // "Unsupported Content-Type" 等普通参数/格式错误误报成「内容安全拦截」——多模态/截图请求里这类 content 字段错误很常见）。
  if (code === '1027' || has('content_filter', 'content_policy', 'content management', 'risk control', '内容安全', '风控', 'sensitive')) {
    return `${provider} 内容安全拦截(${code || status})：本次内容被风控拦截。${tail}`;
  }
  return null; // 未识别 → 交回原始文案
}

// 统一的流式聊天。onEvent({ delta?, reasoning?, done?, error?, canceled? }) 持续回调。
// 可选 signal：外部 AbortSignal，触发后中止请求（用户切流/关窗）。
// 可选 idleTimeoutMs：空闲超时——连上后若长时间收不到新数据则中止，避免界面永久卡在「回复中…」。
async function streamChat({ baseUrl, apiKey, model, messages, think, signal, idleTimeoutMs }, onEvent) {
  let safeBaseUrl;
  try {
    safeBaseUrl = normalizeProviderBaseUrl(baseUrl);
  } catch (err) {
    onEvent({ error: (err && err.message) || String(err) });
    return;
  }
  // 报错文案按 baseUrl 推断提供方，避免用 MiniMax 时仍显示「DeepSeek」误导。
  const isMinimax = /minimax/i.test(safeBaseUrl);
  const providerLabel = isMinimax ? 'MiniMax' : 'DeepSeek';
  if (!apiKey) {
    onEvent({ error: `未配置 ${providerLabel} API Key，请在「设置」里填写。` });
    return;
  }
  const url = `${safeBaseUrl}/chat/completions`;
  // MiniMax-M3 默认开启思考。think=true：思考单独走 reasoning_content（问答展示思考块）；
  // think=false：彻底关闭思考（翻译/润色/OCR 只要结果，最省钱）。DeepSeek 不认这些参数，故仅 MiniMax 加。
  const body = { model, messages, stream: true };
  if (isMinimax) {
    if (think) body.reasoning_split = true;
    else body.thinking = { type: 'disabled' };
  }

  // 中止控制：内部 AbortController 同时承接「外部主动取消」和「空闲超时兜底」两类中止。
  const ac = new AbortController();
  let canceled = false; // 外部主动取消
  let timedOut = false; // 空闲超时
  const onExternalAbort = () => { canceled = true; ac.abort(); };
  if (signal) {
    if (signal.aborted) onExternalAbort();
    else signal.addEventListener('abort', onExternalAbort);
  }
  const idleMs = idleTimeoutMs || 90000;
  let idleTimer = null;
  const armIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { timedOut = true; ac.abort(); }, idleMs);
  };
  const cleanup = () => {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    if (signal) { try { signal.removeEventListener('abort', onExternalAbort); } catch (_) {} }
  };
  // 把中止转成调用方能识别的事件：超时按错误提示，主动取消静默收尾。
  const finishAbort = () => {
    if (timedOut) onEvent({ error: `${providerLabel} 请求超时：服务端长时间无响应（约 ${Math.round(idleMs / 1000)} 秒），请重试。` });
    else if (canceled) onEvent({ canceled: true });
    else onEvent({ error: '请求已中止。' });
  };

  let res;
  try {
    armIdle();
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
  } catch (e) {
    cleanup();
    if (timedOut || canceled) return finishAbort();
    onEvent({ error: `网络请求失败：${e.message}` });
    return;
  }

  if (!res.ok) {
    let detail = '';
    try {
      detail = await readBoundedResponseText(res, MAX_ERROR_BODY_BYTES, ac.signal, armIdle);
    } catch (err) {
      cleanup();
      if (timedOut || canceled) return finishAbort();
      onEvent({ error: (err && err.message) || '读取错误响应失败。' });
      return;
    }
    cleanup();
    const friendly = describeApiError({ provider: providerLabel, isMinimax, status: res.status, baseUrl: safeBaseUrl, detail });
    onEvent({ error: friendly || `${providerLabel} 返回 ${res.status}：${detail.slice(0, 500)}` });
    return;
  }
  if (!res.body) {
    cleanup();
    onEvent({ error: '响应没有 body 流。' });
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let receivedBytes = 0;
  try {
    while (true) {
      armIdle(); // 每次等待新数据前重置空闲计时
      const { value, done } = await readReaderChunk(reader, ac.signal);
      if (done) break;
      receivedBytes += value.byteLength;
      if (receivedBytes > MAX_STREAM_BYTES) {
        try { await reader.cancel(); } catch (_) {}
        cleanup();
        onEvent({ error: 'AI 流式响应过大，已停止读取。' });
        return;
      }
      buffer += decoder.decode(value, { stream: true });
      // SSE：事件以换行分隔，data: 行承载 JSON
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const raw of lines) {
        const line = raw.trim();
        if (!line || !line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') {
          cleanup();
          onEvent({ done: true });
          return;
        }
        try {
          const json = JSON.parse(payload);
          const d = (json && json.choices && json.choices[0] && json.choices[0].delta) || {};
          if (d.content) onEvent({ delta: d.content });
          // MiniMax reasoning_split 模式：思考文本走 reasoning_content / reasoning_details
          if (d.reasoning_content) onEvent({ reasoning: d.reasoning_content });
          if (Array.isArray(d.reasoning_details)) {
            d.reasoning_details.forEach((x) => { if (x && x.text) onEvent({ reasoning: x.text }); });
          }
        } catch (_) {
          // 单行解析失败忽略（可能是心跳或被截断的块）
        }
      }
    }
    cleanup();
    onEvent({ done: true });
  } catch (e) {
    cleanup();
    if (timedOut || canceled) return finishAbort();
    onEvent({ error: `读取流失败：${e.message}` });
  }
}

// 非流式：收集完整文本（用于 DeepSeek OCR 等需要整段结果的场景）
async function completeText({ baseUrl, apiKey, model, messages, think }) {
  let text = '';
  let err = null;
  await streamChat({ baseUrl, apiKey, model, messages, think }, (ev) => {
    if (ev.delta) text += ev.delta;
    if (ev.error) err = ev.error;
  });
  if (err) throw new Error(err);
  return text;
}

// 构造一条带图片的 user 消息（OpenAI 兼容多模态格式）
function imageMessage(prompt, dataURL) {
  return {
    role: 'user',
    content: [
      { type: 'text', text: prompt },
      { type: 'image_url', image_url: { url: dataURL } },
    ],
  };
}

// 兜底：剥离 <think>...</think>（thinking:disabled 后通常不会有，保险用）
function stripThink(text) {
  return String(text || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

// 修复 LLM 常见的 JSON 噪声（移植自 kunkun-translator 的 repairJSONNoise）。
// DeepSeek/GLM/通义等模型常不严格遵守 JSON：中文引号、全角标点、字符串内裸换行、尾逗号。
// 用状态机区分「字符串内 vs 结构位置」，避免误改译文里的合法字符。
function repairJsonNoise(raw) {
  let t = String(raw == null ? '' : raw);
  // 1) 中文/智能引号 → ASCII 双引号；全角冒号/逗号归一（这些不会出现在合法 JSON 结构里，替换安全）
  ['“', '”', '„', '‟', '＂', '「', '」'].forEach((q) => { t = t.split(q).join('"'); });
  t = t.split('：').join(':').split('，').join(',');
  // 2) 状态机：转义字符串内的裸换行/制表符
  let out = '';
  let inString = false;
  let escaped = false;
  for (const c of t) {
    if (inString) {
      if (escaped) { escaped = false; out += c; }
      else if (c === '\\') { escaped = true; out += c; }
      else if (c === '"') { inString = false; out += c; }
      else if (c === '\n' || c === '\r') { out += '\\n'; }
      else if (c === '\t') { out += '\\t'; }
      else { out += c; }
    } else {
      if (c === '"') { inString = true; }
      out += c;
    }
  }
  // 3) 去尾逗号 ,} 或 ,]
  return out.replace(/,\s*}/g, '}').replace(/,\s*]/g, ']');
}

// 从含噪声文本里提取第一个完整 JSON 数组或对象并解析。失败返回 null（不抛错）。
// 用括号配对（跳过字符串内的括号），先原样试、失败再 repairJsonNoise 后重试。
function extractJson(rawText) {
  const text = String(rawText == null ? '' : rawText);
  // 剥 markdown 代码围栏
  let s = text.trim().replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/i, '').trim();
  // 找第一个 { 或 [ 作为起点
  const objAt = s.indexOf('{');
  const arrAt = s.indexOf('[');
  let start = -1;
  let open = '{';
  let close = '}';
  if (arrAt >= 0 && (objAt < 0 || arrAt < objAt)) { start = arrAt; open = '['; close = ']'; }
  else if (objAt >= 0) { start = objAt; open = '{'; close = '}'; }
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  let end = -1;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (escaped) { escaped = false; }
    else if (c === '\\') { escaped = true; }
    else if (c === '"') { inString = !inString; }
    else if (!inString) {
      if (c === open) depth++;
      else if (c === close) { depth--; if (depth === 0) { end = i; break; } }
    }
  }
  if (end < 0) return null;
  const slice = s.slice(start, end + 1);
  try { return JSON.parse(slice); } catch (_) {}
  try { return JSON.parse(repairJsonNoise(slice)); } catch (_) {}
  return null;
}

// 在线拉取模型清单（移植自 kunkun-translator 的 ModelCatalog.fetchModels）。
// GET {baseUrl}/models?type=text，Bearer 鉴权；返回排序后的 model id 数组。
async function fetchModels({ baseUrl, apiKey, timeoutMs }) {
  if (!apiKey) throw new Error('未填写 API Key');
  const base = normalizeProviderBaseUrl(baseUrl);
  const url = `${base}/models?type=text`;
  // 加 15s 超时兜底：Node 内置 fetch 无默认整体超时，若端点接受连接却不返回（半开连接/丢包），
  // Promise 永不 settle，会让设置页「刷新模型列表」按钮永久转圈。用 AbortController 强制中止。
  const ac = new AbortController();
  const requestedTimeout = Number(timeoutMs);
  const deadlineMs = Number.isFinite(requestedTimeout)
    ? Math.max(10, Math.min(60_000, requestedTimeout))
    : 15_000;
  const timer = setTimeout(() => ac.abort(), deadlineMs);
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      signal: ac.signal,
    });
    if (!res.ok) {
      const detail = await readBoundedResponseText(res, MAX_ERROR_BODY_BYTES, ac.signal);
      throw new Error(`拉取模型失败 ${res.status}：${detail.slice(0, 300)}`);
    }
    const raw = await readBoundedResponseText(res, MAX_MODEL_BODY_BYTES, ac.signal);
    let j;
    try { j = JSON.parse(raw); } catch (_) { throw new Error('模型列表返回不是合法 JSON'); }
    const ids = ((j && j.data) || []).map((m) => m && m.id).filter(Boolean);
    if (!ids.length) throw new Error('模型列表为空');
    return ids.sort((a, b) => (String(a).toLowerCase() < String(b).toLowerCase() ? -1 : 1));
  } catch (err) {
    if ((err && err.name === 'AbortError') || ac.signal.aborted) {
      throw new Error(`拉取模型超时（${Math.round(deadlineMs / 1000)}s 未响应），请检查 Base URL 与网络`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { streamChat, completeText, imageMessage, stripThink, repairJsonNoise, extractJson, fetchModels };
