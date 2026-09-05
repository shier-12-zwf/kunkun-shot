// AI 面板渲染逻辑。
// 与主进程交互一律走 window.kkapi（preload 注入），禁止 require / import。
// 表格 / 公式是明确标注的 AI 辅助识别；任务 prompt 由主进程固定，渲染层只传模式。
(function () {
  'use strict';

  // ---------- DOM 引用 ----------
  const $ = (id) => document.getElementById(id);
  const modeIcon = $('modeIcon');
  const modeTitle = $('modeTitle');
  const thumbWrap = $('thumbWrap');
  const thumbImg = $('thumbImg');
  const modeNote = $('modeNote');
  const ocrBlock = $('ocrBlock');
  const ocrText = $('ocrText');
  const ocrCopy = $('ocrCopy');
  const ocrTranslate = $('ocrTranslate');
  const ocrPolish = $('ocrPolish');
  const ocrAsk = $('ocrAsk');
  const resultEl = $('result');
  // 不缓存 #placeholder 节点：复用窗口会重建它，hidePlaceholder 改为每次按 id 重查。
  const inputEl = $('input');
  const btnSend = $('btnSend');
  const btnSettings = $('btnSettings');
  const btnCopyResult = $('btnCopyResult');
  const btnRetry = $('btnRetry');
  const btnMin = $('btnMin');
  const btnClose = $('btnClose');
  const tableWorkspace = $('tableWorkspace');
  const tableMeta = $('tableMeta');
  const tableGrid = $('tableGrid');
  const btnTableRaw = $('btnTableRaw');
  const btnCopyCsv = $('btnCopyCsv');
  const btnCopyTsv = $('btnCopyTsv');
  const btnCopyMarkdown = $('btnCopyMarkdown');

  // ---------- 运行时状态 ----------
  let config = null; // 配置（含 prompts）
  let mode = 'ask'; // 当前模式
  let curDataURL = ''; // 当前截图（ask / ocr 用）
  let messages = []; // 追问历史（OpenAI 格式）
  let currentStreamId = null; // 当前正在进行的流 id，用于过滤 onStream
  let streaming = false; // 是否正在接收流
  let liveBodyEl = null; // 正在累积输出的消息体节点
  let liveText = ''; // 正在累积的原始文本
  let liveReasoning = ''; // 正在累积的思考过程（仅问答模式展示）
  let liveReasoningEl = null; // 思考块节点
  let editableTableRows = [];

  const MODE_META = {
    ask: { icon: '🤖', title: '截图问 AI' },
    ocr: { icon: '🔤', title: '文字识别 OCR' },
    translate: { icon: '🌐', title: '翻译' },
    translateImage: { icon: '🌐', title: '翻译截图' },
    polish: { icon: '✨', title: '润色' },
    table: { icon: '🤖', title: 'AI 表格识别 · Markdown / CSV' },
    formula: { icon: '🤖', title: 'AI 公式识别 · LaTeX' },
  };

  function isStructuredRecognitionMode(value) {
    return value === 'table' || value === 'formula';
  }

  // 翻译截图用的视觉提示词（识别图中文字并翻译）
  const IMAGE_TRANSLATE_PROMPT =
    '请识别这张图片里的所有文字并翻译：如果原文是中文，翻译成英文；否则翻译成中文。只输出翻译结果，保持原有分行，不要解释、不要附原文。';

  // ---------- 工具函数 ----------
  // HTML 转义，防止把 AI / OCR 文本当作 HTML 注入。
  function escapeHTML(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function hidePlaceholder() {
    // 必须按 id 重新查询：AI 窗是复用窗口，每次 init 会重建 #placeholder 节点；
    // 若用模块加载时捕获的旧常量节点判断，复用后占位文案会清不掉、残留在结果区顶部。
    const ph = document.getElementById('placeholder');
    if (ph && ph.parentNode) ph.parentNode.removeChild(ph);
  }

  function scrollToBottom() {
    resultEl.scrollTop = resultEl.scrollHeight;
  }

  async function copyTextWithConfirmation(text) {
    const copied = await kkapi.copyText(text);
    if (copied !== true) throw new Error('剪贴板未确认写入。');
    return true;
  }

  async function openSettingsWithFeedback() {
    try {
      const outcome = await kkapi.openSettings();
      if (!outcome || outcome.ok !== true) {
        const detail = outcome && outcome.error;
        const message = typeof detail === 'string'
          ? detail
          : (detail && detail.message) || '设置窗口打开失败。';
        throw new Error(message);
      }
      return true;
    } catch (error) {
      showError('设置窗口打开失败：' + ((error && error.message) || error));
      return false;
    }
  }

  // 清空结果区
  function clearResult() {
    resultEl.innerHTML = '';
    liveBodyEl = null;
    liveText = '';
  }

  function resetTableWorkspace() {
    editableTableRows = [];
    tableGrid.textContent = '';
    tableWorkspace.hidden = true;
    resultEl.hidden = false;
    btnTableRaw.textContent = '查看原始结果';
  }

  function readEditableTable() {
    return Array.from(tableGrid.querySelectorAll('tr')).map((row) =>
      Array.from(row.querySelectorAll('input, textarea')).map((cellInput) => cellInput.value)
    );
  }

  function renderEditableTable(source) {
    if (mode !== 'table' || !window.KKTableModel) return false;
    let parsed;
    try {
      parsed = window.KKTableModel.extractStructuredTable(source);
    } catch (_) {
      return false;
    }

    resetTableWorkspace();
    editableTableRows = parsed.rows.map((row) => row.slice());
    const body = document.createElement('tbody');
    editableTableRows.forEach((row, rowIndex) => {
      const rowEl = document.createElement('tr');
      row.forEach((value, columnIndex) => {
        const cellEl = document.createElement(rowIndex === 0 ? 'th' : 'td');
        const cellInput = value.includes('\n')
          ? document.createElement('textarea')
          : document.createElement('input');
        if (cellInput.tagName === 'INPUT') cellInput.type = 'text';
        cellInput.className = 'table-cell-input';
        cellInput.value = value;
        cellInput.setAttribute('aria-label', `第 ${rowIndex + 1} 行，第 ${columnIndex + 1} 列`);
        cellEl.appendChild(cellInput);
        rowEl.appendChild(cellEl);
      });
      body.appendChild(rowEl);
    });
    tableGrid.appendChild(body);
    tableMeta.textContent = `${editableTableRows.length} 行 × ${editableTableRows[0].length} 列 · 可直接编辑`;
    tableWorkspace.hidden = false;
    resultEl.hidden = true;
    return true;
  }

  async function copyEditedTable(button, serializer) {
    const rows = readEditableTable();
    if (!rows.length || !window.KKTableModel) return;
    try {
      await copyTextWithConfirmation(serializer(rows));
      const old = button.textContent;
      button.textContent = '已复制 ✓';
      setTimeout(() => { button.textContent = old; }, 1200);
    } catch (error) {
      showError('复制表格失败：' + (error && error.message ? error.message : error));
    }
  }

  // 追加一条完整消息（role: user / assistant）。返回 body 节点。
  function appendMessage(role, text) {
    hidePlaceholder();
    const wrap = document.createElement('div');
    wrap.className = 'msg ' + (role === 'user' ? 'user' : 'assistant');

    const roleEl = document.createElement('div');
    roleEl.className = 'msg-role';
    roleEl.textContent = role === 'user' ? '我' : 'AI';

    const body = document.createElement('div');
    body.className = 'msg-body';
    body.textContent = text == null ? '' : String(text); // textContent 天然防注入

    wrap.appendChild(roleEl);
    wrap.appendChild(body);
    resultEl.appendChild(wrap);
    scrollToBottom();
    return body;
  }

  // 显示红色错误，并在缺少 API Key 时给出去设置的链接。
  function showError(msg) {
    hidePlaceholder();
    const box = document.createElement('div');
    box.className = 'error';
    box.textContent = msg || '发生未知错误。';

    const text = String(msg || '');
    if (/api\s*key|未配置|apikey/i.test(text)) {
      const tip = document.createElement('div');
      tip.style.marginTop = '6px';
      const link = document.createElement('span');
      link.className = 'link';
      link.textContent = '前往「设置」填写 API Key →';
      link.addEventListener('click', () => { openSettingsWithFeedback(); });
      tip.appendChild(link);
      box.appendChild(tip);
    }
    resultEl.appendChild(box);
    scrollToBottom();
  }

  // 设置发送 / 操作按钮的禁用状态
  function setBusy(busy) {
    streaming = busy;
    btnSend.disabled = busy;
    btnSend.textContent = busy ? '回复中…' : '发送';
    btnRetry.disabled = busy;
    [ocrTranslate, ocrPolish, ocrAsk].forEach((b) => {
      if (b) b.disabled = busy;
    });
  }

  // ---------- 流式接收（只注册一次）----------
  // 思考块：仅问答模式下、reasoning 第一次到达时，在消息体上方插入灰色折叠块
  function ensureReasoningEl() {
    if (liveReasoningEl) return liveReasoningEl;
    if (!liveBodyEl || !liveBodyEl.parentNode) return null;
    const block = document.createElement('div');
    block.className = 'think-block';
    liveBodyEl.parentNode.insertBefore(block, liveBodyEl);
    liveReasoningEl = block;
    return block;
  }

  function beginStream() {
    currentStreamId = kkapi.uid();
    setBusy(true);
    // 新建一条 assistant 消息体用于累积
    liveBodyEl = appendMessage('assistant', '');
    liveText = '';
    liveReasoning = '';
    liveReasoningEl = null;
    // 加一个闪烁光标提示正在生成
    const cursor = document.createElement('span');
    cursor.className = 'typing-cursor';
    liveBodyEl.appendChild(cursor);
    return currentStreamId;
  }

  function finishStream() {
    if (liveBodyEl) {
      // 去掉光标，落定最终文本
      liveBodyEl.textContent = liveText;
      // 把这轮 AI 回复写入历史，供后续追问携带上下文
      if (liveText) messages.push({ role: 'assistant', content: liveText });
    }
    liveBodyEl = null;
    liveReasoningEl = null;
    currentStreamId = null;
    setBusy(false);
    scrollToBottom();
  }

  // onStream 全局只注册一次，用 currentStreamId 过滤属于自己的流。
  // 移除思考块 DOM（出错 / 取消回滚时调用，避免残留孤立的「💭…」灰块）。
  function removeReasoningEl() {
    if (liveReasoningEl && liveReasoningEl.parentNode) liveReasoningEl.parentNode.removeChild(liveReasoningEl);
    liveReasoningEl = null;
  }

  kkapi.onStream((ev) => {
    if (!ev || ev.streamId !== currentStreamId) return;
    if (ev.canceled) { // 被主动取消：静默收尾，不报错
      removeReasoningEl();
      liveBodyEl = null;
      currentStreamId = null;
      setBusy(false);
      if (isStructuredRecognitionMode(mode)) btnRetry.hidden = false;
      return;
    }
    if (ev.error) {
      // 出错：移除半成品 assistant 节点（若为空），显示红色错误
      if (liveBodyEl && !liveText) {
        const w = liveBodyEl.parentNode;
        if (w && w.parentNode) w.parentNode.removeChild(w);
      } else if (liveBodyEl) {
        liveBodyEl.textContent = liveText;
      }
      removeReasoningEl();
      liveBodyEl = null;
      currentStreamId = null;
      setBusy(false);
      showError(ev.error);
      if (isStructuredRecognitionMode(mode)) btnRetry.hidden = false;
      return;
    }
    if (ev.reasoning) {
      liveReasoning += ev.reasoning;
      const el = ensureReasoningEl();
      if (el) {
        el.textContent = '💭 ' + liveReasoning;
        scrollToBottom();
      }
    }
    if (ev.delta) {
      liveText += ev.delta;
      if (liveBodyEl) {
        liveBodyEl.textContent = liveText;
        scrollToBottom();
      }
    }
    if (ev.done) {
      const completedText = liveText;
      finishStream();
      if (isStructuredRecognitionMode(mode)) {
        btnRetry.hidden = false;
        btnCopyResult.hidden = !liveText;
      }
      if (mode === 'table') renderEditableTable(completedText);
    }
  });

  // ---------- 各模式的发起 ----------

  // ask：立即对截图发起多模态问图。可传 customPrompt（如翻译截图）。
  async function startAsk(customPrompt, opts) {
    if (!curDataURL) {
      showError('没有可分析的截图。');
      return;
    }
    const prompt =
      customPrompt != null
        ? customPrompt
        : (config && config.deepseek && config.deepseek.askImagePrompt) || '';
    // think：问答默认展示思考；截图翻译等只要结果的传 {think:false}
    const think = !opts || opts.think !== false;
    // 历史里记录一条 user，标明这是针对截图的提问（后续追问携带上下文）
    messages.push({ role: 'user', content: '（针对刚才的截图）' + (prompt || '请分析这张截图。') });
    const id = beginStream();
    try {
      await kkapi.askImage({ dataURL: curDataURL, prompt, streamId: id, think });
    } catch (e) {
      handleCallError(e);
    }
  }

  // 用纯文本 prompt + 内容走 chat 流式（translate / polish / OCR 的翻译润色）
  async function startTextTask(promptText, content) {
    const userContent = (promptText || '') + '\n\n' + (content || '');
    // 这类一次性任务不累计到追问历史，独立成一条
    const id = beginStream();
    try {
      await kkapi.chat({
        messages: [{ role: 'user', content: userContent }],
        streamId: id,
        think: false, // 翻译 / 润色：只要结果，不要思考
      });
    } catch (e) {
      handleCallError(e);
    }
  }

  // 专用结构化识别通道：payload 中没有 prompt，主进程根据严格 mode 白名单选择固定任务。
  async function startStructuredRecognition() {
    if (!isStructuredRecognitionMode(mode) || streaming) return;
    if (!curDataURL) {
      showError('没有可识别的截图。');
      btnRetry.hidden = false;
      return;
    }
    btnRetry.hidden = true;
    btnCopyResult.hidden = true;
    hidePlaceholder();
    const id = beginStream();
    try {
      await kkapi.recognizeImage({ mode: mode, dataURL: curDataURL, streamId: id });
    } catch (e) {
      handleCallError(e);
      btnRetry.hidden = false;
    }
  }

  function handleCallError(e) {
    if (liveBodyEl) {
      const w = liveBodyEl.parentNode;
      if (w && w.parentNode) w.parentNode.removeChild(w);
    }
    removeReasoningEl();
    liveBodyEl = null;
    currentStreamId = null;
    setBusy(false);
    showError('调用失败：' + (e && e.message ? e.message : e));
    if (isStructuredRecognitionMode(mode)) btnRetry.hidden = false;
  }

  // ---------- OCR 流程 ----------
  async function runOCR() {
    const myURL = curDataURL; // 复用窗口快速二次 OCR 时用于丢弃旧图的结果
    ocrText.value = '';
    ocrText.placeholder = '识别中…';
    try {
      const res = await kkapi.runOCR({ dataURL: myURL, engine: (config && config.ocr && config.ocr.engine) || 'local' });
      if (curDataURL !== myURL) return; // 窗口已复用切到新图，旧图识别结果丢弃，避免跨图文本污染
      if (res && res.error) {
        ocrText.placeholder = '识别失败';
        showError('OCR 识别失败：' + res.error);
        return;
      }
      const text = (res && res.text) || '';
      ocrText.value = text;
      ocrText.placeholder = '（未识别到文字，可手动输入）';
      if (!text) showError('未识别到文字。可以手动输入后再翻译 / 润色 / 问 AI。');
    } catch (e) {
      if (curDataURL !== myURL) return; // 同上：过期旧图的失败态不覆盖新会话
      ocrText.placeholder = '识别失败';
      showError('OCR 识别失败：' + (e && e.message ? e.message : e));
    }
  }

  // ---------- 追问（底部输入框）----------
  async function sendFollowUp() {
    const text = inputEl.value.trim();
    if (!text || streaming) return;
    inputEl.value = '';
    autoGrow();

    // OCR 模式下，若还没有任何 AI 历史，把追问当作「针对识别文字」的问题更直观
    appendMessage('user', text);
    messages.push({ role: 'user', content: text });

    const id = beginStream();
    try {
      await kkapi.chat({ messages: messages.slice(), streamId: id, think: true });
    } catch (e) {
      handleCallError(e);
    }
  }

  // OCR 区「问 AI」：把当前文本作为上下文，转入对话式追问
  function ocrAskAI() {
    const text = ocrText.value.trim();
    if (!text) {
      showError('没有可提问的文字。');
      return;
    }
    if (streaming) return;
    // 建立首条上下文消息（仅本地历史，不立刻请求；等用户在输入框追问）
    if (messages.length === 0) {
      messages.push({ role: 'user', content: '以下是我从截图里识别到的文字，请基于它回答我接下来的问题：\n\n' + text });
      appendMessage('assistant', '已载入识别文字作为上下文，请在下方输入你的问题。');
      messages.push({ role: 'assistant', content: '好的，请提出你的问题。' });
    }
    inputEl.focus();
  }

  // ---------- 输入框自适应高度 ----------
  function autoGrow() {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + 'px';
  }

  // ---------- 初始化（payload 可能多次到达）----------
  async function init(payload) {
    payload = payload || {};
    mode = payload.mode || 'ask';
    curDataURL = payload.dataURL || '';
    const givenText = payload.text || '';

    // 重置会话状态：复用窗口时先取消上一轮在途流，否则旧流在主进程会空跑到结束/超时、白烧 token（与 pages/ai.js 一致）。
    if (currentStreamId) { try { if (kkapi.cancelStream) kkapi.cancelStream(currentStreamId); } catch (_) {} }
    messages = [];
    currentStreamId = null;
    streaming = false;
    liveBodyEl = null;
    liveText = '';
    liveReasoning = '';
    liveReasoningEl = null;
    clearResult();
    resetTableWorkspace();
    // 重新放回占位文案
    const ph = document.createElement('div');
    ph.className = 'placeholder';
    ph.id = 'placeholder';
    ph.textContent = '结果会显示在这里…';
    resultEl.appendChild(ph);
    setBusy(false);
    btnRetry.hidden = true;
    btnCopyResult.hidden = true;

    // 顶部标题与图标
    const meta = MODE_META[mode] || MODE_META.ask;
    modeIcon.textContent = meta.icon;
    modeTitle.textContent = meta.title;

    // 缩略图
    if (curDataURL) {
      thumbImg.src = curDataURL;
      thumbWrap.hidden = false;
    } else {
      thumbImg.removeAttribute('src');
      thumbWrap.hidden = true;
    }

    // OCR 区显隐
    ocrBlock.hidden = mode !== 'ocr';
    modeNote.hidden = !isStructuredRecognitionMode(mode);

    // 输入框提示
    if (mode === 'ocr') {
      inputEl.placeholder = '基于识别文字向 AI 追问，回车发送';
    } else if (mode === 'ask') {
      inputEl.placeholder = '继续追问（针对刚才截图），回车发送';
    } else if (isStructuredRecognitionMode(mode)) {
      inputEl.placeholder = '可基于识别结果继续追问，回车发送';
    } else {
      inputEl.placeholder = '输入追问内容，回车发送';
    }

    // 确保配置已就绪
    if (!config) {
      try {
        config = await kkapi.getConfig();
      } catch (e) {
        showError('读取配置失败：' + (e && e.message ? e.message : e));
        return;
      }
    }
    const ds = (config && config.deepseek) || {};

    // 各模式起步行为
    if (mode === 'ask') {
      hidePlaceholder();
      startAsk();
    } else if (mode === 'translateImage') {
      // 截图翻译：把图发给视觉模型直接翻译
      hidePlaceholder();
      startAsk(IMAGE_TRANSLATE_PROMPT, { think: false });
    } else if (mode === 'ocr') {
      runOCR();
    } else if (isStructuredRecognitionMode(mode)) {
      startStructuredRecognition();
    } else if (mode === 'translate') {
      hidePlaceholder();
      startTextTask(ds.translatePrompt || '请翻译下面这段文字：', givenText);
    } else if (mode === 'polish') {
      hidePlaceholder();
      startTextTask(ds.polishPrompt || '请润色下面这段文字：', givenText);
    }
  }

  // ---------- 事件绑定 ----------
  btnSettings.addEventListener('click', () => { openSettingsWithFeedback(); });
  btnRetry.addEventListener('click', startStructuredRecognition);
  btnCopyResult.addEventListener('click', async () => {
    if (!liveText) return;
    try {
      await copyTextWithConfirmation(liveText);
      const old = btnCopyResult.textContent;
      btnCopyResult.textContent = '已复制 ✓';
      setTimeout(() => { btnCopyResult.textContent = old; }, 1200);
    } catch (error) {
      showError('复制结果失败：' + ((error && error.message) || error));
    }
  });
  btnTableRaw.addEventListener('click', () => {
    const showingRaw = !resultEl.hidden;
    resultEl.hidden = showingRaw;
    btnTableRaw.textContent = showingRaw ? '查看原始结果' : '返回编辑表格';
  });
  btnCopyCsv.addEventListener('click', () => copyEditedTable(btnCopyCsv, window.KKTableModel.serializeCsv));
  btnCopyTsv.addEventListener('click', () => copyEditedTable(btnCopyTsv, window.KKTableModel.serializeTsv));
  btnCopyMarkdown.addEventListener('click', () => copyEditedTable(btnCopyMarkdown, window.KKTableModel.serializeMarkdown));
  btnMin.addEventListener('click', () => {
    try {
      kkapi.minimizeSelf();
    } catch (_) {}
  });
  btnClose.addEventListener('click', () => {
    try {
      kkapi.closeSelf();
    } catch (_) {}
  });

  btnSend.addEventListener('click', sendFollowUp);
  inputEl.addEventListener('input', autoGrow);
  inputEl.addEventListener('keydown', (e) => {
    // 回车发送，Shift+回车换行
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      sendFollowUp();
    }
  });

  // OCR 操作按钮
  ocrCopy.addEventListener('click', async () => {
    const t = ocrText.value;
    if (!t) return;
    try {
      await copyTextWithConfirmation(t);
      const old = ocrCopy.textContent;
      ocrCopy.textContent = '已复制 ✓';
      setTimeout(() => {
        ocrCopy.textContent = old;
      }, 1200);
    } catch (error) {
      showError('复制识别文字失败：' + ((error && error.message) || error));
    }
  });
  ocrTranslate.addEventListener('click', () => {
    const t = ocrText.value.trim();
    if (!t || streaming) return;
    const ds = (config && config.deepseek) || {};
    hidePlaceholder();
    startTextTask(ds.translatePrompt || '请翻译下面这段文字：', t);
  });
  ocrPolish.addEventListener('click', () => {
    const t = ocrText.value.trim();
    if (!t || streaming) return;
    const ds = (config && config.deepseek) || {};
    hidePlaceholder();
    startTextTask(ds.polishPrompt || '请润色下面这段文字：', t);
  });
  ocrAsk.addEventListener('click', ocrAskAI);

  // 注册窗口初始化回调（主进程加载完成后发送，且可能多次）
  kkapi.onInit(init);
})();
