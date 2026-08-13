# 困困截图工具

一个仿 [PixPin](https://pixpin.cn/) 的跨平台桌面截图工具，基于 Electron 构建。浅色干净的 UI，常驻菜单栏 / 系统托盘，一套全局快捷键随手唤起。除了基础的区域截图与标注，还内置了 **DeepSeek AI**：截一张图直接问 AI，OCR 出来的文字一键翻译 / 润色。

> 平台：macOS / Windows / Linux（核心功能跨平台；屏幕录制权限说明见下文，主要针对 macOS）。
> 当前版本：`0.1.0`（早期版本，长截图与录屏为基础实现，详见「已知局限」）。

---

## 功能列表

- **区域截图 + 标注**：拖拽框选任意区域，截图层内可进行标注后，复制、保存、贴到屏幕、送去 OCR 或直接问 AI。
- **贴图钉屏（Pin）**：把截图或剪贴板里的图片钉在屏幕最上层，方便对照参考；支持多个贴图窗口同时存在。
- **长截图**：框选区域后进入长截图模式，用于滚动页面的拼接采集（基础版）。
- **OCR 文字识别**：两种引擎可选——
  - `local`：本地 [tesseract.js](https://github.com/naptha/tesseract.js)，离线可用（首次需联网下载语言包）。
  - `deepseek`：走 DeepSeek 多模态视觉模型识别，效果更好但需联网与 API Key。
- **录屏（WebM / GIF）**：框选区域录制屏幕，保存为 `.webm`，或经 ffmpeg 转码导出为 `.gif`（基础版）。
- **内置 DeepSeek AI**：
  - **截图问 AI**：把截图连同提示词发给视觉模型（默认 `deepseek-v4-pro`），流式返回解题 / 报错分析 / 内容说明。
  - **文字翻译**：中英互译，使用纯文本模型（默认 `deepseek-v4-flash`）。
  - **文字润色**：让一段文字更通顺、专业、自然，保持原意。
- **菜单栏 / 托盘常驻**：所有功能都可从托盘菜单触发，macOS 上默认隐藏 Dock 图标。
- **全局快捷键**：在任意应用前台都能唤起截图、录屏、长截图、OCR、贴剪贴板图片。

---

## 安装与运行

环境要求：[Node.js](https://nodejs.org/)（建议 18 及以上）。本机已在 Node 24、Electron 42 上验证。

```bash
# 1. 安装依赖
npm install

# 2. 启动应用
npm start
```

其他脚本：

```bash
npm run dev        # 以 --dev 模式启动（开发调试）
npm run dist       # 用 electron-builder 打包当前平台
npm run dist:mac   # 仅打包 macOS（dmg）
```

> ⚠️ **打包前需准备本地 OCR 语言包**：`tessdata/` 目录未随仓库入库（体积较大），但 `electron-builder` 的 `extraResources` 会把它打进安装包。首次 clone 后若要打包，请从
> [tesseract-ocr/tessdata](https://github.com/tesseract-ocr/tessdata) 下载 `chi_sim.traineddata`
> 与 `eng.traineddata` 放入项目根的 `tessdata/`，否则打包会因资源缺失失败。

启动后应用不会弹出主窗口，而是常驻在 **菜单栏 / 系统托盘**（图标为 📸）。从托盘菜单或快捷键即可使用全部功能。

---

## macOS「屏幕录制」权限说明

在 macOS 上，截图与录屏都依赖系统的 **屏幕录制（Screen Recording）** 权限。否则截到的会是空白或纯桌面壁纸。

1. 打开 **系统设置 → 隐私与安全性 → 屏幕录制**。
2. 在列表里找到 **困困截图工具**（开发模式下可能显示为 **Electron** / 终端），打开开关授权。
3. **完全退出并重新启动应用**（macOS 对该权限的变更需要重启进程才生效）。

首次截图时若未授权，系统会自动弹出授权请求；应用也会在截图失败时给出指向上述路径的提示弹窗。

---

## DeepSeek AI 配置步骤

AI 相关功能（问图、翻译、润色、DeepSeek OCR）需要一个 DeepSeek API Key。

1. 到 [DeepSeek 开放平台](https://platform.deepseek.com/) 注册并创建 API Key。
2. 启动应用 → 托盘菜单 → **设置…**，打开设置页。
3. 在 **DeepSeek** 区域填写：
   - **API Key**：粘贴你的密钥。
   - **Base URL**：默认 `https://api.deepseek.com/v1`（OpenAI 兼容端点，实际请求 `{baseUrl}/chat/completions`）。
   - **图片识别模型（visionModel）**：默认 `deepseek-v4-pro`，用于「截图问 AI」和「DeepSeek OCR」。
   - **文本模型（textModel）**：默认 `deepseek-v4-flash`，用于「翻译 / 润色」。
   - 各类提示词（问图 / OCR / 翻译 / 润色）均可自定义。
4. 在设置页点击 **测试连接**，验证 Key 是否可用（成功会返回模型的简短回复）。

> 说明：图片多模态识别请使用 `deepseek-v4-pro`。旧的 `deepseek-chat` / `deepseek-reasoner` 已被官方标注弃用且不支持图片输入，因此默认不再使用。

---

## 默认快捷键

| 功能 | 默认快捷键（macOS） | 默认快捷键（Windows / Linux） |
| --- | --- | --- |
| 区域截图 | `⌘ + ⇧ + A` | `Ctrl + Shift + A` |
| 截图并 OCR | `⌘ + ⇧ + O` | `Ctrl + Shift + O` |
| 长截图（滚动拼接） | `⌘ + ⇧ + L` | `Ctrl + Shift + L` |
| 区域录屏 | `⌘ + ⇧ + R` | `Ctrl + Shift + R` |
| 把剪贴板图片贴到屏幕 | `⌘ + ⇧ + P` | `Ctrl + Shift + P` |

> 快捷键使用 Electron 的 accelerator 字符串配置（如 `CommandOrControl+Shift+A`），可在设置页自行修改；修改后立即重新注册，无需重启。

---

## 项目架构

纯无打包结构：主进程为 CommonJS Node 代码，渲染层为纯 HTML/CSS/JS（无框架、无构建步骤），以 `file://` 加载。主进程与渲染层之间通过 `preload` 注入的、经 `contextBridge` 隔离的 `window.kkapi` 通信，渲染层不直接接触任何 Node / Electron 模块。

```
src/
├── main/                 # 主进程（Node / Electron）
│   ├── main.js           # 入口：单实例锁、托盘菜单、全局快捷键、屏幕捕获编排、全部 IPC 处理
│   ├── windows.js        # 窗口工厂：截图层 / 贴图 / 设置 / AI 面板 / 录屏控制条
│   ├── config.js         # 配置读写（深合并默认值，持久化到 userData 目录）
│   ├── deepseek.js       # DeepSeek 客户端（OpenAI 兼容，fetch + SSE 流式解析）
│   ├── ocr.js            # 本地 OCR（tesseract.js）
│   └── media.js          # 图片保存、录屏临时文件、webm → gif（ffmpeg）转码
│
├── preload/
│   └── preload.js        # 通过 contextBridge 暴露受控的 window.kkapi
│
├── renderer/             # 渲染层（纯 HTML/CSS/JS，file:// 加载，无 require/import）
│   ├── overlay/          # 截图选区层（框选 + 标注工具栏）
│   ├── pin/              # 贴图钉屏窗口
│   ├── longshot/         # 长截图窗口
│   ├── recorder/         # 录屏控制条
│   ├── ai/               # AI 面板（问图 / OCR / 翻译 / 润色）
│   └── settings/         # 设置页
│
└── shared/               # 主进程与 preload 共享
    ├── channels.js       # IPC 通道名常量
    └── config-schema.js  # 默认配置 DEFAULT_CONFIG
```

### 关键约定

- **渲染层禁止** `require` / `import` 任何 Node / Electron 模块，一切交互只能走 `window.kkapi`。
- DeepSeek 请求只在主进程 `deepseek.js` 中发起；渲染层通过 `kkapi.askImage` / `kkapi.chat` 触发，结果以 `streamId` 标记，经 `kkapi.onStream` 流式推送回对应窗口。
- 配置由 `config.js` 与 `shared/config-schema.js` 的默认值做深合并，保证升级后新增字段也有默认值；持久化在系统的 `userData` 目录（可从托盘菜单「打开配置文件目录」进入）。

### 配置结构（`kkapi.getConfig()` 返回）

```js
{
  shortcuts: { capture, pinClipboard, record, longShot, ocr }, // Electron accelerator 字符串
  deepseek:  { apiKey, baseUrl, visionModel, textModel,
               askImagePrompt, ocrPrompt, translatePrompt, polishPrompt },
  ocr:       { engine: 'local' | 'deepseek', lang: 'chi_sim+eng' },
  capture:   { copyAfterCapture, autoPin },
  recording: { fps, toGif },
  general:   { launchAtLogin, saveDir, theme: 'light' | 'dark' },
}
```

---

## 已知局限

- **长截图为基础版**：当前仅提供框选后的基础采集流程，自动滚动 / 智能拼接的完善程度有限，复杂页面可能需要手动配合。
- **录屏为基础版**：录制保存为 WebM；导出 GIF 依赖随包的 `ffmpeg-static`（缺失时退回系统 `ffmpeg`）。长时间 / 高帧率录制的 GIF 体积较大，转码也较慢。
- **OCR 首次需联网**：本地 `local` 引擎基于 tesseract.js，首次识别会从 CDN 下载对应语言包（默认 `chi_sim+eng`），需联网一次，之后会缓存离线可用。
- **AI 功能依赖网络与 Key**：问图 / 翻译 / 润色 / DeepSeek OCR 均需有效的 DeepSeek API Key 与网络连接。
- **权限平台差异**：macOS 需手动授予「屏幕录制」权限并重启应用；不同平台的全局快捷键可能与系统或其他软件冲突，可在设置页改键。

---

## 许可证

[MIT](https://opensource.org/licenses/MIT) © 困困
