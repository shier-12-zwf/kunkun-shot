// 困困截屏助手 · 主窗口外壳逻辑
// 职责：单窗口多页路由（KKMain.go）、侧栏高亮、标题栏页名同步、内容区滚动复位、
//      启动初始化（onInit）、外部导航（onNav）、主题（theme-dark）应用。
// 约束：渲染层只通过全局 window.kkapi 与主进程通信，绝不 require/import node/electron。

(function () {
  "use strict";

  // 4 个页面的 key 与默认显示名（页面缺失时仍能正确显示标题）
  var PAGE_KEYS = ["capture", "history", "ai", "settings"];
  var FALLBACK_TITLES = {
    capture: "快捷截图",
    history: "历史记录",
    ai: "AI 工作台",
    settings: "设置"
  };

  // 常用 DOM 引用
  var pageEl = document.getElementById("page");
  var navEl = document.getElementById("nav");
  var titlePageEl = document.getElementById("titlebar-page");

  // 当前页 key，避免无意义重渲染时也能携带新 ctx 正常刷新
  var currentPage = null;

  // 取页面模块（可能尚未注册 / 文件缺失）
  function getPage(key) {
    var pages = window.KKPages || {};
    return pages[key] || null;
  }

  // 同步侧栏高亮态
  function highlightNav(key) {
    if (!navEl) return;
    var items = navEl.querySelectorAll(".nav-item");
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      var active = it.getAttribute("data-page") === key;
      it.classList.toggle("active", active);
      if (active) {
        it.setAttribute("aria-current", "page");
      } else {
        it.removeAttribute("aria-current");
      }
    }
  }

  // 更新标题栏的当前页名（优先用页面模块声明的 title）
  function updateTitle(key) {
    if (!titlePageEl) return;
    var mod = getPage(key);
    var name = (mod && mod.title) ? mod.title : (FALLBACK_TITLES[key] || "");
    titlePageEl.textContent = name;
    document.title = "困困截屏助手 · " + name;
  }

  // 核心路由：渲染指定页面到 #page 容器
  var KKMain = {
    go: function (page, ctx) {
      // 校验目标 key，非法则回落到“快捷截图”
      var key = (page && PAGE_KEYS.indexOf(page) !== -1) ? page : "capture";

      // 无论页面模块是否存在，都先把外壳状态对齐（高亮 + 标题）
      highlightNav(key);
      updateTitle(key);
      currentPage = key;

      // 重置共享容器：清除上一页可能残留在 #page 上的内联样式 / 附加类
      // （例如 AI 工作台会把 #page 自身设成三栏 grid），保证每页从干净的外壳容器开始渲染，
      // 否则切到设置页等会被压成上一页的网格列宽。
      if (pageEl) {
        pageEl.scrollTop = 0;
        pageEl.removeAttribute("style");
        pageEl.className = "page";
      }

      var mod = getPage(key);
      if (!mod || typeof mod.render !== "function") {
        // 页面模块缺失：安全跳过，给出占位提示而非报错，避免外壳崩溃
        if (pageEl) {
          pageEl.innerHTML = "";
          var ph = document.createElement("div");
          ph.style.cssText =
            "display:flex;align-items:center;justify-content:center;" +
            "height:100%;padding:40px;color:var(--text-soft);font-size:13px;";
          ph.textContent = "「" + (FALLBACK_TITLES[key] || key) + "」页面暂未就绪。";
          pageEl.appendChild(ph);
        }
        return;
      }

      // 交给页面模块自行清空容器并重建（render 约定幂等、可多次调用）
      try {
        mod.render(pageEl, ctx || {});
      } catch (err) {
        // 页面渲染异常不应拖垮整个外壳
        if (pageEl) {
          pageEl.innerHTML = "";
          var box = document.createElement("div");
          box.style.cssText =
            "max-width:520px;margin:48px auto;padding:18px 20px;" +
            "border:1px solid var(--line);border-radius:var(--r-lg);" +
            "background:var(--surface);color:var(--text);font-size:13px;line-height:1.6;";
          box.textContent = "页面「" + (FALLBACK_TITLES[key] || key) +
            "」渲染出错：" + (err && err.message ? err.message : String(err));
          pageEl.appendChild(box);
        }
        // 控制台保留原始堆栈便于排查
        if (window.console && console.error) console.error("[KKMain] 渲染失败：", key, err);
      }
    }
  };

  window.KKMain = KKMain;

  // —— 侧栏导航点击：委托到 nav 容器 ——
  if (navEl) {
    navEl.addEventListener("click", function (e) {
      var btn = e.target && e.target.closest ? e.target.closest(".nav-item") : null;
      if (!btn) return;
      var key = btn.getAttribute("data-page");
      if (key) KKMain.go(key);
    });
  }

  // —— 主题应用：根据 general.theme 切换 body.theme-dark ——
  function applyTheme(theme) {
    var dark = theme === "dark";
    document.body.classList.toggle("theme-dark", dark);
  }

  // —— 启动初始化 ——
  function boot() {
    var api = window.kkapi;

    // 取配置应用主题（失败也不影响后续路由）
    if (api && typeof api.getConfig === "function") {
      Promise.resolve(api.getConfig())
        .then(function (config) {
          var theme = config && config.general && config.general.theme;
          applyTheme(theme);
        })
        .catch(function () { /* 配置读取失败时维持浅色默认，不报错 */ });
    }

    // 主进程下发初始页（无回调时退化为默认进入“快捷截图”）
    if (api && typeof api.onInit === "function") {
      api.onInit(function (p) {
        KKMain.go((p && p.page) || "capture");
      });
    }

    // 外部导航（如菜单栏弹窗 / 其他窗口请求跳转）
    if (api && typeof api.onNav === "function") {
      api.onNav(function (d) {
        KKMain.go(d && d.page);
      });
    }

    // 兜底：若一段时间内 onInit 未触发（或环境未提供），先渲染默认页
    if (!currentPage) {
      KKMain.go("capture");
    }
  }

  // —— 底部帮助 / 反馈：跳转到设置页作为统一入口（无独立窗口契约） ——
  var helpBtn = document.getElementById("foot-help");
  var feedbackBtn = document.getElementById("foot-feedback");
  if (helpBtn) helpBtn.addEventListener("click", function () { KKMain.go("settings"); });
  if (feedbackBtn) feedbackBtn.addEventListener("click", function () { KKMain.go("settings"); });

  // DOM 已就绪即可启动（脚本置于 body 末尾，元素均已解析）
  boot();
})();
