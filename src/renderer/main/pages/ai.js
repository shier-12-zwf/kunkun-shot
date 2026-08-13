// 主窗口「AI 工作台」页（注册到 window.KKPages.ai）
// 三栏布局：①左栏历史缩略图列表 ②中栏当前图片大图预览（可点击放大）③右栏对话式工作区。
// 与主进程交互一律走 window.kkapi（preload 注入）；禁止 require / import 任何 node/electron。
// 能力：问图（视觉模型 askImage）/ OCR（runOCR，结果可编辑可复制）/ 翻译 / 总结 / 润色（纯文本 chat 流式）。
// onStream 全局只注册一次，靠当前 streamId 过滤；AI 输出文本一律用 textContent 防注入。
(function () {
  'use strict';

  window.KKPages = window.KKPages || {};

  // ============================================================
  // 模块级状态：每次 render 会被重置（render 可能被多次调用）。
  // onStream 监听只注册一次（首次 render 时挂上），用 currentStreamId 过滤。
  // ============================================================
  let streamRegistered = false; // 是否已注册过 onStream
  let offHistory = null; // 历史变化监听的反注册函数

  // 与当前一次 render 绑定的运行时引用（重建 UI 后会整体替换）
  let R = null;

  // 创建一份全新的运行时上下文
  function newRuntime() {
    return {
      config: null, // 配置（含 prompts）
      history: [], // 历史列表 [{id,time,width,height,type,thumb}]
      currentId: null, // 当前选中的历史项 id
      currentDataURL: '', // 当前图片原图 dataURL
      messages: [], // 对话历史（OpenAI 格式），用于追问携带上下文
      ocrText: '', // 最近一次 OCR / 可编辑文本区的内容
      currentStreamId: null, // 正在进行的流 id
      streaming: false, // 是否正在接收流
      liveBodyEl: null, // 正在累积输出的 AI 气泡正文节点
      liveText: '', // 正在累积的原始文本
      liveReasoning: '', // 正在累积的思考流（reasoning）文本
      liveReasoningEl: null, // 思考流「💭」展示节点
      // DOM 引用（render 时填充）
      dom: {},
    };
  }

  // ------------------------------------------------------------
  // 小工具
  // ------------------------------------------------------------
  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  // 创建一个线性 SVG 图标（内联，无外部依赖）。paths 为 <path>/<circle>... 的字符串。
  function svgIcon(paths, extraCls) {
    const wrap = document.createElement('span');
    wrap.innerHTML =
      '<svg class="ico' + (extraCls ? ' ' + extraCls : '') + '" viewBox="0 0 24 24">' + paths + '</svg>';
    return wrap.firstChild;
  }

  const ICONS = {
    ai: '<path d="M12 3l1.8 4.7L18.5 9.5 13.8 11.3 12 16l-1.8-4.7L5.5 9.5l4.7-1.8z"/>',
    ocr: '<path d="M4 7V5h16v2 M9 19h6 M12 5v14"/>',
    translate: '<path d="M4 5h7 M7 5v2c0 3-2 5-4 6 M5 11c1 2 3 3 5 3 M13 19l4-9 4 9 M15 16h4"/>',
    summary: '<path d="M4 6h16 M4 10h16 M4 14h11 M4 18h7"/>',
    polish: '<path d="M12 3l1.8 4.7L18.5 9.5 13.8 11.3 12 16l-1.8-4.7L5.5 9.5l4.7-1.8z"/><path d="M19 14l.7 1.8 1.8.7-1.8.7L19 19l-.7-1.8-1.8-.7 1.8-.7z"/>',
    copy:
      '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    history: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    close: '<path d="M6 6l12 12 M18 6L6 18"/>',
    camera:
      '<path d="M3 8a2 2 0 0 1 2-2h2l1.2-2h5.6L17 6h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><circle cx="12" cy="12.5" r="3.2"/>',
    // 发送（纸飞机，线性自绘）
    send: '<path d="M4 12l16-7-7 16-2.5-6.5z"/><path d="M11 13l9-8"/>',
  };

  // HTML 转义（仅用于必须 innerHTML 的少量场景；正文一律走 textContent）。
  function escapeHTML(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // 时间戳格式化（兼容毫秒数字或字符串）
  function fmtTime(t) {
    let d;
    if (typeof t === 'number') d = new Date(t);
    else if (t) d = new Date(t);
    else d = new Date();
    if (isNaN(d.getTime())) return String(t || '');
    const p = (n) => String(n).padStart(2, '0');
    return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  // ------------------------------------------------------------
  // 错误提示（红色 .status err），并在缺 API Key 时给「前往设置」
  // ------------------------------------------------------------
  function showError(msg) {
    const stream = R.dom.stream;
    if (!stream) return;
    hideEmpty();
    const box = el('div', 'kk-ai-error');
    const head = el('span', 'status err');
    head.appendChild(svgIcon(ICONS.close, 'ico-sm'));
    head.appendChild(el('span', null, '出错了'));
    box.appendChild(head);
    box.appendChild(el('div', 'kk-ai-error-msg', msg || '发生未知错误。'));

    const text = String(msg || '');
    if (/api\s*key|未配置|apikey|key/i.test(text)) {
      const link = el('span', 'kk-ai-link', '前往「设置」填写 API Key →');
      link.addEventListener('click', () => {
        try {
          window.KKMain.go('settings');
        } catch (_) {}
      });
      box.appendChild(link);
    }
    stream.appendChild(box);
    scrollStreamToBottom();
  }

  // ------------------------------------------------------------
  // 消息流相关
  // ------------------------------------------------------------
  function hideEmpty() {
    const e = R.dom.streamEmpty;
    if (e && e.parentNode) e.parentNode.removeChild(e);
    R.dom.streamEmpty = null;
  }

  function scrollStreamToBottom() {
    const s = R.dom.stream;
    if (s) s.scrollTop = s.scrollHeight;
  }

  // 清空消息流，恢复「空状态」提示（切换图片重置对话时用）。
  function resetStream() {
    const s = R.dom.stream;
    if (!s) return;
    s.innerHTML = '';
    const empty = el('div', 'kk-ai-stream-empty');
    empty.appendChild(svgIcon(ICONS.ai, 'ico-lg'));
    empty.appendChild(el('div', 'kk-ai-stream-empty-t', 'AI 工作区'));
    empty.appendChild(el('div', 'kk-ai-stream-empty-d', '选好图片后，点上方能力胶囊，或在下方输入问题开始对话。'));
    s.appendChild(empty);
    R.dom.streamEmpty = empty;
  }

  // 追加一条完整消息气泡，返回正文节点（用 textContent 防注入）。
  function appendMessage(role, text) {
    hideEmpty();
    const isUser = role === 'user';
    const wrap = el('div', 'kk-ai-msg ' + (isUser ? 'is-user' : 'is-ai'));

    const head = el('div', 'kk-ai-msg-role');
    if (!isUser) head.appendChild(svgIcon(ICONS.ai, 'ico-sm'));
    head.appendChild(el('span', null, isUser ? '我' : 'AI'));

    const body = el('div', 'kk-ai-msg-body');
    body.textContent = text == null ? '' : String(text);

    wrap.appendChild(head);
    wrap.appendChild(body);

    // AI 消息底部带「复制」操作（流式结束后才有意义，先建好，空文本时隐藏）
    if (!isUser) {
      const tools = el('div', 'kk-ai-msg-tools');
      const copyBtn = el('button', 'btn btn-ghost kk-ai-mini');
      copyBtn.appendChild(svgIcon(ICONS.copy, 'ico-sm'));
      copyBtn.appendChild(el('span', null, '复制'));
      copyBtn.addEventListener('click', async () => {
        const t = body.textContent || '';
        if (!t) return;
        try {
          await kkapi.copyText(t);
          flashBtn(copyBtn, '已复制 ✓');
        } catch (_) {}
      });
      tools.appendChild(copyBtn);
      tools.hidden = true; // 流式完成后再显示
      wrap.appendChild(tools);
      wrap._tools = tools; // 暂存引用，便于 finishStream 显示
    }

    R.dom.stream.appendChild(wrap);
    scrollStreamToBottom();
    return body;
  }

  function flashBtn(btn, tip) {
    const span = btn.querySelector('span');
    if (!span) return;
    const old = span.textContent;
    span.textContent = tip;
    setTimeout(() => {
      span.textContent = old;
    }, 1200);
  }

  // ------------------------------------------------------------
  // 流式接收
  // ------------------------------------------------------------
  function beginStream() {
    R.currentStreamId = kkapi.uid();
    setBusy(true);
    R.liveBodyEl = appendMessage('assistant', '');
    R.liveText = '';
    R.liveReasoning = '';
    R.liveReasoningEl = null;
    const cursor = el('span', 'kk-ai-cursor');
    R.liveBodyEl.appendChild(cursor);
    return R.currentStreamId;
  }

  function finishStream() {
    if (R.liveBodyEl) {
      R.liveBodyEl.textContent = R.liveText; // 去光标，落定文本
      if (R.liveText) R.messages.push({ role: 'assistant', content: R.liveText });
      // 显示该气泡的复制按钮
      const wrap = R.liveBodyEl.parentNode;
      if (wrap && wrap._tools && R.liveText) wrap._tools.hidden = false;
    }
    R.liveBodyEl = null;
    R.currentStreamId = null;
    setBusy(false);
    scrollStreamToBottom();
  }

  // 调用本身抛错（promise reject）时回滚半成品气泡并提示。
  function handleCallError(e) {
    if (R.liveBodyEl) {
      const w = R.liveBodyEl.parentNode;
      if (w && w.parentNode) w.parentNode.removeChild(w);
    }
    removeReasoningEl();
    R.liveBodyEl = null;
    R.currentStreamId = null;
    setBusy(false);
    showError('调用失败：' + (e && e.message ? e.message : e));
  }

  // 思考流（reasoning）：在当前回答气泡上方插一个淡色「💭」块，与独立 AI 窗一致。
  function ensureReasoningEl() {
    if (R.liveReasoningEl) return R.liveReasoningEl;
    if (!R.dom || !R.dom.stream) return null;
    const box = el('div', 'kk-ai-reasoning');
    box.style.cssText = 'opacity:.6;font-size:12px;line-height:1.5;white-space:pre-wrap;margin:2px 0;';
    const answerWrap = R.liveBodyEl && R.liveBodyEl.parentNode;
    if (answerWrap && answerWrap.parentNode === R.dom.stream) R.dom.stream.insertBefore(box, answerWrap);
    else R.dom.stream.appendChild(box);
    R.liveReasoningEl = box;
    return box;
  }
  function renderReasoning() {
    const box = ensureReasoningEl();
    if (!box) return;
    box.textContent = '💭 ' + (R.liveReasoning || '');
    scrollStreamToBottom();
  }

  // 移除思考块 DOM（出错 / 取消回滚时调用，避免残留一个孤立的「💭…」灰块）。
  function removeReasoningEl() {
    if (R.liveReasoningEl && R.liveReasoningEl.parentNode) R.liveReasoningEl.parentNode.removeChild(R.liveReasoningEl);
    R.liveReasoningEl = null;
  }

  // 离开本页（根容器被清空 / 替换）时：取消进行中的流、反注册历史监听，
  // 避免切到别的页后流仍在后台空跑、白白消耗配额，以及历史监听泄漏。
  function observeLeave(container, marker) {
    if (typeof MutationObserver === 'undefined' || !marker) return;
    const myR = R; // 绑定本次 render 的运行时
    const mo = new MutationObserver(() => {
      if (document.contains(marker)) return;
      mo.disconnect();
      // 取消本次 render 自己在途的流
      try { if (myR && myR.currentStreamId && kkapi.cancelStream) kkapi.cancelStream(myR.currentStreamId); } catch (_) {}
      // offHistory 是模块级共享变量：仅当仍是本次 render（未被新 render 取代）时才反注册，
      // 否则本 observer 的微任务回调会在新 render 已重设 offHistory 后，把新 render 刚注册的历史监听误清掉。
      if (R === myR && typeof offHistory === 'function') { try { offHistory(); } catch (_) {} offHistory = null; }
    });
    mo.observe(container, { childList: true });
  }

  // 全局只注册一次的流回调；用闭包里的 R 拿当前运行时，靠 streamId 过滤。
  function registerStreamOnce() {
    if (streamRegistered) return;
    streamRegistered = true;
    kkapi.onStream((ev) => {
      if (!R || !ev || ev.streamId !== R.currentStreamId) return;
      if (ev.canceled) { // 被主动取消（切图/离开页）：静默收尾，不报错
        removeReasoningEl();
        R.liveBodyEl = null;
        R.currentStreamId = null;
        setBusy(false);
        return;
      }
      if (ev.error) {
        if (R.liveBodyEl && !R.liveText) {
          const w = R.liveBodyEl.parentNode;
          if (w && w.parentNode) w.parentNode.removeChild(w);
        } else if (R.liveBodyEl) {
          R.liveBodyEl.textContent = R.liveText;
        }
        removeReasoningEl();
        R.liveBodyEl = null;
        R.currentStreamId = null;
        setBusy(false);
        showError(ev.error);
        return;
      }
      if (ev.reasoning) {
        R.liveReasoning = (R.liveReasoning || '') + ev.reasoning;
        renderReasoning();
      }
      if (ev.delta) {
        R.liveText += ev.delta;
        if (R.liveBodyEl) {
          R.liveBodyEl.textContent = R.liveText;
          // 重新补上闪烁光标（textContent 赋值会清掉子节点）
          R.liveBodyEl.appendChild(el('span', 'kk-ai-cursor'));
          scrollStreamToBottom();
        }
      }
      if (ev.done) finishStream();
    });
  }

  // ------------------------------------------------------------
  // 忙碌态：禁用发送 / 能力胶囊
  // ------------------------------------------------------------
  function setBusy(busy) {
    R.streaming = busy;
    const d = R.dom;
    if (d.sendBtn) {
      const span = d.sendBtn.querySelector('span');
      if (span) span.textContent = busy ? '回复中…' : '发送';
      // busy 时强制禁用；否则按是否有文本决定
      if (busy) d.sendBtn.disabled = true;
      else refreshSendEnabled();
    }
    (d.chips || []).forEach((c) => {
      c.disabled = busy;
    });
    if (d.ocrRunBtn) d.ocrRunBtn.disabled = busy;
  }

  function refreshSendEnabled() {
    const d = R.dom;
    if (!d.sendBtn || !d.input) return;
    const hasText = d.input.value.trim().length > 0;
    d.sendBtn.disabled = R.streaming || !hasText;
  }

  // ------------------------------------------------------------
  // 能力：问图 / OCR / 翻译 / 总结 / 润色
  // ------------------------------------------------------------
  function needImage() {
    if (!R.currentDataURL) {
      showError('请先在左侧选择一张截图。');
      return false;
    }
    return true;
  }

  // 问图：多模态视觉模型
  async function doAsk() {
    if (R.streaming || !needImage()) return;
    const ds = (R.config && R.config.deepseek) || {};
    const prompt = ds.askImagePrompt || '请识别并解释这张截图里的内容，用中文回答。';
    appendMessage('user', '（针对当前截图）请帮我分析这张图片。');
    R.messages.push({ role: 'user', content: '（针对刚才的截图）' + prompt });
    const id = beginStream();
    try {
      await kkapi.askImage({ dataURL: R.currentDataURL, prompt, streamId: id, think: true });
    } catch (e) {
      handleCallError(e);
    }
  }

  // OCR：识别图片文字，填入可编辑区，可复制
  async function doOCR() {
    if (R.streaming || !needImage()) return;
    showOCRBox(true);
    const d = R.dom;
    const myR = R, reqId = R.currentId, reqURL = R.currentDataURL; // 后到丢弃快照
    d.ocrArea.value = '';
    d.ocrArea.placeholder = '识别中…';
    setBusy(true); // OCR 期间锁定能力胶囊/发送/重识别，避免与翻译/总结/问图并发互相踩结果
    try {
      const res = await kkapi.runOCR({ dataURL: reqURL });
      // 后到丢弃：OCR 期间若切了图(currentId 变)或离开页(R 被替换)，旧图结果不能写回新会话，否则 A 图文字污染 B 图、
      // 后续翻译/总结会处理到 A 的内容。setBusy 只锁能力胶囊不锁左栏缩略图，故切图可达。
      if (R !== myR || R.currentId !== reqId) return;
      if (res && res.error) {
        d.ocrArea.placeholder = '识别失败';
        showError('OCR 识别失败：' + res.error);
        return;
      }
      const text = (res && res.text) || '';
      d.ocrArea.value = text;
      R.ocrText = text;
      d.ocrArea.placeholder = '（未识别到文字，可手动输入后再翻译 / 总结 / 润色）';
      if (!text) {
        showError('未识别到文字。可在识别框内手动输入，再做翻译 / 总结 / 润色。');
      } else {
        appendMessage('assistant', '已识别出文字，已填入下方「识别结果」可编辑框。可继续翻译 / 总结 / 润色，或复制。');
      }
    } catch (e) {
      if (R !== myR || R.currentId !== reqId) return; // 过期的旧图失败态不写回新会话
      d.ocrArea.placeholder = '识别失败';
      showError('OCR 识别失败：' + (e && e.message ? e.message : e));
    } finally {
      // 仅在仍是本次运行时+同一张图时解锁，避免切图后覆盖新会话的状态（切图时 selectImage 已自行 setBusy）。
      if (R === myR && R.currentId === reqId) setBusy(false);
    }
  }

  // 取出要做文本任务的内容来源：优先 OCR 可编辑区，其次输入框，再退到 messages 文本。
  function pickText() {
    const d = R.dom;
    const ocr = d.ocrArea && d.ocrArea.value.trim();
    if (ocr) return ocr;
    const inp = d.input && d.input.value.trim();
    if (inp) return inp;
    return '';
  }

  // 文本任务通用：翻译 / 总结 / 润色
  async function doTextTask(kind) {
    if (R.streaming) return;
    const d = R.dom;
    const content = pickText();
    if (!content) {
      showError('请先获取文本：可先对图片做 OCR，或在「识别结果」框 / 下方输入框里输入文字。');
      return;
    }
    // pickText 优先取 OCR 区、其次输入框；若本次内容来自输入框，发送后清空它，避免回车重复发送同一段（与 sendInput 对齐）。
    const fromInput = !(d.ocrArea && d.ocrArea.value.trim()) && d.input && d.input.value.trim() === content;
    const ds = (R.config && R.config.deepseek) || {};
    let prompt;
    let label;
    if (kind === 'translate') {
      prompt = ds.translatePrompt || '请翻译下面这段文字：如果是中文则翻译成英文，否则翻译成中文。只输出翻译结果，不要解释。';
      label = '翻译';
    } else if (kind === 'polish') {
      prompt = ds.polishPrompt || '请润色下面这段文字，使其更通顺、专业、自然。保持原意，只输出润色后的文字。';
      label = '润色';
    } else {
      // 总结：题目固定提示词
      prompt = '请用要点总结以下内容';
      label = '总结';
    }
    appendMessage('user', label + '：\n' + content);
    if (fromInput) { d.input.value = ''; autoGrow(); refreshSendEnabled(); }
    const userContent = prompt + '\n\n' + content;
    const id = beginStream();
    try {
      // 本轮把「提示词 + 正文」拼好后单独发出去完成任务；但只把用户可见的「标签 + 原文」并入历史，
      // 不让「请翻译…」这类系统级提示词污染后续追问上下文（避免之后普通提问也被当成翻译/润色）。
      const oneShot = R.messages.concat([{ role: 'user', content: userContent }]);
      R.messages.push({ role: 'user', content: label + '：\n' + content });
      // 不传 model：让主进程按当前 provider（deepseek/minimax/openai/auto）选对应 textModel。
      // 若在此写死 deepseek.textModel，provider 切到别家时会把 DeepSeek 模型名发给异构端点导致报错。
      await kkapi.chat({ messages: oneShot, streamId: id });
    } catch (e) {
      handleCallError(e);
    }
  }

  // 底部输入框发送（追问 / 自由对话）
  async function sendInput() {
    const d = R.dom;
    const text = d.input.value.trim();
    if (!text || R.streaming) return;
    d.input.value = '';
    autoGrow();
    refreshSendEnabled();

    appendMessage('user', text);
    R.messages.push({ role: 'user', content: text });
    const id = beginStream();
    try {
      // 不传 model：由主进程按当前 provider 选 textModel（见 doTextTask 同款说明）。
      await kkapi.chat({ messages: R.messages.slice(), streamId: id, think: true });
    } catch (e) {
      handleCallError(e);
    }
  }

  function autoGrow() {
    const t = R.dom.input;
    if (!t) return;
    t.style.height = 'auto';
    t.style.height = Math.min(t.scrollHeight, 132) + 'px';
  }

  // ------------------------------------------------------------
  // 左栏：历史列表
  // ------------------------------------------------------------
  function renderHistoryList() {
    const list = R.dom.historyList;
    if (!list) return;
    list.innerHTML = '';
    if (!R.history.length) {
      const empty = el('div', 'kk-ai-side-empty');
      empty.appendChild(svgIcon(ICONS.camera, 'ico-lg'));
      empty.appendChild(el('div', 'kk-ai-side-empty-t', '暂无截图'));
      empty.appendChild(el('div', 'kk-ai-side-empty-d', '去截一张图，再回到这里让 AI 分析。'));
      const goBtn = el('button', 'btn btn-soft kk-ai-mini', '去截图');
      goBtn.addEventListener('click', () => {
        try {
          window.KKMain.go('capture');
        } catch (_) {}
      });
      empty.appendChild(goBtn);
      list.appendChild(empty);
      return;
    }
    R.history.forEach((it) => {
      const card = el('button', 'kk-ai-thumb' + (it.id === R.currentId ? ' is-active' : ''));
      card.setAttribute('type', 'button');
      const imgWrap = el('div', 'kk-ai-thumb-img');
      if (it.thumb) {
        const img = document.createElement('img');
        img.src = it.thumb;
        img.alt = '';
        imgWrap.appendChild(img);
      } else {
        imgWrap.appendChild(svgIcon(ICONS.camera, 'ico-lg'));
      }
      card.appendChild(imgWrap);

      const meta = el('div', 'kk-ai-thumb-meta');
      meta.appendChild(el('div', 'kk-ai-thumb-time', fmtTime(it.time)));
      const dim = [it.width, it.height].filter(Boolean).join('×');
      meta.appendChild(el('div', 'kk-ai-thumb-dim', dim || (it.type || '图片')));
      card.appendChild(meta);

      card.addEventListener('click', () => selectImage(it.id));
      list.appendChild(card);
    });
  }

  // 选中某张历史图片：取原图、更新中栏预览、并重置对话上下文。
  async function selectImage(id) {
    if (id == null) return;
    const myR = R; // 绑定本次调用的运行时，await 后用于丢弃过期/被取代的结果
    // 点已选中的同一张图：不重置，避免误清空当前对话。
    const switching = id !== R.currentId;
    if (switching) {
      // 切到另一张图＝新的对话主题：取消针对上一张图、仍在进行的流，并清空对话历史 / OCR 结果 / 消息流，
      // 否则后续提问会带着上一张图的问答上下文，导致 AI 拿 A 图的内容回答 B 图（跨图串话）。
      if (R.currentStreamId) {
        try { if (kkapi.cancelStream) kkapi.cancelStream(R.currentStreamId); } catch (_) {}
      }
      R.currentStreamId = null;
      R.messages = [];
      R.ocrText = '';
      R.liveBodyEl = null;
      R.liveText = '';
      R.liveReasoning = '';
      R.liveReasoningEl = null;
      setBusy(false);
      resetStream();
      if (R.dom.ocrArea) R.dom.ocrArea.value = '';
      showOCRBox(false);
    }
    R.currentId = id;
    renderHistoryList(); // 更新高亮
    const preview = R.dom.preview;
    preview.innerHTML = '';
    const loading = el('div', 'kk-ai-preview-empty');
    loading.appendChild(el('div', 'status loading', '加载原图…'));
    preview.appendChild(loading);

    try {
      const res = await kkapi.historyGet(id);
      // 后到丢弃：await 期间用户若又点了别的图（currentId 变）或离开页（R 被新 render 替换），本次结果作废，
      // 否则会把这张图的 dataURL 写到「当前/新」运行时，造成 currentDataURL 与高亮/currentId 错配、AI 拿错图分析。
      if (R !== myR || R.currentId !== id) return;
      const dataURL = (res && (res.dataURL || (res.item && res.item.dataURL))) || '';
      if (!dataURL) {
        preview.innerHTML = '';
        preview.appendChild(buildPreviewEmpty('无法加载该图片原图。'));
        R.currentDataURL = '';
        return;
      }
      R.currentDataURL = dataURL;
      preview.innerHTML = '';
      const img = document.createElement('img');
      img.className = 'kk-ai-preview-img';
      img.src = dataURL;
      img.alt = '当前截图';
      img.title = '点击放大查看';
      img.addEventListener('click', () => openLightbox(dataURL));
      preview.appendChild(img);
      refreshSendEnabled();
    } catch (e) {
      if (R !== myR || R.currentId !== id) return; // 同上：过期/被取代的失败态不写回当前运行时
      preview.innerHTML = '';
      preview.appendChild(buildPreviewEmpty('加载失败：' + (e && e.message ? e.message : e)));
      R.currentDataURL = '';
    }
  }

  function buildPreviewEmpty(msg) {
    const box = el('div', 'kk-ai-preview-empty');
    box.appendChild(svgIcon(ICONS.camera, 'ico-lg'));
    box.appendChild(el('div', 'kk-ai-preview-empty-t', msg || '从左侧选择一张截图'));
    box.appendChild(el('div', 'kk-ai-preview-empty-d', '选中后可在右侧让 AI 问图 / OCR / 翻译 / 总结 / 润色。'));
    return box;
  }

  // ------------------------------------------------------------
  // 放大查看（轻量灯箱，挂到 #page 内）
  // ------------------------------------------------------------
  function openLightbox(dataURL) {
    closeLightbox();
    const mask = el('div', 'kk-ai-lightbox');
    mask.id = 'kkAiLightbox';
    const img = document.createElement('img');
    img.src = dataURL;
    img.alt = '';
    mask.appendChild(img);
    const closeBtn = el('button', 'icon-btn kk-ai-lightbox-close');
    closeBtn.appendChild(svgIcon(ICONS.close));
    mask.appendChild(closeBtn);
    const onClose = () => closeLightbox();
    mask.addEventListener('click', (e) => {
      if (e.target === mask) onClose();
    });
    closeBtn.addEventListener('click', onClose);
    const onKey = (e) => {
      if (e.key === 'Escape') {
        onClose();
        document.removeEventListener('keydown', onKey);
      }
    };
    document.addEventListener('keydown', onKey);
    mask._onKey = onKey;
    (R.dom.root || document.body).appendChild(mask);
  }

  function closeLightbox() {
    const old = document.getElementById('kkAiLightbox');
    if (old) {
      if (old._onKey) document.removeEventListener('keydown', old._onKey);
      if (old.parentNode) old.parentNode.removeChild(old);
    }
  }

  // ------------------------------------------------------------
  // OCR 可编辑框显隐
  // ------------------------------------------------------------
  function showOCRBox(show) {
    const w = R.dom.ocrWrap;
    if (w) w.hidden = !show;
  }

  // ============================================================
  // 构建整页 DOM
  // ============================================================
  function buildUI(root) {
    root.innerHTML = '';
    root.classList.add('kk-ai-root');
    R.dom.root = root;
    root.classList.add('is-left-collapsed'); // 默认折叠左栏历史缩略图，工作台更清爽
    root.classList.add('is-mid-collapsed'); // 默认折叠中栏图片预览，聚焦 AI 对话

    // ---- 左栏：历史缩略图 ----
    const left = el('aside', 'kk-ai-left card');
    const leftHead = el('div', 'kk-ai-col-head');
    const lh = el('div', 'group-title');
    lh.appendChild(svgIcon(ICONS.history));
    lh.appendChild(el('span', null, '历史截图'));
    leftHead.appendChild(lh);
    // 折叠 / 展开按钮（默认折叠，工作台聚焦 AI 对话）
    const leftToggle = el('button', 'btn btn-ghost kk-ai-mini kk-ai-left-toggle');
    leftToggle.setAttribute('type', 'button');
    leftToggle.title = '折叠 / 展开历史截图';
    leftToggle.textContent = '»'; // 默认折叠态，箭头朝外表示可展开
    leftToggle.addEventListener('click', () => {
      const collapsed = root.classList.toggle('is-left-collapsed');
      leftToggle.textContent = collapsed ? '»' : '«';
    });
    leftHead.appendChild(leftToggle);
    left.appendChild(leftHead);
    const historyList = el('div', 'kk-ai-history-list');
    left.appendChild(historyList);
    R.dom.historyList = historyList;

    // ---- 中栏：当前图片预览 ----
    const mid = el('section', 'kk-ai-mid card');
    const midHead = el('div', 'kk-ai-col-head');
    const mhTitle = el('div', 'group-title');
    mhTitle.appendChild(svgIcon(ICONS.camera));
    mhTitle.appendChild(el('span', null, '当前图片'));
    midHead.appendChild(mhTitle);
    const backBtn = el('button', 'btn btn-ghost kk-ai-mini');
    backBtn.appendChild(svgIcon(ICONS.history, 'ico-sm'));
    backBtn.appendChild(el('span', null, '回到历史'));
    backBtn.addEventListener('click', () => {
      try {
        window.KKMain.go('history');
      } catch (_) {}
    });
    midHead.appendChild(backBtn);
    // 折叠 / 展开图片预览（默认折叠，聚焦 AI 对话；需要看图时展开）
    const midToggle = el('button', 'btn btn-ghost kk-ai-mini kk-ai-mid-toggle');
    midToggle.setAttribute('type', 'button');
    midToggle.title = '折叠 / 展开图片预览';
    midToggle.textContent = '»';
    midToggle.addEventListener('click', () => {
      const collapsed = root.classList.toggle('is-mid-collapsed');
      midToggle.textContent = collapsed ? '»' : '«';
    });
    midHead.appendChild(midToggle);
    mid.appendChild(midHead);

    const preview = el('div', 'kk-ai-preview');
    preview.appendChild(buildPreviewEmpty());
    mid.appendChild(preview);
    R.dom.preview = preview;

    // ---- 右栏：对话式工作区 ----
    const right = el('section', 'kk-ai-right card');

    // 能力胶囊行
    const chipRow = el('div', 'kk-ai-chips');
    R.dom.chips = [];
    const chipDefs = [
      { key: 'ask', label: '问图', icon: ICONS.ai, run: doAsk },
      { key: 'ocr', label: 'OCR', icon: ICONS.ocr, run: doOCR },
      { key: 'translate', label: '翻译', icon: ICONS.translate, run: () => doTextTask('translate') },
      { key: 'summary', label: '总结', icon: ICONS.summary, run: () => doTextTask('summary') },
      { key: 'polish', label: '润色', icon: ICONS.polish, run: () => doTextTask('polish') },
    ];
    chipDefs.forEach((def) => {
      const chip = el('button', 'chip');
      chip.setAttribute('type', 'button');
      chip.appendChild(svgIcon(def.icon, 'ico-sm'));
      chip.appendChild(el('span', null, def.label));
      chip.addEventListener('click', def.run);
      chipRow.appendChild(chip);
      R.dom.chips.push(chip);
    });
    right.appendChild(chipRow);

    // OCR 可编辑结果区（默认隐藏，OCR 后出现）
    const ocrWrap = el('div', 'kk-ai-ocr');
    ocrWrap.hidden = true;
    const ocrHead = el('div', 'kk-ai-ocr-head');
    ocrHead.appendChild(el('span', 'label', '识别结果（可编辑）'));
    const ocrActions = el('div', 'kk-ai-ocr-actions');
    const ocrCopy = el('button', 'btn btn-ghost kk-ai-mini');
    ocrCopy.appendChild(svgIcon(ICONS.copy, 'ico-sm'));
    ocrCopy.appendChild(el('span', null, '复制'));
    ocrCopy.addEventListener('click', async () => {
      const t = R.dom.ocrArea.value;
      if (!t) return;
      try {
        await kkapi.copyText(t);
        flashBtn(ocrCopy, '已复制 ✓');
      } catch (_) {}
    });
    const ocrRedo = el('button', 'btn btn-ghost kk-ai-mini');
    ocrRedo.appendChild(svgIcon(ICONS.ocr, 'ico-sm'));
    ocrRedo.appendChild(el('span', null, '重新识别'));
    ocrRedo.addEventListener('click', doOCR);
    ocrActions.appendChild(ocrRedo);
    ocrActions.appendChild(ocrCopy);
    ocrHead.appendChild(ocrActions);
    ocrWrap.appendChild(ocrHead);
    R.dom.ocrRunBtn = ocrRedo;

    const ocrArea = document.createElement('textarea');
    ocrArea.className = 'textarea kk-ai-ocr-area';
    ocrArea.placeholder = '（OCR 结果会出现在这里，可编辑后翻译 / 总结 / 润色）';
    ocrArea.addEventListener('input', () => {
      R.ocrText = ocrArea.value;
    });
    ocrWrap.appendChild(ocrArea);
    right.appendChild(ocrWrap);
    R.dom.ocrWrap = ocrWrap;
    R.dom.ocrArea = ocrArea;

    // 消息流
    const stream = el('div', 'kk-ai-stream');
    const streamEmpty = el('div', 'kk-ai-stream-empty');
    streamEmpty.appendChild(svgIcon(ICONS.ai, 'ico-lg'));
    streamEmpty.appendChild(el('div', 'kk-ai-stream-empty-t', 'AI 工作区'));
    streamEmpty.appendChild(
      el('div', 'kk-ai-stream-empty-d', '选好图片后，点上方能力胶囊，或在下方输入问题开始对话。')
    );
    stream.appendChild(streamEmpty);
    right.appendChild(stream);
    R.dom.stream = stream;
    R.dom.streamEmpty = streamEmpty;

    // 底部输入区
    const composer = el('div', 'kk-ai-composer');
    const input = document.createElement('textarea');
    input.className = 'textarea kk-ai-input';
    input.placeholder = '输入问题，回车发送，Shift+回车换行';
    input.rows = 1;
    input.addEventListener('input', () => {
      autoGrow();
      refreshSendEnabled();
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        sendInput();
      }
    });
    const sendBtn = el('button', 'btn btn-primary kk-ai-send');
    sendBtn.setAttribute('type', 'button');
    sendBtn.appendChild(svgIcon(ICONS.send, 'ico-sm'));
    sendBtn.appendChild(el('span', null, '发送'));
    sendBtn.disabled = true;
    sendBtn.addEventListener('click', sendInput);
    composer.appendChild(input);
    composer.appendChild(sendBtn);
    right.appendChild(composer);
    R.dom.input = input;
    R.dom.sendBtn = sendBtn;

    // 三栏装入根容器
    root.appendChild(left);
    root.appendChild(mid);
    root.appendChild(right);
  }

  // ============================================================
  // 注册页面
  // ============================================================
  window.KKPages.ai = {
    title: 'AI 工作台',
    async render(el2, ctx) {
      // 清理上一轮可能残留的灯箱与历史监听
      closeLightbox();
      if (offHistory) {
        try {
          offHistory();
        } catch (_) {}
        offHistory = null;
      }

      el2.innerHTML = '';
      R = newRuntime();
      buildUI(el2);
      registerStreamOnce();
      observeLeave(el2, R.dom.stream);

      // 历史列表变化时刷新左栏
      try {
        offHistory = kkapi.onHistoryChanged(async () => {
          try {
            R.history = (await kkapi.historyList()) || [];
            renderHistoryList();
          } catch (_) {}
        });
      } catch (_) {}

      // 先拿配置（含 prompts），失败也不阻塞 UI，仅在调用时报错
      try {
        R.config = await kkapi.getConfig();
      } catch (e) {
        R.config = null;
      }
      // 若未配 API Key，先给一条提示（不阻断浏览图片）。
      // 按当前 provider 校验对应服务商的 Key，而非一律查 DeepSeek——否则用 MiniMax/OpenAI 的
      // 用户即使配好了 Key 也会被误报「未配置 DeepSeek Key」。
      const cfg = R.config || {};
      const provider = (cfg.ai && cfg.ai.provider) || 'deepseek';
      const KEY_OF = {
        deepseek: { key: (cfg.deepseek || {}).apiKey, label: 'DeepSeek' },
        minimax: { key: (cfg.minimax || {}).apiKey, label: 'MiniMax' },
        openai: { key: (cfg.openai || {}).apiKey, label: '所选 AI 服务商' },
      };
      // auto（智能分流）：文本走 openai(若配)否则 deepseek，看图走 minimax。
      // 只要三家里有任一 Key 就认为可用，全空才提示。
      let missing = null;
      if (provider === 'auto') {
        const anyKey =
          (cfg.deepseek || {}).apiKey || (cfg.minimax || {}).apiKey || (cfg.openai || {}).apiKey;
        if (!anyKey) missing = 'AI';
      } else {
        const ent = KEY_OF[provider] || KEY_OF.deepseek;
        if (!ent.key) missing = ent.label;
      }
      if (missing) {
        showError('尚未配置 ' + missing + ' API Key，AI 能力暂不可用。');
      }

      // 拉取历史列表
      try {
        R.history = (await kkapi.historyList()) || [];
      } catch (e) {
        R.history = [];
      }
      renderHistoryList();

      // 预选：ctx.imageId 优先，否则默认选第一张
      const wantId =
        ctx && ctx.imageId != null
          ? ctx.imageId
          : R.history.length
          ? R.history[0].id
          : null;
      if (wantId != null) {
        await selectImage(wantId);
      }
      refreshSendEnabled();
    },
  };
})();
