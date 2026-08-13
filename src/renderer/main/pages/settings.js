// 困困截屏助手 · 主窗口「设置」页（分组卡片重构）
// 渲染层硬约束：禁止 require / import 引入 node / electron，所有主进程交互只走 window.kkapi。
// 注册到 window.KKPages.settings；render(el, ctx) 会被多次调用，每次先清空容器再整体重建（幂等）。
(function () {
  'use strict';

  window.KKPages = window.KKPages || {};

  // ============================================================
  // 一、通用小工具（纯 DOM，无外部依赖）
  // ============================================================

  // ---- H2 配套：API Key 掩码处理（主进程只回传掩码视图）----
  function isMaskedKey(v) {
    return typeof v === 'string' && v.indexOf('•') >= 0;
  }
  // 回填 Key 输入框：掩码 → 输入框留空 + 标记「已配置」（dataset.kkSet=1，留空=保持不变）；
  // 空/明文（旧版缓存）→ 直接填入。
  function fillKeyInput(input, stored, placeholder) {
    if (isMaskedKey(stored)) {
      input.value = '';
      input.dataset.kkSet = '1';
      input.placeholder = '已配置 · 留空保持不变';
    } else {
      input.value = stored || '';
      input.dataset.kkSet = '0';
      input.placeholder = placeholder || 'sk-…';
    }
  }
  // 组装含 Key 的 patch：输入了新值 → 写新值；留空且已配置 → 删除该字段（绝不覆盖原 Key）；
  // 留空且未配置 → 写空串（显式清空/无 Key）。
  function keyInto(patch, provider, input, other) {
    patch[provider] = Object.assign({}, other);
    const v = (input.value || '').trim();
    if (v) {
      patch[provider].apiKey = v;
    } else if (input.dataset.kkSet === '1') {
      // 留空 = 保持原 Key，不携带该字段
    } else {
      patch[provider].apiKey = '';
    }
    return patch;
  }
  // Key 输入框旁的「清除」按钮：立即把对应 Key 置空
  function makeKeyClearBtn(input, provider, api) {
    const b = h('button', { class: 'icon-btn apikey-eye', type: 'button', title: '清除已保存的 Key' }, '✕');
    b.addEventListener('click', function () {
      input.value = '';
      input.dataset.kkSet = '0';
      input.placeholder = 'sk-…';
      const p = {};
      p[provider] = { apiKey: '' };
      Promise.resolve(api.setConfig(p))
        .then(function () { toast('已清除 ' + provider + ' Key', 'ok'); })
        .catch(function () { toast('清除失败', 'err'); });
    });
    return b;
  }


  // 创建元素：tag + 属性 + 子节点（子可为字符串/节点/数组）
  function h(tag, attrs, children) {
    const el = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        const v = attrs[k];
        if (v == null || v === false) return;
        if (k === 'class') el.className = v;
        else if (k === 'html') el.innerHTML = v;
        else if (k === 'text') el.textContent = v;
        else if (k === 'dataset') {
          Object.keys(v).forEach(function (dk) { el.dataset[dk] = v[dk]; });
        } else if (k.slice(0, 2) === 'on' && typeof v === 'function') {
          el.addEventListener(k.slice(2).toLowerCase(), v);
        } else if (v === true) {
          el.setAttribute(k, '');
        } else {
          el.setAttribute(k, v);
        }
      });
    }
    appendChildren(el, children);
    return el;
  }

  function appendChildren(el, children) {
    if (children == null) return;
    if (Array.isArray(children)) {
      children.forEach(function (c) { appendChildren(el, c); });
    } else if (typeof children === 'string' || typeof children === 'number') {
      el.appendChild(document.createTextNode(String(children)));
    } else if (children instanceof Node) {
      el.appendChild(children);
    }
  }

  // 线性 SVG 图标：传入 inner（path/circle/rect 等字符串），统一 .ico 描边样式
  function ico(inner, cls) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('class', 'ico' + (cls ? ' ' + cls : ''));
    svg.innerHTML = inner;
    return svg;
  }

  // 图标集合（题面给定的线性图标 + 同风格自绘的少量补充）
  const ICONS = {
    设置: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3 M12 19v3 M2 12h3 M19 12h3 M5 5l1.8 1.8 M17.2 17.2 19 19 M19 5l-1.8 1.8 M6.8 17.2 5 19"/>',
    相机: '<path d="M3 8a2 2 0 0 1 2-2h2l1.2-2h5.6L17 6h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><circle cx="12" cy="12.5" r="3.2"/>',
    录屏: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3" fill="currentColor"/>',
    OCR: '<path d="M4 7V5h16v2 M9 19h6 M12 5v14"/>',
    AI: '<path d="M12 3l1.8 4.7L18.5 9.5 13.8 11.3 12 16l-1.8-4.7L5.5 9.5l4.7-1.8z"/>',
    历史: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    删除: '<path d="M4 7h16 M9 7V4h6v3 M6 7l1 13h10l1-13"/>',
    AI能力: '<path d="M12 3l1.8 4.7L18.5 9.5 13.8 11.3 12 16l-1.8-4.7L5.5 9.5l4.7-1.8z"/>',
    // 自绘：键盘（快捷键分组）
    键盘: '<rect x="2.5" y="6" width="19" height="12" rx="2"/><path d="M6 9.5h0 M9 9.5h0 M12 9.5h0 M15 9.5h0 M18 9.5h0 M6 13h0 M18 13h0 M9 15.5h6"/>',
    // 自绘：存储（硬盘/存储与隐私分组）
    存储: '<path d="M3 7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M3 10h18"/><circle cx="17" cy="14.5" r="1.2" fill="currentColor" stroke="none"/>',
    // 自绘：眼睛（密码显隐 - 显示态）
    眼: '<path d="M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12z"/><circle cx="12" cy="12" r="2.6"/>',
    // 自绘：眼睛划线（密码显隐 - 隐藏态）
    眼闭: '<path d="M3 4l18 16"/><path d="M9.4 6.2A10.5 10.5 0 0 1 12 5.9c6.5 0 10 6.1 10 6.1a17 17 0 0 1-3 3.6 M6.3 8.1A16.7 16.7 0 0 0 2 12s3.5 6.1 10 6.1a10 10 0 0 0 3-.46"/><path d="M9.6 10.2a3 3 0 0 0 4.2 4.2"/>',
    // 自绘：勾（成功）
    勾: '<path d="M5 12.5l4.5 4.5L19 7"/>',
    // 自绘：感叹（警告）
    叹: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5v6 M12 16.5h0"/>',
    // 自绘：连接测试（信号波）
    连接: '<path d="M5 12.5a10 10 0 0 1 14 0 M8 15.5a6 6 0 0 1 8 0"/><circle cx="12" cy="18.5" r="1.2" fill="currentColor" stroke="none"/>',
  };

  // ============================================================
  // 二、快捷键「按下即录入」相关（Electron accelerator 合成）
  // ============================================================

  const MOD_CODES = [
    'ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight',
    'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight', 'OSLeft', 'OSRight',
  ];

  function isModifierCode(code) {
    return MOD_CODES.indexOf(code) !== -1;
  }

  // 修饰键 → Electron accelerator 片段（⌘ 用 CommandOrControl，跨平台友好）
  function modifierTokens(e) {
    const m = [];
    if (e.metaKey) m.push('CommandOrControl');
    if (e.ctrlKey) m.push('Control');
    if (e.altKey) m.push('Alt');
    if (e.shiftKey) m.push('Shift');
    return m;
  }

  // 主键（非修饰键）→ Electron accelerator 键名
  function mainKeyToken(e) {
    const code = e.code || '';
    if (isModifierCode(code)) return null;
    let m;
    if ((m = /^Key([A-Z])$/.exec(code))) return m[1];            // KeyA -> A
    if ((m = /^Digit([0-9])$/.exec(code))) return m[1];          // Digit1 -> 1
    if ((m = /^Numpad([0-9])$/.exec(code))) return 'num' + m[1]; // 小键盘数字
    if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;      // F1..F24 原样
    const map = {
      Space: 'Space', Enter: 'Return', Tab: 'Tab',
      ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
      Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', Insert: 'Insert',
      Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\',
      Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Backquote: '`',
      NumpadAdd: 'numadd', NumpadSubtract: 'numsub', NumpadMultiply: 'nummult',
      NumpadDivide: 'numdiv', NumpadDecimal: 'numdec',
    };
    if (map[code]) return map[code];
    if (e.key && e.key.length === 1) return e.key.toUpperCase(); // 兜底
    return null;
  }

  // ============================================================
  // 三、页面注册
  // ============================================================

  // 通用 OpenAI 兼容服务商预设（与 src/shared/config-schema.js 的 OPENAI_PRESETS 保持一致；
  // 渲染层不能 require node 模块，故内联一份精简表用于下拉默认值与兜底模型）。
  const OPENAI_PRESETS = {
    siliconflow: { label: '硅基流动', baseUrl: 'https://api.siliconflow.cn/v1', defaultModel: 'deepseek-ai/DeepSeek-V3', supportsModelList: true,
      fallbackModels: ['deepseek-ai/DeepSeek-V3', 'deepseek-ai/DeepSeek-R1', 'zai-org/GLM-4.6', 'zai-org/GLM-4.5', 'MiniMaxAI/MiniMax-M1', 'Qwen/Qwen2.5-72B-Instruct'] },
    qwen: { label: '通义千问', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', defaultModel: 'qwen-turbo', supportsModelList: false,
      fallbackModels: ['qwen-turbo', 'qwen-plus', 'qwen-max'] },
    kimi: { label: 'Kimi (Moonshot)', baseUrl: 'https://api.moonshot.cn/v1', defaultModel: 'moonshot-v1-8k', supportsModelList: false,
      fallbackModels: ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k'] },
    custom: { label: '自定义 (OpenAI 兼容)', baseUrl: '', defaultModel: '', supportsModelList: true, fallbackModels: [] },
  };

  window.KKPages.settings = {
    title: '设置',
    render: function (el /*, ctx */) {
      el.innerHTML = '';

      const api = window.kkapi;
      if (!api) {
        el.appendChild(
          h('div', { class: 'settings-fallback' },
            '未检测到 kkapi 接口，无法加载设置。')
        );
        return;
      }

      // 本页持有的最新完整配置（保存 AI 分组时做兜底，避免覆盖未在表单里的字段）
      let currentConfig = {};

      // 轻提示（即时保存反馈），自动消失
      let toastTimer = null;
      function toast(msg, kind) {
        const t = $toast;
        if (!t) return;
        t.textContent = msg;
        t.className = 'kk-toast show' + (kind ? ' ' + kind : '');
        if (toastTimer) clearTimeout(toastTimer);
        toastTimer = setTimeout(function () {
          t.className = 'kk-toast';
        }, 1800);
      }

      // 即时保存某分组的 patch（通用/快捷键/截图/录屏/OCR 用）。
      // 用 promise 链做真正的串行化：每次保存排到上一次之后，快速连点也按序写、不并发。
      let saveChain = Promise.resolve();
      function autoSave(patch, okMsg) {
        saveChain = saveChain.then(async function () {
          try {
            const merged = await api.setConfig(patch);
            if (merged && typeof merged === 'object') currentConfig = merged;
            if (okMsg !== false) toast(okMsg || '已保存', 'ok');
          } catch (e) {
            toast('保存失败：' + (e && e.message ? e.message : '未知错误'), 'err');
          }
        });
        return saveChain;
      }

      // ----------------------------------------------------------
      // 分组卡片骨架：返回 { card, body }
      // ----------------------------------------------------------
      function groupCard(iconKey, title, desc) {
        const body = h('div', { class: 'group-body' });
        const card = h('section', { class: 'card card-pad group' }, [
          h('div', { class: 'group-head' }, [
            h('div', { class: 'group-title' }, [ico(ICONS[iconKey]), h('span', null, title)]),
          ]),
          h('div', { class: 'group-desc' }, desc),
          body,
        ]);
        return { card: card, body: body };
      }

      // 一行字段：左标签 + 右控件（用于开关/选择这类横排）
      function rowField(labelText, hintText, control) {
        return h('div', { class: 'row-field' }, [
          h('div', { class: 'row-meta' }, [
            h('div', { class: 'row-label' }, labelText),
            hintText ? h('div', { class: 'row-hint' }, hintText) : null,
          ]),
          h('div', { class: 'row-control' }, control),
        ]);
      }

      // 竖排字段：上 label + 下控件 + hint（用于输入框/文本域）
      function stackField(labelText, control, hintText) {
        return h('div', { class: 'stack-field' }, [
          h('label', { class: 'label' }, labelText),
          control,
          hintText ? h('div', { class: 'hint' }, hintText) : null,
        ]);
      }

      // 开关（自绘 toggle，复用品牌色）
      function toggle(checked, onChange) {
        const input = h('input', { type: 'checkbox', class: 'kk-toggle-input' });
        input.checked = !!checked;
        const track = h('span', { class: 'kk-toggle-track' }, h('span', { class: 'kk-toggle-thumb' }));
        const wrap = h('label', { class: 'kk-toggle' }, [input, track]);
        input.addEventListener('change', function () { onChange(input.checked); });
        return wrap;
      }

      // ==========================================================
      // 页面外层：可滚动内容 + 固定底部操作栏（AI 模型保存）
      // ==========================================================
      const grid = h('div', { class: 'settings-grid' });
      const scroll = h('div', { class: 'settings-scroll' }, [
        h('div', { class: 'settings-inner' }, [
          h('header', { class: 'settings-header' }, [
            h('div', { class: 'settings-title' }, [ico(ICONS.设置, 'ico-lg'), h('span', null, '设置')]),
            h('div', { class: 'settings-sub' }, '通用 / 快捷键 / 截图 / 录屏 / OCR / AI 模型 / 存储与隐私 — 多数改动即时保存'),
          ]),
          grid,
        ]),
      ]);

      const $toast = h('div', { class: 'kk-toast' });

      // 固定底部操作栏（仅服务 AI 模型分组的“保存”）
      const aiStatus = h('span', { class: 'ai-bar-status' });
      const btnSaveAI = h('button', { class: 'btn btn-primary', type: 'button' }, '保存 AI 配置');
      const footer = h('div', { class: 'settings-footer' }, [
        h('div', { class: 'footer-left' }, [
          ico(ICONS.AI, 'ico-sm'),
          h('span', { class: 'footer-note' }, 'AI 模型为敏感配置，需点此保存才会生效'),
        ]),
        h('div', { class: 'footer-right' }, [aiStatus, btnSaveAI]),
      ]);

      const pageRoot = h('div', { class: 'settings-page' }, [scroll, footer, $toast]);
      el.appendChild(pageRoot);

      // ==========================================================
      // 1) 通用
      // ==========================================================
      const gGeneral = groupCard('设置', '通用', '启动行为、保存目录与外观主题。');

      // launchAtLogin
      const tgLaunch = toggle(false, function (v) {
        autoSave({ general: { launchAtLogin: v } }, v ? '已开启开机自启' : '已关闭开机自启');
      });
      gGeneral.body.appendChild(
        rowField('开机自启动', '登录系统后自动在后台运行困困截屏助手', tgLaunch)
      );

      // saveDir
      const inSaveDir = h('input', {
        class: 'input', type: 'text',
        placeholder: '留空 = 系统「图片」目录',
      });
      inSaveDir.addEventListener('change', function () {
        autoSave({ general: { saveDir: inSaveDir.value.trim() } }, '已更新保存目录');
      });
      const btnChooseDir = h('button', { class: 'btn btn-soft', type: 'button' }, '选择…');
      btnChooseDir.addEventListener('click', async function () {
        try {
          const r = await api.chooseSaveDir();
          if (r && r.dir) {
            inSaveDir.value = r.dir;
            currentConfig = await api.getConfig();
            toast('已更新保存目录', 'ok');
          }
        } catch (e) {
          toast('选择目录失败：' + (e && e.message ? e.message : '未知错误'), 'err');
        }
      });
      const btnResetDir = h('button', { class: 'btn btn-soft', type: 'button' }, '恢复默认');
      btnResetDir.addEventListener('click', function () {
        inSaveDir.value = '';
        autoSave({ general: { saveDir: '' } }, '已恢复为系统图片目录');
      });
      gGeneral.body.appendChild(
        stackField('截图保存目录',
          h('div', { class: 'dir-row' }, [inSaveDir, btnChooseDir, btnResetDir]),
          '导出 / 自动保存的图片落地位置。可点「选择…」改成任意文件夹，留空 = 系统图片目录。')
      );

      // theme
      const selTheme = h('select', { class: 'select' }, [
        h('option', { value: 'light' }, '浅色'),
        h('option', { value: 'dark' }, '深色'),
      ]);
      selTheme.addEventListener('change', function () {
        applyTheme(selTheme.value);
        autoSave({ general: { theme: selTheme.value } }, selTheme.value === 'dark' ? '已切换深色' : '已切换浅色');
      });
      gGeneral.body.appendChild(
        rowField('外观主题', '切换后整窗实时预览（浅色 / 深色）', selTheme)
      );

      grid.appendChild(gGeneral.card);

      function applyTheme(theme) {
        document.body.classList.toggle('theme-dark', theme === 'dark');
      }

      // ==========================================================
      // 2) 快捷键
      // ==========================================================
      const gKeys = groupCard('键盘', '全局快捷键', '点击输入框后直接按下组合键即可录入（Esc 取消，⌫ 清除）。');

      // 五个快捷键定义：key 对应 config.shortcuts 字段（行渲染只用 label，故不再保留迁移残留的死 icon 字段）
      const SHORTCUTS = [
        { key: 'capture', label: '区域截图' },
        { key: 'ocr', label: '文字识别 (OCR)' },
        { key: 'longShot', label: '滚动长截图' },
        { key: 'record', label: '录屏' },
        { key: 'pinClipboard', label: '贴图剪贴板' },
        { key: 'translate', label: '划词翻译' },
      ];
      const shortcutInputs = {}; // key -> input

      SHORTCUTS.forEach(function (sc) {
        const input = h('input', {
          class: 'input shortcut-input', type: 'text',
          readonly: true, placeholder: '点击后按下快捷键',
          title: '点击后直接按下你想要的组合键即可录入',
        });
        shortcutInputs[sc.key] = input;
        bindShortcutCapture(input, sc.key, sc.label);

        gKeys.body.appendChild(
          h('div', { class: 'shortcut-row' }, [
            h('div', { class: 'shortcut-name' }, sc.label),
            input,
          ])
        );
      });

      gKeys.body.appendChild(
        h('div', { class: 'hint' },
          '说明：使用 Electron 加速键格式，例如 CommandOrControl+Shift+A；建议至少包含一个修饰键或使用功能键。')
      );

      grid.appendChild(gKeys.card);

      // 绑定单个快捷键输入的「按下即录入」逻辑
      function bindShortcutCapture(input, scKey, scLabel) {
        input.addEventListener('focus', function () {
          input.dataset.prev = input.value;
          input.dataset.cleared = '';
          input.value = '';
          input.placeholder = '请按下快捷键…（Esc 取消，⌫ 清除）';
          input.classList.add('recording');
        });

        input.addEventListener('blur', function () {
          input.classList.remove('recording');
          input.placeholder = '点击后按下快捷键';
          // 未录到新值且非主动清除 → 还原原值
          if (input.value === '' && input.dataset.cleared !== '1') {
            input.value = input.dataset.prev || '';
          }
          input.dataset.cleared = '';
        });

        input.addEventListener('keydown', function (e) {
          if (!input.classList.contains('recording')) return;
          e.preventDefault();
          e.stopPropagation();

          const code = e.code || '';

          // Esc：还原原值并退出
          if (code === 'Escape') {
            input.value = input.dataset.prev || '';
            input.blur();
            return;
          }
          // Backspace / Delete：清空并退出（并即时保存为空）
          if (code === 'Backspace' || code === 'Delete') {
            input.value = '';
            input.dataset.cleared = '1';
            input.blur();
            persistShortcut(scKey, '');
            return;
          }
          // 纯修饰键：显示进行中预览，等主键
          if (isModifierCode(code)) {
            const pre = modifierTokens(e);
            input.value = pre.length ? pre.join('+') + '+…' : '…';
            return;
          }
          // 主键
          const key = mainKeyToken(e);
          if (!key) return;
          const hasMod = e.metaKey || e.ctrlKey || e.altKey || e.shiftKey;
          const isFn = /^F([1-9]|1[0-9]|2[0-4])$/.test(key);
          if (!hasMod && !isFn) {
            input.value = '';
            toast('「' + scLabel + '」需至少含一个修饰键（⌘/⌃/⌥/⇧）或使用功能键', 'err');
            return;
          }
          const accel = modifierTokens(e).concat([key]).join('+');
          input.value = accel;
          input.dataset.cleared = '';
          input.blur();
          persistShortcut(scKey, accel);
        });
      }

      // 即时保存单个快捷键到 config.shortcuts
      function persistShortcut(scKey, accel) {
        const patch = { shortcuts: {} };
        patch.shortcuts[scKey] = accel;
        autoSave(patch, accel ? '快捷键已更新' : '快捷键已清除');
      }

      // ==========================================================
      // 3) 截图
      // ==========================================================
      const gCapture = groupCard('相机', '截图', '截图完成后的默认动作。');

      const tgCopyAfter = toggle(false, function (v) {
        autoSave({ capture: { copyAfterCapture: v } }, v ? '截图后自动复制' : '已关闭自动复制');
      });
      gCapture.body.appendChild(
        rowField('截图后自动复制', '截图完成立即把图片写入系统剪贴板', tgCopyAfter)
      );

      const tgAutoPin = toggle(false, function (v) {
        autoSave({ capture: { autoPin: v } }, v ? '截图后自动贴图' : '已关闭自动贴图');
      });
      gCapture.body.appendChild(
        rowField('截图后自动贴图', '截图完成后在屏幕上钉一张悬浮贴图', tgAutoPin)
      );

      const tgAutoSaveHistory = toggle(false, function (v) {
        autoSave({ capture: { autoSaveHistory: v } }, v ? '截图将自动存入历史' : '仅保存到本地的才入历史');
      });
      gCapture.body.appendChild(
        rowField('自动保存到历史', '开启后每张截图都自动进历史记录；关闭则只有点了「保存到本地」的截图才入历史', tgAutoSaveHistory)
      );

      grid.appendChild(gCapture.card);

      // ==========================================================
      // 4) 录屏
      // ==========================================================
      const gRec = groupCard('录屏', '录屏', '帧率与导出格式设置。');

      const inFps = h('input', {
        class: 'input', type: 'number', min: '1', max: '60', step: '1',
        placeholder: '12',
      });
      inFps.addEventListener('change', function () {
        let fps = parseInt(inFps.value, 10);
        if (!Number.isFinite(fps) || fps <= 0) {
          fps = (currentConfig.recording && currentConfig.recording.fps) || 12;
          inFps.value = fps;
        }
        if (fps > 60) { fps = 60; inFps.value = 60; }
        autoSave({ recording: { fps: fps } }, '帧率已更新');
      });
      gRec.body.appendChild(
        stackField('录制帧率 (FPS)', inFps, '建议 12–30；帧率越高文件越大。')
      );

      const tgGif = toggle(false, function (v) {
        autoSave({ recording: { toGif: v } }, v ? '将导出为 GIF' : '将导出为视频');
      });
      gRec.body.appendChild(
        rowField('导出为 GIF', '关闭则导出为视频文件', tgGif)
      );

      grid.appendChild(gRec.card);

      // ==========================================================
      // 5) OCR
      // ==========================================================
      const gOcr = groupCard('OCR', '文字识别 (OCR)', '选择识别引擎与语言。');

      // engine 单选
      const ocrEngineWrap = h('div', { class: 'radio-group' });
      const OCR_ENGINES = [
        { value: 'local', label: '本地引擎', desc: '离线 / 免费 / 速度快' },
        { value: 'model', label: '大模型模式', desc: '云端 / 更准 / 用当前 AI 看图' },
      ];
      const ocrRadios = [];
      OCR_ENGINES.forEach(function (eng) {
        const radio = h('input', { type: 'radio', name: 'kk-ocr-engine', value: eng.value, class: 'kk-radio-input' });
        ocrRadios.push(radio);
        radio.addEventListener('change', function () {
          if (radio.checked) {
            updateRadioVisual();
            autoSave({ ocr: { engine: eng.value } }, '已切换 OCR 引擎');
          }
        });
        ocrEngineWrap.appendChild(
          h('label', { class: 'radio-card' }, [
            radio,
            h('span', { class: 'radio-dot' }),
            h('span', { class: 'radio-meta' }, [
              h('span', { class: 'radio-label' }, eng.label),
              h('span', { class: 'radio-desc' }, eng.desc),
            ]),
          ])
        );
      });
      function updateRadioVisual() {
        ocrRadios.forEach(function (r) {
          r.closest('.radio-card').classList.toggle('checked', r.checked);
        });
      }
      gOcr.body.appendChild(stackField('识别引擎', ocrEngineWrap));

      // lang
      const inLang = h('input', { class: 'input', type: 'text', placeholder: 'chi_sim+eng' });
      inLang.addEventListener('change', function () {
        autoSave({ ocr: { lang: inLang.value.trim() } }, '已更新识别语言');
      });
      gOcr.body.appendChild(
        stackField('识别语言', inLang, '本地引擎语言代码，多语言用 + 连接，例如 chi_sim+eng。')
      );

      grid.appendChild(gOcr.card);

      // ==========================================================
      // 6) AI 模型（敏感配置：底部操作栏统一保存）
      // ==========================================================
      const gAI = groupCard('AI', 'AI 模型', '选择 AI 提供方，并配置 DeepSeek / MiniMax。');
      // P1-3(M5) 隐私提示：AI 类功能会把内容发给第三方服务商
      gAI.body.appendChild(
        h('div', { class: 'status warn ai-risk' }, [
          ico(ICONS.叹, 'ico-sm'),
          h('span', null, '隐私提示：问 AI / 翻译 / 划词翻译等 AI 功能，会把截图或选中文字发送到你所配置的第三方服务商（DeepSeek / MiniMax / 硅基流动等）。OCR 默认走本地识别，不上传。'),
        ])
      );

      // —— AI 提供方：分段卡片（点哪个就只配哪个，两者互不干扰）——
      const selProvider = { value: 'deepseek' }; // 逻辑状态（保存/回填用），不是 DOM 元素
      const PROVIDERS = [
        { value: 'deepseek', label: 'DeepSeek', desc: '纯文本 · 截图走本地 OCR' },
        { value: 'minimax', label: 'MiniMax', desc: 'M3 · 可直接看图' },
        { value: 'openai', label: '更多服务商', desc: '硅基/千问/Kimi/自定义' },
        { value: 'auto', label: '智能分流', desc: '省钱 · 文本→DS 图片→MM' },
      ];
      const provWrap = h('div', { class: 'radio-group cols-3' });
      const provRadios = [];
      PROVIDERS.forEach(function (pv) {
        const radio = h('input', { type: 'radio', name: 'kk-ai-provider', value: pv.value, class: 'kk-radio-input' });
        provRadios.push(radio);
        radio.addEventListener('change', function () {
          if (radio.checked) setProvider(pv.value, true);
        });
        provWrap.appendChild(
          h('label', { class: 'radio-card' }, [
            radio,
            h('span', { class: 'radio-dot' }),
            h('span', { class: 'radio-meta' }, [
              h('span', { class: 'radio-label' }, pv.label),
              h('span', { class: 'radio-desc' }, pv.desc),
            ]),
          ])
        );
      });
      gAI.body.appendChild(stackField('AI 提供方', provWrap, '切换后立即生效。选「智能分流」时下面两家都要配置好 Key。'));

      // 智能分流模式下的额外说明（仅 auto 显示）
      const provHint = h('div', { class: 'status ok ai-risk', style: 'display:none' }, [
        ico(ICONS.叹, 'ico-sm'),
        h('span', null, '省钱模式：纯文字任务（翻译/润色/对话）用便宜的 DeepSeek；看图任务（截图问 AI / 截图翻译）用 MiniMax 直接看图。'),
      ]);
      gAI.body.appendChild(provHint);

      // 测试连接行工厂：点击时先静默保存本面板配置，再测指定的那一家（which），与当前模式解耦
      function makeTestRow(which, collect) {
        const status = h('span', { class: 'status loading ai-test-status', style: 'display:none' });
        const btn = h('button', { class: 'btn btn-soft', type: 'button' }, [ico(ICONS.连接, 'ico-sm'), h('span', null, '测试连接')]);
        btn.addEventListener('click', async function () {
          btn.disabled = true;
          status.style.display = '';
          status.className = 'status loading ai-test-status';
          status.innerHTML = '';
          status.appendChild(h('span', { class: 'dots' }, '正在测试'));
          try {
            await autoSave(collect(), false); // 测试即保存当前面板配置
            const r = await api.testDeepSeek(which);
            if (r && r.ok) {
              status.className = 'status ok ai-test-status';
              status.innerHTML = '';
              status.appendChild(ico(ICONS.勾, 'ico-sm'));
              status.appendChild(h('span', null, r.message || '连接成功'));
            } else {
              status.className = 'status err ai-test-status';
              status.innerHTML = '';
              status.appendChild(ico(ICONS.叹, 'ico-sm'));
              status.appendChild(h('span', null, (r && r.message) || '连接失败'));
            }
          } catch (e) {
            status.className = 'status err ai-test-status';
            status.innerHTML = '';
            status.appendChild(ico(ICONS.叹, 'ico-sm'));
            status.appendChild(h('span', null, e && e.message ? e.message : '测试出错'));
          } finally {
            btn.disabled = false;
          }
        });
        return h('div', { class: 'ai-test-row' }, [btn, status]);
      }

      // ===================== DeepSeek 面板 =====================
      const paneDeepSeek = h('div', { class: 'ai-pane' });
      paneDeepSeek.appendChild(
        h('div', { class: 'status warn ai-risk' }, [
          ico(ICONS.叹, 'ico-sm'),
          h('span', null, 'DeepSeek 不支持看图：问图/翻译会先本地 OCR 再发文字。要直接看图请改用 MiniMax。'),
        ])
      );
      const inApiKey = h('input', { class: 'input', type: 'password', placeholder: 'sk-…' });
      const eyeBtn = h('button', { class: 'icon-btn apikey-eye', type: 'button', title: '显示' }, ico(ICONS.眼, 'ico-sm'));
      eyeBtn.addEventListener('click', function () {
        const show = inApiKey.type === 'password';
        inApiKey.type = show ? 'text' : 'password';
        eyeBtn.innerHTML = '';
        eyeBtn.appendChild(ico(show ? ICONS.眼闭 : ICONS.眼, 'ico-sm'));
        eyeBtn.title = show ? '隐藏' : '显示';
      });
      const apiKeyWrap = h('div', { class: 'apikey-wrap' }, [inApiKey, eyeBtn, makeKeyClearBtn(inApiKey, 'deepseek', api)]);
      paneDeepSeek.appendChild(
        stackField('DeepSeek · API Key', apiKeyWrap, 'API Key 仅保存在本地配置中，不会上传到任何第三方服务器。')
      );
      const inBaseUrl = h('input', { class: 'input', type: 'text', placeholder: 'https://api.deepseek.com/v1' });
      const inVision = h('input', { class: 'input', type: 'text', placeholder: 'deepseek-v4-pro' });
      const inText = h('input', { class: 'input', type: 'text', placeholder: 'deepseek-v4-flash' });
      paneDeepSeek.appendChild(
        h('div', { class: 'two-col' }, [
          stackField('DeepSeek · Base URL', inBaseUrl),
          stackField('视觉模型 (visionModel)', inVision, '占位字段：DeepSeek 不支持看图，实际直接看图走 MiniMax（勿依赖此字段）'),
        ])
      );
      paneDeepSeek.appendChild(stackField('文本模型 (textModel)', inText, '用于纯文本翻译 / 润色 / 对话'));
      paneDeepSeek.appendChild(makeTestRow('deepseek', function () {
        return keyInto({}, 'deepseek', inApiKey, {
          baseUrl: inBaseUrl.value.trim(),
          visionModel: inVision.value.trim(),
          textModel: inText.value.trim(),
        });
      }));
      gAI.body.appendChild(paneDeepSeek);

      // ===================== MiniMax 面板 =====================
      const paneMiniMax = h('div', { class: 'ai-pane' });
      paneMiniMax.appendChild(
        h('div', { class: 'status ok ai-risk' }, [
          ico(ICONS.叹, 'ico-sm'),
          h('span', null, 'MiniMax-M3 可直接看图，无需 OCR。注意：国内站用 api.minimaxi.com，海外站用 api.minimax.io，两站密钥不通用。'),
        ])
      );
      const inMmKey = h('input', { class: 'input', type: 'password', placeholder: 'sk-… 或 MiniMax API Key' });
      const mmEye = h('button', { class: 'icon-btn apikey-eye', type: 'button', title: '显示' }, ico(ICONS.眼, 'ico-sm'));
      mmEye.addEventListener('click', function () {
        const show = inMmKey.type === 'password';
        inMmKey.type = show ? 'text' : 'password';
        mmEye.innerHTML = '';
        mmEye.appendChild(ico(show ? ICONS.眼闭 : ICONS.眼, 'ico-sm'));
        mmEye.title = show ? '隐藏' : '显示';
      });
      const mmKeyWrap = h('div', { class: 'apikey-wrap' }, [inMmKey, mmEye, makeKeyClearBtn(inMmKey, 'minimax', api)]);
      paneMiniMax.appendChild(
        stackField('MiniMax · API Key', mmKeyWrap, 'MiniMax 开放平台 Key（Bearer 鉴权，无需 GroupId），仅存本地')
      );
      const inMmBase = h('input', { class: 'input', type: 'text', placeholder: 'https://api.minimaxi.com/v1' });
      const inMmModel = h('input', { class: 'input', type: 'text', placeholder: 'MiniMax-M3' });
      paneMiniMax.appendChild(
        h('div', { class: 'two-col' }, [
          stackField('MiniMax · Base URL', inMmBase, '国内 api.minimaxi.com／海外 api.minimax.io'),
          stackField('MiniMax · 模型', inMmModel, 'MiniMax-M3 支持直接看图'),
        ])
      );
      paneMiniMax.appendChild(makeTestRow('minimax', function () {
        return keyInto({}, 'minimax', inMmKey, {
          baseUrl: inMmBase.value.trim(),
          visionModel: inMmModel.value.trim(),
          textModel: inMmModel.value.trim(),
        });
      }));
      gAI.body.appendChild(paneMiniMax);

      // ===================== 更多服务商（通用 OpenAI 兼容）面板 =====================
      // 从 kunkun-translator 移植：一套配置切换硅基流动/通义千问/Kimi/自定义，支持在线拉模型列表。
      // 仅用于「纯文本」任务（翻译/润色/对话）；看图任务它做不到，会自动退回 DeepSeek+本地 OCR。
      const paneOpenAI = h('div', { class: 'ai-pane' });
      const oaState = { preset: 'siliconflow' }; // 当前选中的预设

      paneOpenAI.appendChild(
        h('div', { class: 'status ok ai-risk' }, [
          ico(ICONS.叹, 'ico-sm'),
          h('span', null, '通用 OpenAI 兼容服务商：仅做纯文本（翻译/润色/对话）。看图任务会自动退回 DeepSeek 本地 OCR。'),
        ])
      );

      // 预设下拉：切换后自动填默认 baseURL/model
      const selOaPreset = h('select', { class: 'select' },
        Object.keys(OPENAI_PRESETS).map((k) => h('option', { value: k }, OPENAI_PRESETS[k].label))
      );

      const inOaKey = h('input', { class: 'input', type: 'password', placeholder: 'sk-…' });
      const oaEye = h('button', { class: 'icon-btn apikey-eye', type: 'button', title: '显示' }, ico(ICONS.眼, 'ico-sm'));
      oaEye.addEventListener('click', function () {
        const show = inOaKey.type === 'password';
        inOaKey.type = show ? 'text' : 'password';
        oaEye.innerHTML = '';
        oaEye.appendChild(ico(show ? ICONS.眼闭 : ICONS.眼, 'ico-sm'));
        oaEye.title = show ? '隐藏' : '显示';
      });
      const oaKeyWrap = h('div', { class: 'apikey-wrap' }, [inOaKey, oaEye, makeKeyClearBtn(inOaKey, 'openai', api)]);

      const inOaBase = h('input', { class: 'input', type: 'text', placeholder: 'https://api.siliconflow.cn/v1' });

      // 模型：文本输入 + 下拉（下拉来自在线刷新/兜底清单，选中即填入输入框）
      const inOaModel = h('input', { class: 'input', type: 'text', placeholder: 'deepseek-ai/DeepSeek-V3' });
      const selOaModel = h('select', { class: 'select' }, [h('option', { value: '' }, '（刷新后选择）')]);
      selOaModel.addEventListener('change', function () {
        if (selOaModel.value) inOaModel.value = selOaModel.value;
      });
      const btnRefreshModels = h('button', { class: 'btn btn-soft', type: 'button' }, [ico(ICONS.连接, 'ico-sm'), h('span', null, '刷新模型列表')]);
      const refreshStatus = h('span', { class: 'status loading ai-test-status', style: 'display:none' });

      // 用一组模型 id 填充下拉
      function fillModelOptions(ids) {
        selOaModel.innerHTML = '';
        selOaModel.appendChild(h('option', { value: '' }, '（选择模型）'));
        (ids || []).forEach((id) => selOaModel.appendChild(h('option', { value: id }, id)));
        // 若当前输入框的模型在列表里，则让下拉同步选中
        if (inOaModel.value && ids && ids.indexOf(inOaModel.value) >= 0) selOaModel.value = inOaModel.value;
      }

      btnRefreshModels.addEventListener('click', async function () {
        btnRefreshModels.disabled = true;
        refreshStatus.style.display = '';
        refreshStatus.className = 'status loading ai-test-status';
        refreshStatus.innerHTML = '';
        refreshStatus.appendChild(h('span', { class: 'dots' }, '正在拉取'));
        try {
          // 先静默保存当前 openai 面板配置，确保用最新 key/baseURL 拉取
          await autoSave(collectOpenAI(), false);
          const r = await api.fetchModels({ baseUrl: inOaBase.value.trim(), apiKey: inOaKey.value.trim() });
          if (r && r.ok && Array.isArray(r.models)) {
            fillModelOptions(r.models);
            refreshStatus.className = 'status ok ai-test-status';
            refreshStatus.innerHTML = '';
            refreshStatus.appendChild(ico(ICONS.勾, 'ico-sm'));
            refreshStatus.appendChild(h('span', null, '拉到 ' + r.models.length + ' 个模型'));
          } else {
            // 拉取失败 → 退回兜底清单（若有）
            const fb = (OPENAI_PRESETS[oaState.preset] || {}).fallbackModels || [];
            if (fb.length) fillModelOptions(fb);
            refreshStatus.className = 'status err ai-test-status';
            refreshStatus.innerHTML = '';
            refreshStatus.appendChild(ico(ICONS.叹, 'ico-sm'));
            refreshStatus.appendChild(h('span', null, ((r && r.error) || '拉取失败') + (fb.length ? '，已用兜底清单' : '')));
          }
        } catch (e) {
          refreshStatus.className = 'status err ai-test-status';
          refreshStatus.innerHTML = '';
          refreshStatus.appendChild(ico(ICONS.叹, 'ico-sm'));
          refreshStatus.appendChild(h('span', null, e && e.message ? e.message : '拉取出错'));
        } finally {
          btnRefreshModels.disabled = false;
        }
      });

      // 切换预设：填默认 baseURL/model + 兜底模型下拉 + 显隐「刷新」按钮
      function applyPreset(preset, resetFields) {
        oaState.preset = OPENAI_PRESETS[preset] ? preset : 'siliconflow';
        const p = OPENAI_PRESETS[oaState.preset];
        selOaPreset.value = oaState.preset;
        if (resetFields) {
          inOaBase.value = p.baseUrl || '';
          inOaModel.value = p.defaultModel || '';
        }
        fillModelOptions(p.fallbackModels || []);
        // 刷新按钮仅对支持在线拉取的预设显示（硅基流动/自定义）
        btnRefreshModels.style.display = p.supportsModelList ? '' : 'none';
        refreshStatus.style.display = 'none';
      }
      selOaPreset.addEventListener('change', function () {
        applyPreset(selOaPreset.value, true);
        autoSave(collectOpenAI(), '已切换为 ' + (OPENAI_PRESETS[selOaPreset.value] || {}).label);
      });

      function collectOpenAI() {
        return keyInto({}, 'openai', inOaKey, {
          preset: oaState.preset,
          baseUrl: inOaBase.value.trim(),
          model: inOaModel.value.trim(),
        });
      }

      paneOpenAI.appendChild(stackField('服务商预设', selOaPreset, '选平台自动填 Base URL 与默认模型；选「自定义」可填任意 OpenAI 兼容端点。'));
      paneOpenAI.appendChild(stackField('API Key', oaKeyWrap, 'Key 仅保存在本地（加密落盘），不会上传第三方。'));
      paneOpenAI.appendChild(stackField('Base URL', inOaBase, '请求 {baseUrl}/chat/completions'));
      paneOpenAI.appendChild(
        h('div', { class: 'two-col' }, [
          stackField('模型', inOaModel, '可手填，或从下面下拉里选'),
          stackField('模型下拉（刷新后可选）', selOaModel),
        ])
      );
      paneOpenAI.appendChild(h('div', { class: 'ai-test-row' }, [btnRefreshModels, refreshStatus]));
      paneOpenAI.appendChild(makeTestRow('openai', collectOpenAI));
      gAI.body.appendChild(paneOpenAI);

      // ===================== 公共提示词（两种 AI 通用）=====================
      gAI.body.appendChild(h('div', { class: 'group-desc', style: 'margin:10px 0 0' }, '以下提示词对 DeepSeek 与 MiniMax 通用'));
      const taAsk = h('textarea', { class: 'textarea', rows: '3', placeholder: '问图提示词' });
      const taOcr = h('textarea', { class: 'textarea', rows: '3', placeholder: 'OCR 提示词' });
      const taTranslate = h('textarea', { class: 'textarea', rows: '3', placeholder: '翻译提示词' });
      const taPolish = h('textarea', { class: 'textarea', rows: '3', placeholder: '润色提示词' });
      gAI.body.appendChild(stackField('问图提示词 (askImagePrompt)', taAsk));
      gAI.body.appendChild(stackField('OCR 提示词 (ocrPrompt)', taOcr));
      gAI.body.appendChild(stackField('翻译提示词 (translatePrompt)', taTranslate));
      gAI.body.appendChild(stackField('润色提示词 (polishPrompt)', taPolish));

      // 切换提供方：更新状态 + 卡片选中态 + 面板显隐（save=true 时静默切换并保存）
      function setProvider(value, save) {
        selProvider.value = ['deepseek', 'minimax', 'openai', 'auto'].indexOf(value) >= 0 ? value : 'deepseek';
        const mode = selProvider.value;
        const isAuto = mode === 'auto';
        provRadios.forEach(function (r) {
          r.checked = r.value === mode;
          const card = r.closest('.radio-card');
          if (card) card.classList.toggle('checked', r.checked);
        });
        // deepseek/minimax/openai 只显示对应面板；auto 显示 DeepSeek+MiniMax（文本可能走 openai，但看图必用 MM）
        paneDeepSeek.style.display = (mode === 'deepseek' || isAuto) ? '' : 'none';
        paneMiniMax.style.display = (mode === 'minimax' || isAuto) ? '' : 'none';
        paneOpenAI.style.display = (mode === 'openai') ? '' : 'none';
        provHint.style.display = isAuto ? '' : 'none';
        if (save) {
          const label = mode === 'minimax' ? 'MiniMax'
            : mode === 'openai' ? ((OPENAI_PRESETS[oaState.preset] || {}).label || '通用服务商')
            : isAuto ? '智能分流（省钱）' : 'DeepSeek';
          autoSave({ ai: { provider: mode } }, 'AI 提供方已切换为 ' + label);
        }
      }
      setProvider('deepseek', false); // 默认显示，回填时会再校正

      grid.appendChild(gAI.card);

      // 底部操作栏「保存 AI 配置」
      let aiStatusTimer = null;
      function setAiStatus(msg, kind) {
        aiStatus.textContent = msg;
        aiStatus.className = 'ai-bar-status' + (kind ? ' ' + kind : '');
        if (aiStatusTimer) clearTimeout(aiStatusTimer);
        if (kind === 'ok') {
          aiStatusTimer = setTimeout(function () {
            aiStatus.textContent = '';
            aiStatus.className = 'ai-bar-status';
          }, 2600);
        }
      }
      btnSaveAI.addEventListener('click', async function () {
        btnSaveAI.disabled = true;
        setAiStatus('正在保存…', '');
        try {
          const patch = { ai: { provider: selProvider.value } };
          keyInto(patch, 'openai', inOaKey, {
            preset: oaState.preset,
            baseUrl: inOaBase.value.trim(),
            model: inOaModel.value.trim(),
          });
          keyInto(patch, 'minimax', inMmKey, {
            baseUrl: inMmBase.value.trim(),
            visionModel: inMmModel.value.trim(),
            textModel: inMmModel.value.trim(),
          });
          keyInto(patch, 'deepseek', inApiKey, {
            baseUrl: inBaseUrl.value.trim(),
            visionModel: inVision.value.trim(),
            textModel: inText.value.trim(),
            askImagePrompt: taAsk.value,
            ocrPrompt: taOcr.value,
            translatePrompt: taTranslate.value,
            polishPrompt: taPolish.value,
          });
          const merged = await api.setConfig(patch);
          if (merged && typeof merged === 'object') currentConfig = merged;
          setAiStatus('AI 配置已保存', 'ok');
        } catch (e) {
          setAiStatus('保存失败：' + (e && e.message ? e.message : '未知错误'), 'err');
        } finally {
          btnSaveAI.disabled = false;
        }
      });

      // ==========================================================
      // 7) 存储与隐私
      // ==========================================================
      const gStore = groupCard('存储', '存储与隐私', '历史记录管理与数据存放说明。');

      const histCount = h('strong', { class: 'hist-count' }, '—');
      gStore.body.appendChild(
        rowField('历史记录数量', '已保存的截图 / 录屏条目总数',
          h('div', { class: 'hist-count-box' }, [ico(ICONS.历史, 'ico-sm'), histCount, h('span', { class: 'hist-unit' }, ' 条')]))
      );

      const btnClear = h('button', { class: 'btn btn-danger', type: 'button' }, [ico(ICONS.删除, 'ico-sm'), h('span', null, '清空历史记录')]);
      btnClear.addEventListener('click', function () {
        openClearConfirm();
      });
      gStore.body.appendChild(
        rowField('清空历史记录', '删除全部历史条目，此操作不可恢复', btnClear)
      );

      gStore.body.appendChild(
        h('div', { class: 'hint' },
          '隐私说明：所有截图、历史与 API Key 均仅保存在本机，应用不会主动上传你的数据。')
      );

      grid.appendChild(gStore.card);

      // 刷新历史数量
      async function refreshHistoryCount() {
        try {
          const list = await api.historyList();
          histCount.textContent = Array.isArray(list) ? String(list.length) : '0';
        } catch (e) {
          histCount.textContent = '0';
        }
      }
      refreshHistoryCount();

      // 历史变化时联动刷新数量（onHistoryChanged 返回取消函数）
      let offHistory = null;
      if (typeof api.onHistoryChanged === 'function') {
        try {
          offHistory = api.onHistoryChanged(function () { refreshHistoryCount(); });
        } catch (e) { /* 忽略 */ }
      }
      // 页面被重建时（render 再次调用前）解绑：监听容器节点移除
      observeDetach(pageRoot, function () { // 监听会被 innerHTML='' 移除的 .settings-page，而非常驻的 #page(el)，否则订阅永不退订
        if (typeof offHistory === 'function') { try { offHistory(); } catch (e) {} offHistory = null; }
      });

      // ----------------------------------------------------------
      // 自绘清空历史的确认弹窗（不依赖原生 confirm）
      // ----------------------------------------------------------
      function openClearConfirm() {
        const dialog = h('div', { class: 'kk-confirm glass' }, [
          h('div', { class: 'kk-confirm-icon' }, ico(ICONS.删除, 'ico-lg')),
          h('div', { class: 'kk-confirm-title' }, '清空全部历史记录？'),
          h('div', { class: 'kk-confirm-text' }, '将永久删除所有截图与录屏历史条目，此操作不可恢复。'),
          h('div', { class: 'kk-confirm-actions' }, [
            h('button', { class: 'btn btn-ghost', type: 'button', onClick: close }, '取消'),
            h('button', { class: 'btn btn-danger', type: 'button', onClick: doClear }, '确认清空'),
          ]),
        ]);
        const mask = h('div', { class: 'kk-mask' }, dialog);
        mask.addEventListener('click', function (ev) { if (ev.target === mask) close(); });
        document.addEventListener('keydown', onEsc, true);
        el.querySelector('.settings-page').appendChild(mask);

        function onEsc(ev) { if (ev.key === 'Escape') { ev.stopPropagation(); close(); } }
        function close() {
          document.removeEventListener('keydown', onEsc, true);
          if (mask.parentNode) mask.parentNode.removeChild(mask);
        }
        async function doClear() {
          const ok = dialog.querySelector('.btn-danger');
          ok.disabled = true;
          ok.textContent = '清空中…';
          try {
            await api.historyClear();
            await refreshHistoryCount();
            toast('历史记录已清空', 'ok');
          } catch (e) {
            toast('清空失败：' + (e && e.message ? e.message : '未知错误'), 'err');
          } finally {
            close();
          }
        }
      }

      // ==========================================================
      // 填充表单（读配置）
      // ==========================================================
      function fillForm(cfg) {
        const ds = cfg.deepseek || {};
        const sc = cfg.shortcuts || {};
        const ocr = cfg.ocr || {};
        const rec = cfg.recording || {};
        const cap = cfg.capture || {};
        const gen = cfg.general || {};

        // 通用
        tgLaunch.querySelector('.kk-toggle-input').checked = !!gen.launchAtLogin;
        inSaveDir.value = gen.saveDir || '';
        selTheme.value = gen.theme === 'dark' ? 'dark' : 'light';
        applyTheme(selTheme.value);

        // 快捷键
        SHORTCUTS.forEach(function (item) {
          shortcutInputs[item.key].value = sc[item.key] || '';
        });

        // 截图
        tgCopyAfter.querySelector('.kk-toggle-input').checked = !!cap.copyAfterCapture;
        tgAutoPin.querySelector('.kk-toggle-input').checked = !!cap.autoPin;
        tgAutoSaveHistory.querySelector('.kk-toggle-input').checked = !!cap.autoSaveHistory;

        // 录屏
        inFps.value = rec.fps != null ? rec.fps : '';
        tgGif.querySelector('.kk-toggle-input').checked = !!rec.toGif;

        // OCR
        const engine = (ocr.engine && ocr.engine !== 'local') ? 'model' : 'local';
        ocrRadios.forEach(function (r) { r.checked = r.value === engine; });
        updateRadioVisual();
        inLang.value = ocr.lang || '';

        // AI 模型
        fillKeyInput(inApiKey, ds.apiKey);
        inBaseUrl.value = ds.baseUrl || '';
        inVision.value = ds.visionModel || '';
        inText.value = ds.textModel || '';
        // 通用 OpenAI 兼容服务商回填（先按预设铺底，再用已存值覆盖）
        const oa = cfg.openai || {};
        applyPreset(oa.preset || 'siliconflow', false);
        fillKeyInput(inOaKey, oa.apiKey);
        inOaBase.value = oa.baseUrl || (OPENAI_PRESETS[oaState.preset] || {}).baseUrl || '';
        inOaModel.value = oa.model || (OPENAI_PRESETS[oaState.preset] || {}).defaultModel || '';

        // AI 提供方 + MiniMax
        const mm = cfg.minimax || {};
        setProvider((cfg.ai && cfg.ai.provider) || 'deepseek', false);
        fillKeyInput(inMmKey, mm.apiKey);
        inMmBase.value = mm.baseUrl || '';
        inMmModel.value = mm.visionModel || mm.textModel || '';
        taAsk.value = ds.askImagePrompt || '';
        taOcr.value = ds.ocrPrompt || '';
        taTranslate.value = ds.translatePrompt || '';
        taPolish.value = ds.polishPrompt || '';
      }

      async function loadConfig() {
        try {
          const cfg = await api.getConfig();
          currentConfig = cfg && typeof cfg === 'object' ? cfg : {};
        } catch (e) {
          currentConfig = {};
          toast('读取配置失败：' + (e && e.message ? e.message : '未知错误'), 'err');
        }
        fillForm(currentConfig);
      }

      loadConfig();
    },
  };

  // ============================================================
  // 四、辅助：监听某节点从文档中被移除，触发回调（用于解绑订阅）
  // ============================================================
  function observeDetach(node, cb) {
    if (typeof MutationObserver === 'undefined') return;
    const mo = new MutationObserver(function () {
      if (!document.contains(node)) {
        mo.disconnect();
        try { cb(); } catch (e) { /* 忽略 */ }
      }
    });
    const root = node.parentNode || document.body;
    if (root) mo.observe(root, { childList: true, subtree: true });
  }
})();
