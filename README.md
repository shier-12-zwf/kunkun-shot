# 困困截图工具

简体中文 | [English](README_EN.md)

一款以 macOS 为首要平台的开源 Electron 截图工具：区域截图与标注、贴图钉屏、OCR、二维码识别、实验性长截图、可选录制系统声音/麦克风的区域录屏，以及可选的 AI 问图、翻译、表格和公式识别。

> 当前源码版本：`v0.2.2`，仍为早期预览版。源码和自动测试可用不等于所有真机流程已经验收。项目不声称支持 Windows/Linux，也不声称公开构建已经完成 Apple 签名或公证。发布前的真实状态以 [发布检查清单](docs/RELEASE_CHECKLIST.md) 为准。

第一次使用请阅读 [完整使用指南](docs/使用指南.md)；想了解与 PixPin 的逐项差距、证据和后续优先级，请看 [竞品对比与改进报告](docs/PixPin-竞品对比与改进报告.md)。版本变化见 [更新日志](CHANGELOG.md)。

![困困截图工具操作演示](docs/assets/demo.gif)

> 演示素材由真实 Electron 渲染界面在隔离会话中生成；背景、历史记录和 AI 回复均为本地合成，不含真实用户数据，也不会发起网络请求。

| 主窗口 | 截图标注 | AI 工作台 |
| --- | --- | --- |
| ![主窗口](docs/assets/screenshot-main.png) | ![截图标注](docs/assets/screenshot-overlay.png) | ![AI 工作台](docs/assets/screenshot-ai.png) |

## 能做什么

- 区域、窗口、全屏和延时截图；区域截图支持选区调整与多显示器捕获。实验性长截图可从主窗口、菜单栏左键快捷面板、右键菜单或全局快捷键进入。
- 矩形、椭圆、箭头、直线、画笔、荧光笔、折线、文字、马赛克和序号等标注，并支持撤销/重做。
- 将图片、文字、颜色或 Finder 文件贴到屏幕；贴图支持置顶、锁定、鼠标穿透、缩略和恢复最近关闭项。图片贴图还可继续画笔/直线/箭头/图形/文字/橡皮标注，标注会用于复制、保存、OCR、AI 和拖出文件；正常退出时会保存并恢复打开的贴图工作区。
- 本地 OCR 默认使用 Tesseract.js 与仓库内的中英文语言数据；macOS 还包含基于系统 Vision 的文字框识别流程。
- 识别选区中的二维码并复制内容。
- 截图历史保存在 Electron 用户数据目录的 `history/`。自动入历史默认关闭，但成功执行“保存”或“快速保存”时仍会在历史库中另存一份；清空历史只删除历史库副本，不会删除用户另存到其他目录的文件。历史支持搜索、筛选、复制、导出和批量删除。
- 截图可导出 PNG、JPEG、WebP、BMP、AVIF 或单页 PDF，设置中可选默认格式与适用质量。
- 区域录屏可保存 WebM，或通过 FFmpeg 转换为 H.264 MP4/GIF。系统声音和麦克风可独立开启，两者同时开启时会混音；为了兼容旧配置它们默认都关闭。
- 截图编辑器把“翻译”“OCR”放在一级动作的最前面；问 AI、表格、公式、润色及目标语言设置集中在“更多”。AI 工作台支持 OCR 后问答、翻译、总结和润色，以及表格识别（Markdown/CSV）和公式识别（LaTeX）；视觉模型可直接接收用户选中的截图。
- 长截图已经提供基础流程，但仍属于实验性能力，复杂页面可能无法正确拼接。

## 快速开始

需要：

- macOS（当前主要开发与支持平台）
- Node.js 22.12 或更高版本
- npm
- 首次安装依赖时可访问 npm 与 `ffmpeg-static` 的二进制下载来源

```bash
git clone https://github.com/duangjaiignacy-blip/kunkun-shot.git
cd kunkun-shot
npm ci
npm run test:all
npm start
```

