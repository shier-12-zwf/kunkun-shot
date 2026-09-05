// 划词翻译卡片渲染层。数据由主进程通过 kkapi.onTranslatePopup 推送。
// 渲染层硬约束：不 require node/electron，只走 window.kkapi。
(function () {
  'use strict';

  const api = window.kkapi;
  const $ = (id) => document.getElementById(id);

  const elSrc = $('src');
  const elTrans = $('trans');
  const elTarget = $('target');
  const elLoading = $('loading');
  const btnClose = $('btnClose');
  const btnCopy = $('btnCopy');

  let currentTranslation = '';

  function close() {
    if (api && api.closeTranslatePopup) api.closeTranslatePopup();
  }

  // 渲染一帧数据：{ text, target, loading?, translation?, error? }
  function render(data) {
    if (!data) return;
    if (typeof data.text === 'string') elSrc.textContent = data.text;
    if (data.target) elTarget.textContent = '→ ' + data.target;

    if (data.loading) {
      currentTranslation = '';
      elTrans.className = 'tp-trans';
      elTrans.innerHTML = '';
      if (elLoading) elTrans.appendChild(elLoading);
      btnCopy.disabled = true;
      return;
    }

    if (data.error) {
      currentTranslation = '';
      elTrans.className = 'tp-trans err';
      elTrans.textContent = data.error;
      btnCopy.disabled = true;
      return;
    }

    if (typeof data.translation === 'string') {
      currentTranslation = data.translation;
      elTrans.className = 'tp-trans';
      elTrans.textContent = data.translation;
      btnCopy.disabled = !data.translation;
    }
  }

  if (api && api.onTranslatePopup) {
    api.onTranslatePopup(render);
  }

  btnClose.addEventListener('click', close);

  let copyResetTimer = null;
  function resetCopyButton(delay) {
    clearTimeout(copyResetTimer);
    copyResetTimer = setTimeout(function () {
      btnCopy.classList.remove('copied');
      btnCopy.textContent = '复制译文';
      btnCopy.disabled = !currentTranslation;
    }, delay);
  }

  btnCopy.addEventListener('click', async function () {
    if (!currentTranslation) return;
    const text = currentTranslation;
    btnCopy.disabled = true;
    try {
      if (!api || typeof api.copyText !== 'function') throw new Error('剪贴板功能不可用。');
      const copied = await api.copyText(text);
      if (copied !== true) throw new Error('剪贴板未确认写入。');
      btnCopy.classList.add('copied');
      btnCopy.textContent = '已复制';
      resetCopyButton(1200);
    } catch (_) {
      btnCopy.classList.remove('copied');
      btnCopy.textContent = '复制失败';
      // 如果等待期间已收到新译文，仍恢复成当前内容对应的可用状态。
      if (currentTranslation !== text) btnCopy.disabled = !currentTranslation;
      resetCopyButton(1800);
    }
  });

  // Esc 关闭
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { e.preventDefault(); close(); }
  });
})();
