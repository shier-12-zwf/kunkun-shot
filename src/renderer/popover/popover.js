// 困困截图工具 · 菜单栏弹窗逻辑
// 纯浏览器环境，仅通过 window.kkapi 与主进程通信，禁止 require/import node/electron。
(function () {
  'use strict';

  const api = window.kkapi;

  // ---- DOM 引用 ----
  const el = {
    pop: document.getElementById('pop'),
    headStatus: document.getElementById('headStatus'),
    btnSettings: document.getElementById('btnSettings'),

    btnRegion: document.getElementById('btnRegion'),
    hintRegion: document.getElementById('hintRegion'),
    btnWindow: document.getElementById('btnWindow'),
    btnLong: document.getElementById('btnLong'),
    btnRecord: document.getElementById('btnRecord'),
    btnFull: document.getElementById('btnFull'),

    statusRow: document.getElementById('statusRow'),
    statusBadge: document.getElementById('statusBadge'),

    btnAllHistory: document.getElementById('btnAllHistory'),
    recentCard: document.getElementById('recentCard'),
    recentThumb: document.getElementById('recentThumb'),
    recentName: document.getElementById('recentName'),
    recentSub: document.getElementById('recentSub'),

    chipRow: document.getElementById('chipRow'),
    chipAsk: document.getElementById('chipAsk'),
    chipOcr: document.getElementById('chipOcr'),
    chipTranslate: document.getElementById('chipTranslate'),
    aiHint: document.getElementById('aiHint'),

    copyToggle: document.getElementById('copyToggle'),
    btnOpenMain: document.getElementById('btnOpenMain'),
  };

  // 最近一张截图（用于 AI 操作判定可用性）
  let latestItem = null;
  // 状态条自动隐藏的计时器
  let statusTimer = null;

  // ============ 状态反馈（原位 .status，不弹遮挡层） ============
  function showStatus(kind, text, autoHide) {
    if (statusTimer) { clearTimeout(statusTimer); statusTimer = null; }
    el.statusBadge.className = 'status ' + (kind || 'loading');
    el.statusBadge.textContent = text || '';
    el.statusRow.hidden = false;
    if (autoHide) {
      statusTimer = setTimeout(hideStatus, 2200);
    }
  }
  function hideStatus() {
    if (statusTimer) { clearTimeout(statusTimer); statusTimer = null; }
    el.statusRow.hidden = true;
    el.statusBadge.textContent = '';
  }

  function setHeadStatus(text) {
    el.headStatus.textContent = text || '就绪';
  }

  // ============ 时间格式化 ============
  function fmtTime(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    if (isNaN(d.getTime())) return '';
    const now = new Date();
    const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    const sameDay = d.getFullYear() === now.getFullYear()
      && d.getMonth() === now.getMonth()
      && d.getDate() === now.getDate();
    if (sameDay) return `今天 ${hm}`;
    return `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
  }

  function typeLabel(type) {
    const map = {
      region: '区域截图',
      ocr: 'OCR 截图',
      long: '长截图',
      record: '录屏',
      fullscreen: '全屏截图',
      window: '窗口截图',
      timed: '延时截图',
    };
    return map[type] || '截图';
  }

  // ============ 加载主题（跟随 config.general.theme） ============
  async function applyTheme() {
    try {
      const cfg = await api.getConfig();
      const theme = cfg && cfg.general && cfg.general.theme;
      document.body.classList.toggle('theme-dark', theme === 'dark');
      // 自动复制开关同步
      const copyAfter = !!(cfg && cfg.capture && cfg.capture.copyAfterCapture);
      el.copyToggle.checked = copyAfter;
      // 区域截图快捷键提示
      const acc = cfg && cfg.shortcuts && cfg.shortcuts.capture;
      el.hintRegion.textContent = acc ? formatAccelerator(acc) : '';
    } catch (_) {
      // 配置读取失败时静默降级，不影响主功能
    }
  }

  // 把 Electron accelerator 字符串转成 macOS 风格的简洁符号
  function formatAccelerator(acc) {
    if (!acc) return '';
    return String(acc)
      .replace(/CommandOrControl|CmdOrCtrl/gi, '⌘')
      .replace(/Command|Cmd|Meta|Super/gi, '⌘')
      .replace(/Control|Ctrl/gi, '⌃')
      .replace(/Option|Alt/gi, '⌥')
      .replace(/Shift/gi, '⇧')
      .replace(/\+/g, '');
  }

  // ============ 最近截图 ============
  async function refreshRecent() {
    let list = [];
    try {
      list = await api.historyList();
    } catch (_) {
      list = [];
    }
    latestItem = Array.isArray(list) && list.length ? list[0] : null;

    if (latestItem) {
      el.recentCard.classList.remove('empty');
      el.recentThumb.style.backgroundImage = latestItem.thumb ? `url("${latestItem.thumb}")` : 'none';
      el.recentName.textContent = typeLabel(latestItem.type) + (
        latestItem.width && latestItem.height ? `  ${latestItem.width}×${latestItem.height}` : ''
      );
      el.recentSub.textContent = fmtTime(latestItem.time) || '刚刚';
    } else {
      el.recentCard.classList.add('empty');
      el.recentThumb.style.backgroundImage = 'none';
      el.recentName.textContent = '暂无截图';
      el.recentSub.textContent = '截一张图后会出现在这里';
    }

    // AI 胶囊可用性：无最近图则禁用并提示
    const hasImg = !!latestItem;
    [el.chipAsk, el.chipOcr, el.chipTranslate].forEach((c) => { c.disabled = !hasImg; });
    el.aiHint.hidden = hasImg;
  }

  // ============ 捕获动作（带原位状态反馈） ============
  // region/record 走 triggerCapture：触发后主进程接管，弹窗收起即可
  function bindTrigger(btn, mode, label) {
    btn.addEventListener('click', async () => {
      try {
        await api.triggerCapture(mode);
      } catch (_) {
        // 即便失败也收起，避免弹窗卡住
      }
      await api.hidePopover();
    });
  }

  // captureFullscreenNow / captureWindow 只负责打开统一编辑器，最终输出由用户在编辑器确认。
  function bindCapture(btn, fn, busyText) {
    btn.addEventListener('click', async () => {
      setBusy(true);
      showStatus('loading', busyText);
      try {
        const res = await fn();
        if (res && res.ok) {
          showStatus('ok', '编辑器已打开', true);
          // 成功后短暂停留再收起弹窗
          setTimeout(() => { api.hidePopover(); }, 650);
        } else {
          const msg = (res && res.error) ? res.error : '捕获失败';
          showStatus('err', msg, true);
        }
      } catch (err) {
        showStatus('err', (err && err.message) ? err.message : '捕获出错', true);
      } finally {
        setBusy(false);
      }
    });
  }

  function setBusy(busy) {
    [el.btnRegion, el.btnWindow, el.btnLong, el.btnRecord, el.btnFull].forEach((b) => { b.disabled = busy; });
    setHeadStatus(busy ? '处理中…' : '就绪');
  }

  // ============ AI 胶囊：对最近一张截图操作 ============
  async function runAI(mode) {
    if (!latestItem) {
      el.aiHint.hidden = false;
      return;
    }
    setHeadStatus('准备图片…');
    showStatus('loading', '正在打开 AI 工作台…');
    try {
      const got = await api.historyGet(latestItem.id);
      const dataURL = got && got.dataURL;
      if (!dataURL) {
        showStatus('err', '无法读取该截图', true);
        setHeadStatus('就绪');
        return;
      }
      await api.openAIPanel({ mode, dataURL });
      await api.hidePopover();
    } catch (err) {
      showStatus('err', (err && err.message) ? err.message : '打开失败', true);
      setHeadStatus('就绪');
    }
  }

  // ============ 事件绑定 ============
  function bindEvents() {
    // 设置入口
    el.btnSettings.addEventListener('click', async () => {
      await api.openMain('settings');
      await api.hidePopover();
    });

    // 主操作
    bindTrigger(el.btnRegion, 'region', '区域截图');
    bindTrigger(el.btnLong, 'long', '长截图');
    bindTrigger(el.btnRecord, 'record', '录屏');
    bindCapture(el.btnWindow, () => api.captureWindow(), '正在选择窗口…');
    bindCapture(el.btnFull, () => api.captureFullscreenNow(), '正在全屏截图…');

    // 最近截图 / 查看全部 → 历史页
    const openHistory = async () => {
      await api.openMain('history');
      await api.hidePopover();
    };
    el.recentCard.addEventListener('click', () => {
      if (el.recentCard.classList.contains('empty')) return;
      openHistory();
    });
    el.btnAllHistory.addEventListener('click', (e) => { e.stopPropagation(); openHistory(); });

    // AI 胶囊
    el.chipAsk.addEventListener('click', () => runAI('ask'));
    el.chipOcr.addEventListener('click', () => runAI('ocr'));
    el.chipTranslate.addEventListener('click', () => runAI('translateImage'));

    // 自动复制开关：读写 config.capture.copyAfterCapture
    el.copyToggle.addEventListener('change', async () => {
      const next = el.copyToggle.checked;
      try {
        await api.setConfig({ capture: { copyAfterCapture: next } });
        showStatus('ok', next ? '已开启截图后自动复制' : '已关闭自动复制', true);
      } catch (_) {
        // 失败回滚开关状态
        el.copyToggle.checked = !next;
        showStatus('err', '设置未能保存', true);
      }
    });

    // 打开主应用
    el.btnOpenMain.addEventListener('click', async () => {
      await api.openMain();
      await api.hidePopover();
    });

    // Esc 收起弹窗
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') api.hidePopover();
    });

    // 历史变化 → 刷新最近截图
    if (typeof api.onHistoryChanged === 'function') {
      api.onHistoryChanged(() => { refreshRecent(); });
    }

    // 每次弹窗重新可见时刷新（窗口聚焦视为重新打开）
    window.addEventListener('focus', () => {
      applyTheme();
      refreshRecent();
    });
  }

  // ============ 初始化 ============
  function init() {
    bindEvents();
    applyTheme();
    refreshRecent();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
