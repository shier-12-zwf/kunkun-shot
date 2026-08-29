// 困困截图工具 · 快捷截图首页（主窗口页面模块：capture）
// 渲染层硬约束：禁止 require / import 引入 node/electron，所有主进程交互只走 window.kkapi。
// 注册到 window.KKPages.capture，render(el) 幂等：每次先清空容器再重建。
(function () {
  'use strict';

  const api = window.kkapi;

  // ====== 线性图标（与 design.css 统一描边；禁用 Emoji 做功能图标）======
  const ICONS = {
    region: '<path d="M7 3v4H3 M17 3v4h4 M7 21v-4H3 M17 21v-4h4"/>',
    window: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 9h18"/>',
    fullscreen: '<path d="M4 9V4h5 M20 9V4h-5 M4 15v5h5 M20 15v5h-5"/>',
    timer: '<circle cx="12" cy="13" r="8"/><path d="M12 13V9 M9 2h6"/>',
    record: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3" fill="currentColor"/>',
    history: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    camera:
      '<path d="M3 8a2 2 0 0 1 2-2h2l1.2-2h5.6L17 6h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><circle cx="12" cy="12.5" r="3.2"/>',
    chevron: '<path d="M9 6l6 6-6 6"/>',
  };

  // 生成一个线性图标 svg 字符串
  function ico(name, cls) {
    return (
      '<svg class="' +
      (cls || 'ico') +
      '" viewBox="0 0 24 24" aria-hidden="true">' +
      (ICONS[name] || '') +
      '</svg>'
    );
  }

  // 把 Electron accelerator 字符串美化成 macOS 风格的按键显示
  function prettyKey(acc) {
    if (!acc) return '';
    return acc
      .replace(/CommandOrControl/gi, '⌘') // ⌘
      .replace(/Command/gi, '⌘')
      .replace(/\bCmd\b/gi, '⌘')
      .replace(/Control/gi, '⌃') // ⌃
      .replace(/\bCtrl\b/gi, '⌃')
      .replace(/Option/gi, '⌥') // ⌥
      .replace(/\bAlt\b/gi, '⌥')
      .replace(/Shift/gi, '⇧') // ⇧
      .replace(/\+/g, ' ');
  }

  // ====== 页面注册 ======
  window.KKPages = window.KKPages || {};
  window.KKPages.capture = {
    title: '快捷截图',
    render(el /*, ctx */) {
      el.innerHTML = '';

      // 本页运行期状态
      let config = null; // 最近一次拿到的完整配置
      let offHistory = null; // onHistoryChanged 退订函数
      let countdownTimer = null; // 延时倒计时句柄
      let timedJobId = null; // 主进程持有的定时任务 id
      let timedScheduling = false; // invoke 尚未返回时防止重复排程
      let countdownGeneration = 0; // 取消时使迟到的排程响应失效
      let pageActive = true;
      let delaySec = 3; // 当前选择的延时秒数（3/5/10）

      // —— 顶部任务式标题 ——
      const header = document.createElement('div');
      header.className = 'cap-header';
      header.innerHTML =
        '<h1 class="cap-title">今天想捕捉什么？</h1>' +
        '<p class="cap-subtitle">点击下方画布开始区域截图，或选择更精准的捕捉方式。</p>';
      el.appendChild(header);

      // —— 中央大尺寸玻璃捕捉区（整块可点击 = 区域截图）——
      const stage = document.createElement('button');
      stage.type = 'button';
      stage.className = 'glass cap-stage';
      stage.setAttribute('aria-label', '区域截图：点击开始框选');
      stage.innerHTML =
        '<div class="cap-stage-inner">' +
        '<div class="cap-marquee">' +
        '<span class="cap-corner tl"></span><span class="cap-corner tr"></span>' +
        '<span class="cap-corner bl"></span><span class="cap-corner br"></span>' +
        '<span class="cap-marquee-size">区域截图</span>' +
        // CSS 画的鼠标指针装饰
        '<svg class="cap-cursor" viewBox="0 0 24 24" aria-hidden="true">' +
        '<path d="M5 3l14 7-6 1.6L9.6 18z"/></svg>' +
        '</div>' +
        '<div class="cap-stage-hint">' +
        ico('camera', 'ico ico-lg') +
        '<span>点击画布 · 拖拽框选你想要的区域</span>' +
        '</div>' +
        '</div>';
      stage.addEventListener('click', () => {
        api.triggerCapture('region');
      });
      el.appendChild(stage);

      // —— 主操作按钮排 ——
      const actions = document.createElement('div');
      actions.className = 'cap-actions';
      el.appendChild(actions);

      // 创建一个操作卡（主按钮 + 下方快捷键/状态小字）
      // opts: {key, icon, label, hint, primary, onClick}
      function makeAction(opts) {
        const wrap = document.createElement('div');
        wrap.className = 'cap-action';
        wrap.dataset.key = opts.key;

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn cap-act-btn' + (opts.primary ? ' btn-primary' : ' btn-ghost');
        btn.innerHTML = ico(opts.icon) + '<span class="cap-act-label">' + opts.label + '</span>';
        if (opts.onClick) btn.addEventListener('click', opts.onClick);
        wrap.appendChild(btn);

        // 下方小字：快捷键（低对比，不抢主按钮）或运行反馈位
        const hint = document.createElement('div');
        hint.className = 'hint cap-act-hint';
        hint.textContent = opts.hint || '';
        wrap.appendChild(hint);

        actions.appendChild(wrap);
        return { wrap, btn, hint };
      }

      // 在某个操作卡的小字位给出 .status 轻反馈（成功/失败/取消，非遮挡式）
      function flash(refs, kind, text) {
        if (!refs || !refs.hint) return;
        refs.hint.innerHTML =
          '<span class="status ' + kind + '">' + escapeHtml(text) + '</span>';
        // 2.4s 后恢复成原本的快捷键提示
        clearTimeout(refs._flashT);
        refs._flashT = setTimeout(() => {
          refs.hint.textContent = refs._defaultHint || '';
        }, 2400);
      }

      function escapeHtml(s) {
        return String(s).replace(/[&<>"']/g, (c) => {
          return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
      }

      // 1) 区域截图（主按钮，带快捷键）
      const aRegion = makeAction({
        key: 'region',
        icon: 'region',
        label: '区域截图',
        primary: true,
        onClick: () => api.triggerCapture('region'),
      });

      // 2) 窗口截图（无快捷键；成功/失败原位反馈）
      const aWindow = makeAction({
        key: 'window',
        icon: 'window',
        label: '窗口截图',
        onClick: async () => {
          aWindow.btn.disabled = true;
          try {
            const r = await api.captureWindow();
            if (r && r.ok) flash(aWindow, 'ok', '已打开窗口编辑器');
            else if (r && r.error) flash(aWindow, 'err', r.error);
            else flash(aWindow, 'warn', '已取消');
          } catch (e) {
            flash(aWindow, 'err', '窗口截图失败');
          } finally {
            aWindow.btn.disabled = false;
          }
        },
      });

      // 3) 全屏截图（无快捷键；成功/失败原位反馈）
      const aFull = makeAction({
        key: 'fullscreen',
        icon: 'fullscreen',
        label: '全屏截图',
        onClick: async () => {
          aFull.btn.disabled = true;
          try {
            const r = await api.captureFullscreenNow();
            if (r && r.ok) flash(aFull, 'ok', '已打开全屏编辑器');
            else if (r && r.error) flash(aFull, 'err', r.error);
            else flash(aFull, 'warn', '已取消');
          } catch (e) {
            flash(aFull, 'err', '全屏截图失败');
          } finally {
            aFull.btn.disabled = false;
          }
        },
      });

      // 4) 延时截图（无快捷键；3s/5s 选择 + 可见倒计时）
      const aTimed = makeAction({
        key: 'timed',
        icon: 'timer',
        label: '延时截图',
        onClick: () => startCountdown(),
      });
      // 延时按钮额外挂一排 3s/5s/10s 选择
      const delayPicker = document.createElement('div');
      delayPicker.className = 'cap-delay-picker';
      [3, 5, 10].forEach((sec) => {
        const c = document.createElement('button');
        c.type = 'button';
        c.className = 'chip cap-delay-chip' + (sec === delaySec ? ' active' : '');
        c.textContent = sec + 's';
        c.dataset.sec = String(sec);
        c.addEventListener('click', (ev) => {
          ev.stopPropagation();
          if (countdownTimer || timedJobId || timedScheduling) return; // 倒计时进行中不允许改秒数
          setDelay(sec);
        });
        delayPicker.appendChild(c);
      });
      // P2-8：自定义秒数输入（1~300s）
      const cCustom = document.createElement('input');
      cCustom.type = 'text';
      cCustom.className = 'chip cap-delay-chip cap-delay-custom';
      cCustom.placeholder = '自定义s';
      cCustom.title = '自定义延时秒数（1~300，回车生效）';
      cCustom.addEventListener('click', (ev) => ev.stopPropagation());
      cCustom.addEventListener('keydown', (ev) => {
        ev.stopPropagation();
        if (ev.key === 'Enter') {
          if (countdownTimer || timedJobId || timedScheduling) return;
          const rawDelay = cCustom.value.trim();
          const v = /^\d+$/.test(rawDelay) ? Number(rawDelay) : NaN;
          if (Number.isInteger(v) && v >= 1 && v <= 300) {
            setDelay(v);
            cCustom.value = '';
          } else {
            cCustom.value = '';
          }
        }
      });
      delayPicker.appendChild(cCustom);
      function setDelay(sec) {
        delaySec = sec;
        delayPicker.querySelectorAll('.cap-delay-chip').forEach((x) => {
          x.classList.toggle('active', Number(x.dataset.sec) === delaySec);
        });
      }
      // 把选择器插到延时卡的按钮和小字之间
      aTimed.wrap.insertBefore(delayPicker, aTimed.hint);

      function drawCountdown(left) {
        const label = aTimed.btn.querySelector('.cap-act-label');
        if (label) label.textContent = left + ' 秒…点此取消';
      }

      function resetCountdownUi() {
        if (countdownTimer) clearInterval(countdownTimer);
        countdownTimer = null;
        aTimed.btn.classList.remove('counting');
        aTimed.wrap.classList.remove('counting');
        const label = aTimed.btn.querySelector('.cap-act-label');
        if (label) label.textContent = '延时截图';
      }

      // 任务在主进程立即排程；页面里的 interval 只负责反馈，不再决定截图是否执行。
      async function startCountdown() {
        if (countdownTimer || timedJobId || timedScheduling) {
          await cancelCountdown();
          return;
        }
        const generation = ++countdownGeneration;
        timedScheduling = true;
        aTimed.btn.classList.add('counting');
        aTimed.wrap.classList.add('counting');
        drawCountdown(delaySec);
        let scheduled;
        try {
          scheduled = await api.captureTimed({ delay: delaySec, mode: 'region' });
        } catch (e) {
          timedScheduling = false;
          if (generation === countdownGeneration && pageActive) {
            resetCountdownUi();
            flash(aTimed, 'err', '延时截图排程失败');
          }
          return;
        }
        timedScheduling = false;
        if (!scheduled || scheduled.ok !== true || !scheduled.id) {
          if (generation === countdownGeneration && pageActive) {
            resetCountdownUi();
            flash(aTimed, 'err', (scheduled && scheduled.error) || '延时截图排程失败');
          }
          return;
        }
        if (generation !== countdownGeneration) {
          try { await api.cancelTimedCapture(scheduled.id); } catch (_) {}
          return;
        }
        // 页面切走不取消主进程任务；它会继续准时触发。
        if (!pageActive) return;
        timedJobId = scheduled.id;
        let left = Math.max(0, Number(scheduled.delay));
        drawCountdown(left);
        countdownTimer = setInterval(() => {
          left -= 1;
          if (left > 0) {
            drawCountdown(left);
            return;
          }
          // 主进程独立触发；这里只清理可见倒计时，不能再发第二次截图。
          timedJobId = null;
          resetCountdownUi();
          flash(aTimed, 'ok', '延时截图已触发');
        }, 1000);
      }

      async function cancelCountdown() {
        countdownGeneration += 1;
        timedScheduling = false;
        const jobId = timedJobId;
        timedJobId = null;
        resetCountdownUi();
        let cancelResult = null;
        let cancelFailed = false;
        if (jobId) {
          try {
            cancelResult = await api.cancelTimedCapture(jobId);
          } catch (_) {
            cancelFailed = true;
          }
        }
        if (!jobId || (cancelResult && cancelResult.ok === true)) {
          flash(aTimed, 'warn', '已取消延时截图');
        } else if (cancelFailed) {
          flash(aTimed, 'err', '延时截图取消失败');
        } else {
          flash(aTimed, 'ok', '延时截图已触发');
        }
      }

      // 5) 录屏（带快捷键）
      const aRecord = makeAction({
        key: 'record',
        icon: 'record',
        label: '录屏',
        onClick: () => api.triggerCapture('record'),
      });

      // —— 底部：最近截图 + 自动复制开关 ——
      const bottom = document.createElement('div');
      bottom.className = 'card card-pad cap-recent';
      bottom.innerHTML =
        '<div class="cap-recent-head">' +
        '<div class="group-title">' +
        ico('history') +
        '<span>最近截图</span>' +
        '</div>' +
        '<button type="button" class="btn btn-ghost cap-recent-more">' +
        '<span>查看全部</span>' +
        ico('chevron', 'ico ico-sm') +
        '</button>' +
        '</div>' +
        '<div class="cap-recent-strip" id="cap-recent-strip"></div>' +
        '<div class="cap-recent-foot">' +
        '<label class="cap-switch">' +
        '<input type="checkbox" id="cap-autocopy">' +
        '<span class="cap-switch-track"><span class="cap-switch-dot"></span></span>' +
        '<span class="cap-switch-text">' +
        '<span class="cap-switch-title">自动复制</span>' +
        '<span class="hint">截图完成后自动写入剪贴板</span>' +
        '</span>' +
        '</label>' +
        '</div>';
      el.appendChild(bottom);

      const strip = bottom.querySelector('#cap-recent-strip');
      const moreBtn = bottom.querySelector('.cap-recent-more');
      moreBtn.addEventListener('click', () => goHistory());
      const autoCopy = bottom.querySelector('#cap-autocopy');
      autoCopy.addEventListener('change', async () => {
        try {
          await api.setConfig({ capture: { copyAfterCapture: autoCopy.checked } });
        } catch (e) {
          // 写失败则回滚 UI，保持与真实配置一致
          autoCopy.checked = !autoCopy.checked;
        }
      });

      function goHistory() {
        if (window.KKMain && typeof window.KKMain.go === 'function') {
          window.KKMain.go('history');
        }
      }

      // 渲染最近截图（取前 6 个 thumb 横向排列）
      async function refreshRecent() {
        if (!strip) return;
        let list = [];
        try {
          list = await api.historyList();
        } catch (e) {
          list = [];
        }
        strip.innerHTML = '';
        const items = (list || []).slice(0, 6);
        if (items.length === 0) {
          const empty = document.createElement('div');
          empty.className = 'cap-recent-empty hint';
          empty.textContent = '还没有截图，先从上面捕捉一张吧。';
          strip.appendChild(empty);
          return;
        }
        items.forEach((it) => {
          const cell = document.createElement('button');
          cell.type = 'button';
          cell.className = 'cap-thumb';
          cell.title = (it.type || '截图') + ' · ' + (it.width || '?') + '×' + (it.height || '?');
          const img = document.createElement('img');
          img.src = it.thumb || '';
          img.alt = '截图缩略图';
          img.loading = 'lazy';
          cell.appendChild(img);
          cell.addEventListener('click', () => goHistory());
          strip.appendChild(cell);
        });
      }

      // —— 拉取配置：填快捷键小字 + 自动复制开关初值 ——
      async function loadConfig() {
        try {
          config = await api.getConfig();
        } catch (e) {
          config = {};
        }
        const sc = (config && config.shortcuts) || {};
        const cap = (config && config.capture) || {};

        // 仅区域截图与录屏显示快捷键（窗口/全屏/延时无快捷键）
        setHint(aRegion, sc.capture);
        setHint(aRecord, sc.record);

        autoCopy.checked = !!cap.copyAfterCapture;

        // 跟随主题（与设置页一致）
        const theme = (config && config.general && config.general.theme) || 'light';
        document.body.classList.toggle('theme-dark', theme === 'dark');
      }

      // 把快捷键写进操作卡小字（并记住默认值，供 flash 后恢复）
      function setHint(refs, acc) {
        const text = acc ? prettyKey(acc) : '';
        refs._defaultHint = text;
        refs.hint.innerHTML = text
          ? '<kbd class="cap-kbd">' + escapeHtml(text) + '</kbd>'
          : '';
      }

      // —— 监听历史变化，实时刷新最近截图 ——
      try {
        offHistory = api.onHistoryChanged(() => refreshRecent());
      } catch (e) {
        offHistory = null;
      }

      // —— 页面卸载清理：render 幂等会被多次调用，切到别的页时外壳会清空容器。
      //     原先把清理函数挂在 el._cleanup，但外壳从不调用它 → onHistoryChanged 订阅与倒计时 timer 泄漏。
      //     改用 MutationObserver 监听本页内容被移除（以页内 header 节点是否在 DOM 判定），自动退订与清 timer。——
      const lifeObserver = new MutationObserver(() => {
        if (document.contains(header)) return;
        pageActive = false;
        lifeObserver.disconnect();
        if (typeof offHistory === 'function') { try { offHistory(); } catch (_) {} offHistory = null; }
        // 只停止 UI 计时；主进程任务故意继续，页面导航不应误取消用户已排好的截图。
        resetCountdownUi();
        timedJobId = null;
      });
      try {
        lifeObserver.observe(el.parentNode || document.body, { childList: true, subtree: true });
      } catch (_) {}

      // —— 首次加载 ——
      loadConfig();
      refreshRecent();
    },
  };
})();