默认会打开主窗口，同时提供菜单栏入口。若全局快捷键已被系统或其他应用占用，请在设置页修改。

### macOS 屏幕与音频权限

截图、长截图和录屏需要 **系统设置 → 隐私与安全性 → 屏幕录制** 权限。开发模式可能显示为 Electron 或启动应用的终端。

1. 启动一次应用并触发截图。
2. 在系统设置中授予对应进程权限。
3. 完全退出 Electron/应用，再重新执行 `npm start`。

没有权限时可能只能捕获桌面壁纸、黑屏或空白画面。授权变化通常要重启进程才会生效。

录屏的系统声音与麦克风默认关闭，只有在设置中分别开启时才会请求 macOS 对应权限。如果用户明确要求的音频源不可用或被拒绝，录制会明确失败，不会静默产生无声视频。这两条音频链路仍必须在目标 macOS 版本和实际签名产物上手工验收。

## 默认快捷键（macOS）

| 功能 | 快捷键 |
| --- | --- |
| 区域截图 | `⌘ ⇧ A` |
| 截图并 OCR | `⌘ ⇧ O` |
| 长截图 | `⌘ ⇧ L` |
| 区域录屏 | `⌘ ⇧ R` |
| 贴出剪贴板内容 | `⌘ ⇧ P` |
| 恢复最近关闭的贴图 | `⌘ 3` |
| 划词翻译 | `⌘ ⇧ T` |

快捷键可在设置页修改。截图界面和贴图窗口中的单键操作也有独立配置。

## 启动参数（自动化）

开发模式和已打包应用都可通过启动参数进入同一套受控截图流程。开发模式示例：

```bash
npm start -- --capture=region
npm start -- --capture=fullscreen --delay=5
npm start -- --capture=window
npm start -- --capture=ocr
```

`--capture` 支持 `region`、`fullscreen`、`window`、`ocr`、`long` 和 `record`。`--delay=1..300` 只能与 `region` 或 `fullscreen` 组合，单实例应用的第二次启动也会处理这些参数。这不是无头导出 API：截图仍需要图形界面和相应的 macOS 权限。重复、未知或越界参数会直接报错，不会猜测执行。

## AI 与数据边界

AI 功能不是截图本身的必需条件。仅使用本地截图、标注、贴图和本地 OCR 时，不需要填写 API Key。

启用 AI 前请理解以下数据流：

- 文本任务会把提示词、用户输入或 OCR 得到的文字发送到当前配置的服务商 Base URL。
- 视觉任务会把用户主动选择的截图发送给支持图片输入的服务商。当前路由中，MiniMax 用于直接看图；纯文本提供商会先在本地 OCR，再发送识别出的文字。
- AI 表格/公式识别遵循同一边界：视觉路由发送用户选中的图，纯文本路由只发送本地 OCR 文本；后者可能无法可靠恢复复杂表格结构。
- “智能分流”采用固定路由：纯文本任务只发往 DeepSeek，看图任务只发往 MiniMax，必须同时配置两者。缺少本次任务对应的配置时请求会明确停止，不会利用其他服务商的残留 Key 改投端点。
- 测试连接和拉取模型列表也会向配置的服务端发起网络请求。
- 本地 OCR 只读取仓库/应用资源中的 `tessdata`，设置仅支持 `chi_sim+eng`、`chi_sim` 和 `eng`。所需语言数据缺失时会明确失败，绝不会从 CDN 或其他网络端点回退下载。
- API Key 仅在 Electron `safeStorage` 成功加密后才会落盘；系统安全存储不可用或加密失败时，保存会明确报错，绝不会以明文落盘或误报成功。

不要把含个人信息、商业秘密或第三方受限内容的截图发送给不受信任的模型服务。使用服务商即同时受其隐私政策、数据保留规则和计费条款约束。

## 项目结构

