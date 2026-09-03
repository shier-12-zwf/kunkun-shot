// 历史记录页 —— 注册到 window.KKPages.history
// 渲染层禁止 require / import：所有与主进程的交互一律走 window.kkapi。
// render(el, ctx) 会被多次调用，每次先清空容器再重建（幂等）。
(function () {
  'use strict';

  // ---------- 线性 SVG 图标（内联，禁用 Emoji 做功能图标）----------
  // 统一 viewBox="0 0 24 24"，靠 design.css 的 .ico 描边着色。
  const ICONS = {
    搜索: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>',
    删除: '<path d="M4 7h16 M9 7V4h6v3 M6 7l1 13h10l1-13"/>',
    复制: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    导出: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4 M7 10l5 5 5-5 M12 15V3"/>',
    OCR文字: '<path d="M4 7V5h16v2 M9 19h6 M12 5v14"/>',
    翻译: '<path d="M4 5h7 M7 5v2c0 3-2 5-4 6 M5 11c1 2 3 3 5 3 M13 19l4-9 4 9 M15 16h4"/>',
    AI: '<path d="M12 3l1.8 4.7L18.5 9.5 13.8 11.3 12 16l-1.8-4.7L5.5 9.5l4.7-1.8z"/>',
    相机: '<path d="M3 8a2 2 0 0 1 2-2h2l1.2-2h5.6L17 6h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><circle cx="12" cy="12.5" r="3.2"/>',
    区域: '<path d="M7 3v4H3 M17 3v4h4 M7 21v-4H3 M17 21v-4h4"/>',
    窗口: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 9h18"/>',
    全屏: '<path d="M4 9V4h5 M20 9V4h-5 M4 15v5h5 M20 15v5h-5"/>',
    延时: '<circle cx="12" cy="13" r="8"/><path d="M12 13V9 M9 2h6"/>',
    长截图: '<rect x="6" y="3" width="12" height="18" rx="2"/><path d="M12 6v12 M9 9l3-3 3 3 M9 15l3 3 3-3"/>',
    录屏: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3" fill="currentColor"/>',
    贴图: '<rect x="4" y="4" width="13" height="13" rx="2"/><path d="M9 20h9a2 2 0 0 0 2-2V9"/>',
    关闭: '<path d="M6 6l12 12 M18 6L6 18"/>',
    勾选: '<path d="M5 12l5 5 9-11"/>',
    图片: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9" r="1.6"/><path d="M5 18l5-5 3 3 3-3 4 4"/>',
    PDF: '<path d="M6 3h8l4 4v14H6z M14 3v5h5"/><path d="M8.5 16v-5h2a1.5 1.5 0 0 1 0 3h-2 M13 16v-5h1.3c1.5 0 2.2.9 2.2 2.5S15.8 16 14.3 16z"/>',
  };

  // 类型元信息：键对应 item.type，名用于筛选与详情展示。
  const TYPE_META = {
    region: { name: '区域', icon: '区域' },
    window: { name: '窗口', icon: '窗口' },
    fullscreen: { name: '全屏', icon: '全屏' },
    timed: { name: '延时', icon: '延时' },
    long: { name: '长截图', icon: '长截图' },
    recording: { name: '录屏', icon: '录屏' },
    pin: { name: '贴图', icon: '贴图' },
  };

  // 类型筛选标签顺序（含「全部」）
  const FILTERS = [
    { key: 'all', name: '全部' },
    { key: 'region', name: '区域' },
    { key: 'window', name: '窗口' },
    { key: 'fullscreen', name: '全屏' },
    { key: 'timed', name: '延时' },
    { key: 'long', name: '长截图' },
    { key: 'recording', name: '录屏' },
    { key: 'pin', name: '贴图' },
  ];

  // ---------- 工具函数 ----------
  // 生成一个线性图标 <svg>，cls 控制尺寸（ico / ico-sm / ico-lg）。
  function svgIcon(name, cls) {
    const inner = ICONS[name] || '';
    return (
      '<svg class="' + (cls || 'ico') + '" viewBox="0 0 24 24" aria-hidden="true">' + inner + '</svg>'
    );
  }

  // 创建元素的轻量辅助：tag + className + 可选内部 HTML。
  function el(tag, cls, html) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (html != null) node.innerHTML = html;
    return node;
  }

  // 类型名（用于搜索匹配与展示），未知类型回退为「截图」。
  function typeName(type) {
    return (TYPE_META[type] && TYPE_META[type].name) || '截图';
  }

  function typeIconName(type) {
    return (TYPE_META[type] && TYPE_META[type].icon) || '图片';
  }

  // 把毫秒时间戳格式化成 yyyy-MM-dd 的「天键」，用于分组。
  function dayKey(ms) {
    const d = new Date(ms);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + day;
  }

  // 把「天键」转成人类可读分组标题：今天 / 昨天 / 具体日期。
  function dayLabel(key) {
    const now = new Date();
    const todayKey = dayKey(now.getTime());
    const yKey = dayKey(now.getTime() - 24 * 60 * 60 * 1000);
    if (key === todayKey) return '今天';
    if (key === yKey) return '昨天';
    return key;
  }

  // 具体时间（HH:mm），用于详情与卡片角标。
  function timeLabel(ms) {
    const d = new Date(ms);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return hh + ':' + mm;
  }

  // 完整时间（详情面板）。
  function fullTimeLabel(ms) {
    const d = new Date(ms);
    const pad = (n) => String(n).padStart(2, '0');
    return (
      d.getFullYear() +
      '-' + pad(d.getMonth() + 1) +
      '-' + pad(d.getDate()) +
      ' ' + pad(d.getHours()) +
      ':' + pad(d.getMinutes()) +
      ':' + pad(d.getSeconds())
    );
  }

  function formatBytes(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(n < 10 * 1024 ? 1 : 0) + ' KB';
    if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0) + ' MB';
    return (n / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
  }

  // ---------- 页面注册 ----------
  window.KKPages = window.KKPages || {};
  window.KKPages.history = {
    title: '历史记录',
    render(rootEl, ctx) {
      rootEl.innerHTML = '';

      // —— 页面级状态（每次 render 重置）——
      let allItems = []; // historyList 原始数据
      let filterType = 'all'; // 当前类型筛选
      let keyword = ''; // 搜索关键词
      let selected = new Set(); // 多选集合（id）
      let lastSingleId = null; // 单选时记住的 id（用于多选取消后回退）
      let offHistory = null; // onHistoryChanged 取消订阅
      let detailToken = 0; // 详情异步加载竞态令牌

      // —— 顶层骨架 ——
      const page = el('div', 'kk-history');

      // 工具条
      const toolbar = el('div', 'kk-hist-toolbar');

      // 搜索框
      const searchWrap = el('div', 'kk-hist-search');
      searchWrap.innerHTML = svgIcon('搜索', 'ico-sm');
      const searchInput = el('input', 'input');
      searchInput.type = 'search';
      searchInput.placeholder = '搜索类型或日期…';
      searchInput.setAttribute('aria-label', '搜索历史记录');
      searchWrap.appendChild(searchInput);

      // 类型筛选胶囊
      const filterBar = el('div', 'kk-hist-filters');
      const chipEls = {};
      FILTERS.forEach((f) => {
        const chip = el('button', 'chip', f.name);
        chip.type = 'button';
        if (f.key === 'all') chip.classList.add('active');
        chip.addEventListener('click', () => {
          filterType = f.key;
          Object.keys(chipEls).forEach((k) =>
            chipEls[k].classList.toggle('active', k === f.key)
          );
          renderGrid();
        });
        chipEls[f.key] = chip;
        filterBar.appendChild(chip);
      });

      // 右侧「清空」按钮
      const clearBtn = el('button', 'btn btn-danger', svgIcon('删除', 'ico-sm') + '<span>清空</span>');
      clearBtn.type = 'button';
      clearBtn.addEventListener('click', () => {
        if (!allItems.length) return;
        confirmDialog({
          title: '清空全部历史？',
          desc: '将永久删除全部 ' + allItems.length + ' 条历史记录，此操作不可撤销。',
          okText: '清空全部',
          danger: true,
          onOk: async () => {
            try {
              await kkapi.historyClear();
            } catch (_) {}
            selected.clear();
            lastSingleId = null;
            await reload();
          },
        });
      });

      const spacer = el('div', 'kk-hist-spacer');
      toolbar.appendChild(searchWrap);
      toolbar.appendChild(filterBar);
      toolbar.appendChild(spacer);
      toolbar.appendChild(clearBtn);

      // 主体：左侧网格 + 右侧详情
      const body = el('div', 'kk-hist-body');
      const gridScroll = el('div', 'kk-hist-grid-scroll');
      const detailPanel = el('aside', 'kk-hist-detail card');
      body.appendChild(gridScroll);
      body.appendChild(detailPanel);

      page.appendChild(toolbar);
      page.appendChild(body);
      rootEl.appendChild(page);

      // —— 搜索输入（防抖）——
      let searchTimer = null;
      searchInput.addEventListener('input', () => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => {
          keyword = searchInput.value.trim().toLowerCase();
          renderGrid();
        }, 120);
      });

      // —— 过滤：返回符合筛选 + 关键词的项 ——
      function filteredItems() {
        return allItems.filter((it) => {
          if (filterType !== 'all' && it.type !== filterType) return false;
          if (!keyword) return true;
          // 关键词匹配：类型名 + 天键 + 可读时间
          const hay = (
            typeName(it.type) +
            ' ' + dayKey(it.time) +
            ' ' + dayLabel(dayKey(it.time)) +
            ' ' + timeLabel(it.time)
          ).toLowerCase();
          return hay.indexOf(keyword) !== -1;
        });
      }

      // —— 渲染网格（按天分组）——
      function renderGrid() {
        gridScroll.innerHTML = '';
        clearBtn.disabled = !allItems.length;

        // 完全没有历史 → 空状态引导
        if (!allItems.length) {
          gridScroll.appendChild(buildEmptyState());
          renderDetail();
          return;
        }

        const items = filteredItems();

        // 有历史但筛选无结果 → 轻量提示
        if (!items.length) {
          const none = el('div', 'kk-hist-noresult');
          none.innerHTML =
            svgIcon('搜索', 'ico-lg') +
            '<div class="kk-hist-noresult-title">没有匹配的记录</div>' +
            '<div class="kk-hist-noresult-desc">试试更换筛选类型或清空搜索关键词。</div>';
          gridScroll.appendChild(none);
          renderDetail();
          return;
        }

        // 按天分组（保持时间倒序：historyList 通常已倒序，这里再保险排序）
        const sorted = items.slice().sort((a, b) => b.time - a.time);
        const groups = [];
        const groupMap = {};
        sorted.forEach((it) => {
          const k = dayKey(it.time);
          if (!groupMap[k]) {
            groupMap[k] = { key: k, items: [] };
            groups.push(groupMap[k]);
          }
          groupMap[k].items.push(it);
        });

        // P2-5(B5)：分批渲染 + 懒加载缩略图（buildCard 内已用 loading=lazy），
        // 历史很多时不再一次性铺满 DOM；每组先渲染 24 条，「加载更多」逐组追加。
        groups.forEach((g, gi) => {
          const group = el('section', 'kk-hist-group');
          if (gi > 0) group.classList.add('is-collapsed');
          const head = el('div', 'kk-hist-group-head');
          head.innerHTML =
            '<span class="kk-hist-group-title"><span class="kk-hist-group-caret">▸</span>' + escapeHTML(dayLabel(g.key)) + '</span>' +
            '<span class="kk-hist-group-count">' + g.items.length + ' 条</span>';
          head.addEventListener('click', () => group.classList.toggle('is-collapsed'));
          group.appendChild(head);
          const grid = el('div', 'kk-hist-grid');
          group.appendChild(grid);
          gridScroll.appendChild(group);
          g._grid = grid;
        });

        groups.forEach((g) => {
          const n = Math.min(24, g.items.length);
          for (let i = 0; i < n; i++) g._grid.appendChild(buildCard(g.items[i]));
          g._renderedCount = n;
        });

        const moreBtn = el('button', 'kk-hist-more');
        moreBtn.textContent = '加载更多';
        const refreshMore = () => {
          moreBtn.style.display = groups.some((g) => g._renderedCount < g.items.length) ? '' : 'none';
        };
        moreBtn.addEventListener('click', () => {
          groups.forEach((g) => {
            if (g._renderedCount >= g.items.length) return;
            let n = 0;
            while (n < 24 && g._renderedCount + n < g.items.length) {
              g._grid.appendChild(buildCard(g.items[g._renderedCount + n]));
              n += 1;
            }
            g._renderedCount += n;
          });
          refreshMore();
        });
        gridScroll.appendChild(moreBtn);
        refreshMore();

        renderDetail();
      }

      // —— 构建单个缩略图卡片 ——
      function buildCard(it) {
        const card = el('div', 'kk-hist-card');
        card.dataset.id = it.id;
        if (selected.has(it.id)) card.classList.add('selected');

        // 缩略图
        const thumbBox = el('div', 'kk-hist-thumb');
        if (it.thumb) {
          const img = el('img');
          img.src = it.thumb;
          img.alt = typeName(it.type) + '截图';
          img.loading = 'lazy';
          img.draggable = false;
          thumbBox.appendChild(img);
        } else {
          // 录屏没有图片缩略图；损坏图片也用其语义类型作为占位。
          const ph = el('div', 'kk-hist-thumb-ph');
          ph.innerHTML = svgIcon(typeIconName(it.type), 'ico-lg');
          thumbBox.appendChild(ph);
        }

        // 左上角多选勾选框
        const check = el('button', 'kk-hist-check');
        check.type = 'button';
        check.setAttribute('aria-label', '选择');
        check.innerHTML = svgIcon('勾选', 'ico-sm');
        check.addEventListener('click', (e) => {
          e.stopPropagation();
          toggleSelect(it.id);
        });
        thumbBox.appendChild(check);

        // 右下角类型角标
        const badge = el('span', 'kk-hist-badge');
        badge.innerHTML = svgIcon(typeIconName(it.type), 'ico-sm') + '<span>' + escapeHTML(typeName(it.type)) + '</span>';
        thumbBox.appendChild(badge);

        card.appendChild(thumbBox);

        // 卡片底部元信息
        const meta = el('div', 'kk-hist-card-meta');
        const dims = it.width && it.height
          ? it.width + '×' + it.height
          : (it.kind === 'media' && it.size ? formatBytes(it.size) : '');
        meta.innerHTML =
          '<span class="kk-hist-card-time">' + escapeHTML(timeLabel(it.time)) + '</span>' +
          (dims ? '<span class="kk-hist-card-dims">' + escapeHTML(dims) + '</span>' : '');
        card.appendChild(meta);

        // 点击卡片：选中（单选预览）。多选模式下点击 = 切换勾选。
        card.addEventListener('click', () => {
          if (selected.size > 0) {
            toggleSelect(it.id);
          } else {
            selectSingle(it.id);
          }
        });

        return card;
      }

      // —— 选择逻辑 ——
      // 单选：清空多选，记住该 id，刷新卡片高亮与详情。
      function selectSingle(id) {
        selected.clear();
        lastSingleId = id;
        refreshSelectionUI();
        renderDetail();
      }

      // 多选切换
      function toggleSelect(id) {
        if (selected.has(id)) selected.delete(id);
        else selected.add(id);
        // 进入多选后，单选预览让位给批量面板
        lastSingleId = selected.size === 1 ? Array.from(selected)[0] : null;
        refreshSelectionUI();
        renderDetail();
      }

      // 仅刷新卡片选中态样式（避免整页重建）。
      function refreshSelectionUI() {
        const cards = gridScroll.querySelectorAll('.kk-hist-card');
        cards.forEach((c) => {
          const id = c.dataset.id;
          c.classList.toggle('selected', selected.has(id));
          c.classList.toggle('single', selected.size === 0 && id === lastSingleId);
        });
      }

      // —— 详情面板渲染 ——
      function renderDetail() {
        detailToken++;
        detailPanel.innerHTML = '';

        // 多选 → 批量操作面板
        if (selected.size > 0) {
          detailPanel.appendChild(buildBulkPanel());
          refreshSelectionUI();
          return;
        }

        // 单选 → 单图详情
        const id = lastSingleId;
        const exists = id && allItems.some((it) => it.id === id);
        if (!id || !exists) {
          detailPanel.appendChild(buildDetailEmpty());
          refreshSelectionUI();
          return;
        }
        buildSinglePanel(id);
        refreshSelectionUI();
      }

      // 详情面板：未选中占位
      function buildDetailEmpty() {
        const box = el('div', 'kk-hist-detail-empty');
        box.innerHTML =
          svgIcon('图片', 'ico-lg') +
          '<div class="kk-hist-detail-empty-title">选择一条历史记录</div>' +
          '<div class="kk-hist-detail-empty-desc">点击左侧记录查看详情；截图可复制、识别或翻译，录屏可再次导出。</div>';
        return box;
      }

      // 详情面板：单图（异步取原图，带竞态保护）
      function buildSinglePanel(id) {
        const meta = allItems.find((it) => it.id === id);
        if (!meta) {
          detailPanel.appendChild(buildDetailEmpty());
          return;
        }
        const myToken = detailToken;
        const isMedia = meta.kind === 'media';

        const head = el('div', 'kk-hist-detail-head');
        head.innerHTML =
          '<span class="eyebrow">历史详情</span>' +
          '<span class="kk-hist-detail-type">' +
          svgIcon(typeIconName(meta.type), 'ico-sm') +
          escapeHTML(typeName(meta.type)) +
          '</span>';

        const preview = el('div', 'kk-hist-preview');
        preview.innerHTML = isMedia
          ? '<div class="kk-hist-preview-loading">' + svgIcon('录屏', 'ico-lg') + '<div>录屏文件</div></div>'
          : '<div class="kk-hist-preview-loading">加载预览…</div>';

        const info = el('div', 'kk-hist-info');
        const dims = meta.width && meta.height ? meta.width + ' × ' + meta.height + ' px' : '未知';
        info.innerHTML =
          infoRow('类型', typeName(meta.type)) +
          infoRow(isMedia ? '大小' : '尺寸', isMedia ? formatBytes(meta.size) : dims) +
          infoRow('时间', fullTimeLabel(meta.time));

        // 操作区
        const actions = el('div', 'kk-hist-actions');

        const btnCopy = actionBtn('复制', '复制', 'btn-soft');
        const btnExport = actionBtn('导出', '导出', 'btn-ghost');
        const btnOCR = actionBtn('OCR文字', '识别文字', 'btn-ghost');
        const btnTrans = actionBtn('翻译', '翻译', 'btn-ghost');
        const btnAI = actionBtn('AI', '发送到 AI 工作台', 'btn-ghost');
        btnAI.classList.add('kk-hist-act-wide'); // 占满整行
        const btnDel = actionBtn('删除', '删除', 'btn-danger');

        if (!isMedia) actions.appendChild(btnCopy);
        actions.appendChild(btnExport);
        if (!isMedia) actions.appendChild(btnOCR);
        if (!isMedia) actions.appendChild(btnTrans);
        if (!isMedia) actions.appendChild(btnAI);
        actions.appendChild(btnDel);

        detailPanel.appendChild(head);
        detailPanel.appendChild(preview);
        detailPanel.appendChild(info);
        detailPanel.appendChild(actions);

        // 图片异步取原图；录屏只展示受管文件元数据，不把大视频读成 data URL。
        let dataURL = '';
        if (!isMedia) {
          [btnCopy, btnOCR, btnTrans].forEach((b) => { if (b) b.disabled = true; });
          (async () => {
            try {
              const res = await kkapi.historyGet(id);
              if (myToken !== detailToken) return; // 选中已切换，丢弃
              dataURL = (res && res.dataURL) || '';
              [btnCopy, btnOCR, btnTrans].forEach((b) => { if (b) b.disabled = !dataURL; });
              preview.innerHTML = '';
              if (dataURL) {
                const img = el('img');
                img.src = dataURL;
                img.alt = typeName(meta.type) + '原图';
                img.draggable = false;
                preview.appendChild(img);
              } else {
                preview.innerHTML = '<div class="kk-hist-preview-loading">原图不可用</div>';
              }
            } catch (e) {
              if (myToken !== detailToken) return;
              preview.innerHTML = '<div class="kk-hist-preview-loading">预览加载失败</div>';
            }
          })();
        }

        // —— 操作绑定 ——
        if (!isMedia) {
          btnCopy.addEventListener('click', async () => {
            if (!dataURL) return;
            try {
              await kkapi.copyImage(dataURL);
              flashBtn(btnCopy, '已复制');
            } catch (_) {}
          });
        }

        btnExport.addEventListener('click', async () => {
          try {
            const res = await kkapi.historyExport(id);
            if (res && res.saved) flashBtn(btnExport, '已导出');
          } catch (_) {}
        });

        if (!isMedia) {
          btnOCR.addEventListener('click', () => {
            if (!dataURL) return;
            try {
              kkapi.openAIPanel({ mode: 'ocr', dataURL });
            } catch (_) {}
          });

          btnTrans.addEventListener('click', () => {
            if (!dataURL) return;
            try {
              kkapi.openAIPanel({ mode: 'translateImage', dataURL });
            } catch (_) {}
          });

          btnAI.addEventListener('click', () => {
            try {
              if (window.KKMain && typeof window.KKMain.go === 'function') {
                window.KKMain.go('ai', { imageId: id });
              }
            } catch (_) {}
          });
        }

        btnDel.addEventListener('click', () => {
          confirmDialog({
            title: '删除这条历史记录？',
            desc: '删除后无法恢复。',
            okText: '删除',
            danger: true,
            onOk: async () => {
              try {
                await kkapi.historyDelete(id);
              } catch (_) {}
              if (lastSingleId === id) lastSingleId = null;
              selected.delete(id);
              await reload();
            },
          });
        });
      }

      // 详情面板：多选批量
      function buildBulkPanel() {
        const box = el('div', 'kk-hist-bulk');
        const ids = Array.from(selected);
        const selectedItems = ids.map((id) => allItems.find((item) => item.id === id)).filter(Boolean);
        const canMergePdf = ids.length > 0
          && ids.length <= 100
          && selectedItems.length === ids.length
          && selectedItems.every((item) => item.kind !== 'media');

        const head = el('div', 'kk-hist-detail-head');
        head.innerHTML = '<span class="eyebrow">批量操作</span>';

        const count = el('div', 'kk-hist-bulk-count');
        count.innerHTML =
          '<span class="kk-hist-bulk-num">' + ids.length + '</span>' +
          '<span class="kk-hist-bulk-label">已选 ' + ids.length + ' 条</span>';

        // 选中缩略图条带预览
        const strip = el('div', 'kk-hist-bulk-strip');
        ids.slice(0, 12).forEach((id) => {
          const it = allItems.find((x) => x.id === id);
          if (!it) return;
          const t = el('div', 'kk-hist-bulk-thumb');
          if (it.thumb) {
            const img = el('img');
            img.src = it.thumb;
            img.draggable = false;
            t.appendChild(img);
          } else {
            t.innerHTML = svgIcon(typeIconName(it.type), 'ico-sm');
          }
          strip.appendChild(t);
        });
        if (ids.length > 12) {
          const more = el('div', 'kk-hist-bulk-thumb kk-hist-bulk-more', '+' + (ids.length - 12));
          strip.appendChild(more);
        }

        const actions = el('div', 'kk-hist-actions');
        const btnSelectAll = actionBtn('勾选', '全选当前', 'btn-ghost');
        const btnClearSel = actionBtn('关闭', '取消选择', 'btn-ghost');
        const btnExport = actionBtn('导出', '批量导出', 'btn-soft');
        const btnPdf = actionBtn('PDF', '合并多页 PDF', 'btn-soft');
        const btnDel = actionBtn('删除', '批量删除', 'btn-danger');

        btnPdf.disabled = !canMergePdf || typeof kkapi.historyExportPdf !== 'function';
        if (!canMergePdf) {
          btnPdf.title = ids.length > 100
            ? '多页 PDF 最多合并 100 张图片'
            : '多页 PDF 只能合并图片，请取消选中的录屏';
        }

        actions.appendChild(btnSelectAll);
        actions.appendChild(btnClearSel);
        actions.appendChild(btnExport);
        actions.appendChild(btnPdf);
        actions.appendChild(btnDel);

        box.appendChild(head);
        box.appendChild(count);
        box.appendChild(strip);
        box.appendChild(actions);

        // 全选当前筛选下的所有项
        btnSelectAll.addEventListener('click', () => {
          filteredItems().forEach((it) => selected.add(it.id));
          lastSingleId = null;
          renderDetail();
        });

        btnClearSel.addEventListener('click', () => {
          selected.clear();
          lastSingleId = null;
          renderDetail();
        });

        // 批量导出：选一次目录、全部导出（避免逐张弹保存框）；旧 preload 无此能力时回退逐张。
        btnExport.addEventListener('click', async () => {
          btnExport.disabled = true;
          try {
            if (kkapi.historyExportMany) {
              const res = await kkapi.historyExportMany(ids);
              if (res && res.saved) flashBtn(btnExport, '已导出 ' + res.count + ' 项');
              else flashBtn(btnExport, '已取消');
            } else {
              let ok = 0;
              for (const id of ids) {
                try { const res = await kkapi.historyExport(id); if (res && res.saved) ok++; } catch (_) {}
              }
              flashBtn(btnExport, '已导出 ' + ok + ' 项');
            }
          } finally {
            btnExport.disabled = false;
          }
        });

        btnPdf.addEventListener('click', async () => {
          if (!canMergePdf || typeof kkapi.historyExportPdf !== 'function') return;
          btnPdf.disabled = true;
          try {
            const res = await kkapi.historyExportPdf(ids);
            if (res && res.saved) flashBtn(btnPdf, '已合并 ' + res.pageCount + ' 页');
            else flashBtn(btnPdf, res && res.error ? '合并失败' : '已取消');
          } catch (_) {
            flashBtn(btnPdf, '合并失败');
          } finally {
            btnPdf.disabled = !canMergePdf;
          }
        });

        // 批量删除：确认后一次性删除（单次写盘 + 单次广播，避免逐个删的刷新风暴）
        btnDel.addEventListener('click', () => {
          confirmDialog({
            title: '删除选中的 ' + ids.length + ' 条记录？',
            desc: '删除后无法恢复。',
            okText: '删除 ' + ids.length + ' 条',
            danger: true,
            onOk: async () => {
              try {
                if (kkapi.historyDeleteMany) await kkapi.historyDeleteMany(ids);
                else for (const id of ids) { try { await kkapi.historyDelete(id); } catch (_) {} }
              } catch (_) {}
              selected.clear();
              lastSingleId = null;
              await reload();
            },
          });
        });

        return box;
      }

      // 信息行 HTML
      function infoRow(k, v) {
        return (
          '<div class="kk-hist-info-row">' +
          '<span class="kk-hist-info-k">' + escapeHTML(k) + '</span>' +
          '<span class="kk-hist-info-v">' + escapeHTML(v) + '</span>' +
          '</div>'
        );
      }

      // 操作按钮（图标 + 文案）
      function actionBtn(iconName, label, variant) {
        const b = el('button', 'btn ' + (variant || 'btn-ghost') + ' kk-hist-act');
        b.type = 'button';
        b.innerHTML = svgIcon(iconName, 'ico-sm') + '<span>' + escapeHTML(label) + '</span>';
        return b;
      }

      // 按钮短暂反馈文案，随后还原
      function flashBtn(btn, text) {
        const span = btn.querySelector('span');
        if (!span) return;
        const old = span.textContent;
        span.textContent = text;
        btn.classList.add('kk-hist-act-ok');
        setTimeout(() => {
          span.textContent = old;
          btn.classList.remove('kk-hist-act-ok');
        }, 1300);
      }

      // —— 空状态（无任何历史）——
      function buildEmptyState() {
        const box = el('div', 'kk-hist-empty');
        // 插画式：相机图标 + 同心光环
        box.innerHTML =
          '<div class="kk-hist-empty-art">' +
          '<span class="kk-hist-empty-ring"></span>' +
          '<span class="kk-hist-empty-ring r2"></span>' +
          svgIcon('相机', 'kk-hist-empty-cam') +
          '</div>' +
          '<div class="kk-hist-empty-title">还没有任何截图记录</div>' +
          '<div class="kk-hist-empty-desc">按下快捷键或点击下方按钮，开始你的第一次区域截图，记录会自动出现在这里。</div>';

        const btn = el('button', 'btn btn-primary kk-hist-empty-btn', svgIcon('区域', 'ico-sm') + '<span>开始第一次截图</span>');
        btn.type = 'button';
        btn.addEventListener('click', () => {
          try {
            kkapi.triggerCapture('region');
          } catch (_) {}
        });
        box.appendChild(btn);
        return box;
      }

      // —— 自绘确认弹窗（替代 window.confirm）——
      function confirmDialog(opt) {
        opt = opt || {};
        const mask = el('div', 'kk-hist-mask');
        const dlg = el('div', 'kk-hist-dialog glass');
        dlg.setAttribute('role', 'dialog');
        dlg.setAttribute('aria-modal', 'true');

        const t = el('div', 'kk-hist-dialog-title', escapeHTML(opt.title || '确认操作'));
        const d = el('div', 'kk-hist-dialog-desc', escapeHTML(opt.desc || ''));
        const row = el('div', 'kk-hist-dialog-actions');

        const cancel = el('button', 'btn btn-ghost', '<span>取消</span>');
        cancel.type = 'button';
        const ok = el('button', 'btn ' + (opt.danger ? 'btn-danger' : 'btn-primary'), '<span>' + escapeHTML(opt.okText || '确定') + '</span>');
        ok.type = 'button';

        row.appendChild(cancel);
        row.appendChild(ok);
        dlg.appendChild(t);
        dlg.appendChild(d);
        dlg.appendChild(row);
        mask.appendChild(dlg);
        rootEl.appendChild(mask);

        function close() {
          if (mask.parentNode) mask.parentNode.removeChild(mask);
          document.removeEventListener('keydown', onKey);
        }
        function onKey(e) {
          if (e.key === 'Escape') close();
        }
        document.addEventListener('keydown', onKey);

        cancel.addEventListener('click', close);
        mask.addEventListener('click', (e) => {
          if (e.target === mask) close();
        });
        ok.addEventListener('click', async () => {
          ok.disabled = true;
          cancel.disabled = true;
          try {
            if (typeof opt.onOk === 'function') await opt.onOk();
          } finally {
            close();
          }
        });
        // 默认聚焦确定按钮，便于回车确认危险操作前的可见焦点
        setTimeout(() => ok.focus(), 0);
      }

      // —— 数据加载（保留当前筛选与有效选中）——
      async function reload() {
        let list = [];
        try {
          list = await kkapi.historyList({ includeMedia: true });
        } catch (_) {
          list = [];
        }
        allItems = Array.isArray(list) ? list : [];

        // 清理已失效的选中 id
        const liveIds = new Set(allItems.map((it) => it.id));
        Array.from(selected).forEach((id) => {
          if (!liveIds.has(id)) selected.delete(id);
        });
        if (lastSingleId && !liveIds.has(lastSingleId)) lastSingleId = null;

        renderGrid();
      }

      // —— HTML 转义（防注入）——
      function escapeHTML(str) {
        return String(str == null ? '' : str)
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#39;');
      }

      // —— 订阅历史变更：重新拉取，保留筛选/搜索/选中 ——
      try {
        if (typeof kkapi.onHistoryChanged === 'function') {
          offHistory = kkapi.onHistoryChanged(() => {
            reload();
          });
        }
      } catch (_) {}

      // render 可能被多次调用：在容器被清空前断开旧订阅，避免泄漏。
      // 通过 MutationObserver 监听本页根被移除。
      const lifeObserver = new MutationObserver(() => {
        if (!page.isConnected) {
          if (typeof offHistory === 'function') {
            try {
              offHistory();
            } catch (_) {}
          }
          offHistory = null;
          lifeObserver.disconnect();
        }
      });
      try {
        lifeObserver.observe(rootEl.parentNode || document.body, { childList: true, subtree: true });
      } catch (_) {}

      // 首次加载
      reload();
    },
  };
})();