```text
src/
├── main/       Electron 主进程：捕获编排、配置、历史、OCR、媒体与 AI 请求
├── preload/    contextBridge 白名单 API
├── renderer/   无框架 HTML/CSS/JavaScript 界面
└── shared/     IPC 通道与默认配置
test/           Node 回归测试
tessdata/       本地 OCR 语言数据
docs/           产品说明与发布检查资料
```

渲染层不开启 Node 集成，只通过 preload 暴露的 `window.kkapi` 与主进程通信。项目没有前端打包步骤，Electron 直接加载本地 HTML/CSS/JavaScript。

## 开发与验证

```bash
npm run test:all
npm audit --audit-level=high
npm audit --omit=dev
npm ls --depth=0
```

用真实渲染层和隔离的本地演示数据重新生成上方素材：

```bash
env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron scripts/capture-demo.js
```

自动测试无法替代屏幕权限、多显示器、全局快捷键、OCR、录屏、贴图拖拽和 Apple 分发链路的真机验证。准备发布时请逐项执行 [docs/RELEASE_CHECKLIST.md](docs/RELEASE_CHECKLIST.md)，并把实际证据写入发布说明。

`npm run dist:mac:local`（`dist`、`dist:mac` 为兼容别名）默认使用本机配置的固定代码签名证书生成稳定本地包，并在构建后验证签名。该路径不公证、不启用 Hardened Runtime，目的是让同一台 Mac 上的开发安装在更新后继续匹配屏幕录制等 TCC 权限；它不是 Developer ID 分发签名，也不能作为 Gatekeeper 或正式发布证据。一次性隔离测试可用 `npm run dist:mac:adhoc`，但其 ad-hoc 身份不稳定，不能覆盖日常安装版本、不能用于安装更新，也不能保留 TCC 权限。只有 `npm run dist:mac:release` 是失败关闭的 Developer ID、Hardened Runtime 与 Apple 公证入口。首次配置、凭据和真机证据要求见 [本机构建签名指南](docs/MACOS_LOCAL_BUILD.md) 与 [macOS 发布指南](docs/MACOS_RELEASE.md)。仓库目前没有可用来证明已正式发布的 Apple 凭据、公证记录或经验证正式产物。

## 已知限制

- 当前仅把 macOS 作为支持与验收重点；代码中出现的通用 Electron API 不构成跨平台支持承诺。
- 长截图仍是实验性实现，复杂滚动容器、动态内容和固定元素可能导致拼接异常。
- GIF 转换会消耗较多时间和空间；高分辨率、长时间录屏尤其明显。
- 系统声音、麦克风、AVIF/PDF 在系统预览/Finder 中的兼容性，以及贴图工作区跨重启恢复，都需在目标 macOS 真机上验收。
- 全局快捷键可能与系统或其他应用冲突。
- OCR 精度取决于图像质量、语言数据和版面；AI 结果也可能错误。
- 当前没有应用内自动更新或已公证的公开安装包；GitHub Release 仅提供源码，本机开发安装需要手工更新。
- 尚未完成的自动或真机验证项目以发布检查清单中的未勾选项为准。

## 参与和安全

- 贡献流程：[CONTRIBUTING.md](CONTRIBUTING.md)
- 安全漏洞报告：[SECURITY.md](SECURITY.md)
- 发布检查：[docs/RELEASE_CHECKLIST.md](docs/RELEASE_CHECKLIST.md)

请勿在公开 Issue、日志或演示截图中粘贴 API Key、访问令牌或未脱敏的个人数据。

## 许可证

仓库原创源码使用 [MIT License](LICENSE)，版权所有 © 2026 Kunkun / 困困。

运行时还包含不同许可证的第三方组件。尤其是 `ffmpeg-static` 当前解析为 GPL-3.0-or-later，并安装平台对应的 FFmpeg 二进制。MIT 许可证不会覆盖或取代这些条款；分发源码或二进制前请阅读 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) 并履行最终产物适用的许可证义务。
