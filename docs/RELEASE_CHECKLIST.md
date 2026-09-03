# 发布检查清单 / Release Checklist

这份清单刻意区分“自动化证据”和“真机人工验收”。只有命令在准备发布的提交上重新运行并留下结果，才能勾选；历史上曾经通过不算本次发布证据。

This checklist intentionally separates automated evidence from hands-on validation. Check an item only after rerunning it on the exact release commit and retaining the result; a historical pass is not release evidence.

## 状态约定 / Status convention

- `[ ]`：未验证、结果未知或需要重跑。/ Not verified, unknown, or requires a fresh run.
- `[x]`：已在待发布提交或产物上完成，并在发布记录中附有证据。/ Completed against the release commit or artifact, with evidence recorded in the release notes.
- 不允许以“代码看起来没问题”代替真机验收。/ Code inspection is not a substitute for hands-on acceptance.

> 仓库同时提供稳定本地签名、临时 ad-hoc 与正式发布流水线。本地证书签名只用于维持同一台 Mac 上的开发安装身份，不等于 Developer ID、Apple 公证或正式发布。当前没有 Apple 凭据、公证记录或经验证正式产物；流水线存在不得被视为已正式签名、已公证或已发布的证据。
>
> The repository provides stable local-signing, temporary ad-hoc, and formal-release pipelines. A local-certificate signature only preserves development-install identity on the same Mac; it is not Developer ID, Apple notarization, or a formal release. There are currently no Apple credentials, notarization records, or verified formal artifacts, and pipeline availability is not evidence that a formal release is signed, notarized, or published.

## v0.3.0 本机发布证据 / Local release evidence

2026-09-03 在 macOS arm64 与 Node.js 22.23.2 上完成以下验证；发布标签指向的提交需保持相同代码与依赖锁定，并在推送前再次执行源码门禁：

- 锁文件全新安装成功；完整依赖与生产依赖审计均为 0 漏洞。
- Node 测试 461/461；源码态 Electron 正常路径与故障注入路径通过；截图工具栏在默认及 933×701 非标准视口下通过，一级动作顺序为“翻译 → OCR”。
- 所有仓库 JavaScript 语法检查、直接依赖树和差异空白检查通过。
- 固定本机证书构建的 0.3.0 APP、DMG 与 ZIP 通过签名和完整性验证；应用包内含 9 个 OCR 数据包、KaTeX 脚本/字体/许可证与 3 个 arm64 原生助手。
- 打包态与安装态 Electron 正常/故障注入烟测通过；`/Applications/困困截图工具.app` 已从 0.2.2 更新到 0.3.0、保持相同 Designated Requirement 并真实启动。旧应用已移入项目内的时间戳备份，用户数据目录未改动。

证据边界：这些结果不替代下面仍未勾选的真实长页面、多显示器/Retina、摄像头/音频/TCC、真实 OCR/条码样本和异机测试，也不构成 Developer ID、公证或 FFmpeg 公开二进制分发合规证明。GitHub Release 只发布源码，不附加本地签名 DMG/ZIP。

## 1. 源码与自动化验证 / Source and automated verification

- [ ] 工作区干净，发布提交 SHA 已记录。/ Worktree is clean and the release commit SHA is recorded.
- [ ] 在全新目录使用 Node.js 22.12 或更高版本执行 `npm ci` 成功。/ `npm ci` succeeds in a clean directory with Node.js 22.12 or later.
- [ ] `npm run test:all` 全部通过，已记录 Node 测试数量、真实 Electron 冒烟结果与截图工具栏交互结果。/ `npm run test:all` passes; record the Node test count, real Electron smoke result, and capture-toolbar interaction result.
- [ ] 对仓库 JavaScript 执行 `node --check`，无语法错误。/ `node --check` passes for repository JavaScript files.
- [ ] `npm ls --depth=0` 无缺失或无效直接依赖。/ `npm ls --depth=0` reports no missing or invalid direct dependencies.
- [ ] `npm audit --omit=dev` 结果已审阅；任何例外均有风险说明。/ `npm audit --omit=dev` is reviewed and every exception is documented.
- [ ] 媒体回归覆盖 VP8 WebM → H.264 MP4、GIF 及失败清理。/ Media regressions cover VP8 WebM → H.264 MP4, GIF, and failure cleanup.
- [ ] 图片导出回归覆盖 PNG/JPEG/WebP/BMP/AVIF/PDF 的真实编码、扩展名/内容匹配、原子写入与失败清理。/ Image-export regressions cover real PNG/JPEG/WebP/BMP/AVIF/PDF encoding, extension/content agreement, atomic writes, and failure cleanup.
- [ ] 录屏回归覆盖默认无声、系统声音/麦克风独立开启、双源混音、权限拒绝、取消与资源清理。/ Recording regressions cover backward-compatible silent defaults, independent system/microphone opt-in, dual-source mixing, permission denial, cancellation, and resource cleanup.
- [ ] 精确选区回归覆盖源像素宽高输入、常用尺寸预设、自由/1:1/4:3/16:9 比例、边界钳制，以及非整数且 X/Y 非等比的屏幕到源图映射。/ Precise-selection regressions cover source-pixel dimensions, size presets, free/1:1/4:3/16:9 ratios, bounds clamping, and non-integer, non-uniform X/Y screen-to-source mapping.
- [ ] 截图工具栏契约确认一级动作第一位为“翻译”、第二位为“OCR”；背景解码未完成或失败时，复制/保存/贴图/OCR/AI 等输出动作被阻止并可明确重试。/ The overlay contract keeps Translate as the first primary action and OCR second; copy/save/pin/OCR/AI output remains blocked with a clear retry path until the background decodes successfully.
- [ ] 高级标注回归验证真实高斯模糊、椭圆聚光灯、文字水印与持久导出放大镜共享预览/导出坐标模型；交互手柄不得写入成片。/ Advanced-annotation regressions verify real Gaussian blur, elliptical spotlight, text watermark, and the persistent export magnifier share preview/export coordinates, while interaction handles never enter the artifact.
- [ ] 条码回归覆盖精确源裁区、受限首扫、原始全分辨率二次扫描、手动重试及持续状态；支持格式按当前 Chromium 能力取交集，不把缺失的真实码图 fixture 写成已验证。/ Barcode regressions cover exact source cropping, bounded first pass, original full-resolution retry, manual retry, and persistent status; formats are intersected with Chromium capabilities, and absent real-code fixtures are not claimed as verified.
- [ ] 9 个基础 OCR 语言包及其与英语组合的配置透传和本地路径均有回归；语言包缺失时明确失败，绝不会回退到 CDN 或网络下载。/ All nine base OCR languages and their English combinations have routing/local-path regressions; missing data causes an explicit failure and never falls back to a CDN or network download.
- [ ] AI 表格回归覆盖 GFM/CSV 解析、可编辑单元格、行列/字符上限、CSV/TSV/Markdown 复制，以及 CSV/TSV 公式注入防护。/ AI-table regressions cover GFM/CSV parsing, editable cells, row/column/character limits, CSV/TSV/Markdown copy, and spreadsheet-formula-injection protection for CSV/TSV.
- [ ] 配置密钥脱敏、加密不可用行为、私有文件权限、历史路径穿越、贴图文件能力边界均有回归测试。/ Regressions cover secret redaction, unavailable-encryption behavior, private file modes, history traversal, and pin-file capability boundaries.
- [ ] 贴图标注合成、标注后 OCR/AI/保存/复制/拖出，以及工作区原子持久化、内容哈希校验和恢复异常均有回归测试。/ Regressions cover pin-annotation composition, annotated OCR/AI/save/copy/drag-out, and atomic pin-workspace persistence, content-hash verification, and restore failures.
- [ ] 贴图回归覆盖裁剪、顺/逆时针 90°、水平/垂直翻转的像素结果与原子替换；分组联动移动、折叠/展开、移出/自动解散和组 ID 工作区恢复均通过。/ Pin regressions cover crop, clockwise/counterclockwise 90° rotation, horizontal/vertical flip pixels and atomic replacement; grouped movement, collapse/expand, remove/auto-dissolve, and workspace restoration of group IDs also pass.
- [ ] 本地 LaTeX 公式窗口回归覆盖 KaTeX 离线加载、严格 CSP、`trust:false`、输入/样式上限、自包含 PNG 生成和单例窗口路由；不允许 URL、fetch 或远程资源。/ Local LaTeX-window regressions cover offline KaTeX loading, strict CSP, `trust:false`, input/style limits, self-contained PNG generation, and singleton routing, with URLs, fetch, and remote resources forbidden.
- [ ] 长截图回归覆盖纵/横拼接、暂停/继续、首/中/尾帧删除、事务式重拼、撤销/重做、删段后继续、固定顶/底区域建议与应用，以及坏帧/反向/宽度或 DPR 变化不污染上一结果。/ Long-capture regressions cover vertical/horizontal stitching, pause/resume, first/middle/last-frame deletion, transactional restitch, undo/redo, continuation after deletion, fixed top/bottom suggestions/application, and preservation of the last good result across bad/reverse/width-or-DPR-changed frames.
- [ ] 文件名模板回归覆盖全部变量、默认截图/录屏模板、路径与非法字符拒绝、未知/不完整变量、长度上限和从 `-2` 开始的冲突避让。/ Filename-template regressions cover all tokens, screenshot/recording defaults, path and invalid-character rejection, unknown/incomplete tokens, length limits, and collision suffixes beginning at `-2`.
- [ ] 历史多页 PDF 回归覆盖选择顺序、真实分页、100 页/256 MiB 上限、视频/缺失项拒绝、原子写入和失败清理；单图 PDF 仍保持单页。/ History multi-page PDF regressions cover selection order, real pagination, 100-page/256-MiB limits, video/missing-item rejection, atomic writes, and failure cleanup; single-image PDF remains single-page.
- [ ] 录屏增强回归覆盖点击/快捷键隐私规则、辅助 helper 失败降级、摄像头授权/重试/断开清理、成片画笔，以及按真实媒体流像素进行独立 X/Y Retina/多屏映射。/ Recording-enhancement regressions cover click/shortcut privacy rules, helper-failure degradation, camera permission/retry/disconnect cleanup, baked-in pen strokes, and independent X/Y Retina/multi-display mapping based on actual media-stream pixels.
- [ ] 启动参数解析与单实例路由回归通过；未知、重复、越界参数均失败关闭。/ Launch-argument parsing and single-instance routing regressions pass; unknown, duplicate, and out-of-range values fail closed.
- [ ] 对当前树和完整 Git 历史执行秘密扫描，人工审阅疑似命中；输出不得泄露秘密。/ Scan the current tree and full Git history for secrets, manually review findings, and never print secret values.
- [ ] 检查仓库中没有本地配置、证书、签名身份、用户历史或未授权截图。/ Confirm no local configuration, certificates, signing identities, user history, or unauthorized captures are tracked.
- [ ] macOS 构建链路回归通过：`dist:mac:local` 要求稳定本地证书并关闭公证/Hardened Runtime，`dist:mac:adhoc` 明确隔离，`dist:mac:release` 对缺失或混用凭据失败关闭。/ macOS pipeline regressions pass: `dist:mac:local` requires a stable local certificate with notarization/Hardened Runtime off, `dist:mac:adhoc` remains explicitly isolated, and `dist:mac:release` fails closed for missing or mixed credentials.
- [ ] `npm run dist:mac:ci` 在无分发凭据条件下成功完成打包；包内 Electron 许可证、ATS 配置和 Swift helper 均已验证。/ `npm run dist:mac:ci` packages without distribution credentials; bundled Electron licenses, ATS configuration, and Swift helpers are verified.

## 2. 真机功能验收（macOS）/ Hands-on functional acceptance (macOS)

以下项目默认均为未验证，不能因自动测试通过而自动勾选。

All items below are manual and remain unverified until exercised on a real Mac; automated tests do not complete them.

- [ ] 在一个干净的 macOS 用户数据目录首次启动，主窗口与菜单栏入口正常。/ First launch works with a clean macOS user-data directory; main window and menu-bar entry are usable.
- [ ] 屏幕录制权限未授予时提示准确；授权并重启后恢复；用同一证书构建并安装本地更新后，指定要求仍锚定到相同证书且权限继续生效。/ Missing Screen Recording permission produces accurate guidance and works after permission plus restart; after installing a local update built with the same certificate, its designated requirement remains anchored to that certificate and permission still works.
- [ ] 单显示器与多显示器分别验证区域、窗口、全屏、3/5/10 秒及自定义延时截图。/ Verify region, window, full-screen, 3/5/10-second, and custom timed capture on single- and multi-display setups.
- [ ] 在 Retina 和多显示器上输入精确源像素宽高并切换尺寸预设、自由/1:1/4:3/16:9 比例；移动/缩放后确认屏幕选区与最终图片像素一致。/ On Retina and multi-display setups, enter exact source-pixel dimensions and switch presets and free/1:1/4:3/16:9 ratios; after move/resize, confirm the on-screen selection matches output pixels.
- [ ] 验证矩形、椭圆、箭头、直线、画笔、高亮、折线、文字、马赛克、序号、真实模糊、聚光灯、水印、导出放大镜、撤销与重做；回开导出图确认效果已写入且放大镜手柄未写入。/ Verify rectangle, ellipse, arrow, line, pen, highlight, polyline, text, mosaic, numbered marker, real blur, spotlight, watermark, export magnifier, undo, and redo; reopen exports to confirm effects are baked in and magnifier handles are absent.
- [ ] 验证复制、另存、快速保存与 PNG/JPEG/WebP/BMP/AVIF/PDF 导出；用 Preview/Finder 重新打开产物，确认扩展名与实际内容一致。/ Verify copy, Save As, quick save, and PNG/JPEG/WebP/BMP/AVIF/PDF export; reopen artifacts in Preview/Finder and confirm extensions match the actual content.
- [ ] 验证贴图置顶/锁定/穿透/缩略、拖出文件和恢复最近贴图。对图片贴图添加各类标注后，确认复制、保存、OCR、AI 和拖出获得的都是合成图。/ Verify pin on-top/lock/pass-through/thumbnail, drag-out, and restore-last-pin; after annotating an image pin, confirm copy, save, OCR, AI, and drag-out all use the composite.
- [ ] 对图片贴图执行矩形裁剪、顺/逆时针旋转和水平/垂直翻转；确认标注先被合并、像素/宽高/窗口边界正确、重启后结果保持，并确认用户能理解该变换不可撤销。/ Crop an image pin and rotate both directions and flip both axes; confirm annotations are merged first, pixels/dimensions/window bounds are correct, the result survives restart, and the destructive/no-undo behavior is clear.
- [ ] 将当前全部贴图分组，验证任一成员拖动时整组同位移、以当前贴图为锚点折叠/展开、移出成员和少于两张自动解散；重启后组 ID 恢复，而折叠状态不应被误写为持久化。/ Group all current pins and verify grouped movement, anchor-based collapse/expand, member removal, and auto-dissolve below two members; group IDs survive restart, while collapse state is not misrepresented as persistent.
- [ ] 从菜单栏托盘右键打开本地 LaTeX 公式窗口，断网输入代表性 KaTeX 公式，切换字号/文字色/透明或白底并生成 PNG 贴图；确认远程资源不可用、窗口保持单例且生成后按普通图片贴图处理。/ Open the local LaTeX window from the menu-bar tray context menu; offline, render representative KaTeX with font/color/transparent-or-white background, generate a PNG pin, and confirm remote resources are unavailable, the window is singleton, and output behaves as a normal image pin.
- [ ] 保留多张贴图正常退出并重启，验证内容、标注、窗口状态与当前边界恢复；损坏工作区文件不得被当作有效内容。/ Quit normally with multiple pins open, relaunch, and verify content, annotations, window state, and current bounds; corrupted workspace files must not be trusted.
- [ ] 验证图片、文字、颜色和 Finder 文件的剪贴板贴图顺序与行为。/ Verify clipboard pinning behavior and precedence for image, text, color, and Finder file content.
- [ ] 断网分别抽样简中、繁中、英、日、韩、法、德、西、葡及“对应语言+英语”组合；语言包缺失时明确失败，绝不会回退到 CDN 或其他网络下载。/ Offline, sample Simplified/Traditional Chinese, English, Japanese, Korean, French, German, Spanish, Portuguese, and each supported English combination; missing data causes an explicit failure and never falls back to a CDN or other network download.
- [ ] 用真实二维码及代表性的 Data Matrix、Code 128、EAN/UPC、PDF417 等码图验证识别/复制、首次无结果后的原始全分辨率重试和手动重试；记录该机器实际支持的制式。/ With real QR and representative Data Matrix, Code 128, EAN/UPC, PDF417 images, verify recognition/copy, original full-resolution retry after a miss, and manual retry; record formats actually supported on that machine.
- [ ] 长截图分别验证纵向普通文章和横向表格；暂停后删除首/中/尾帧、重拼、撤销/重做并继续，验证固定顶/底区域建议及手工像素应用。另用动态、重复/纯色、反向、宽度/DPR 变化样本确认失败明确且上一正确结果不受污染。/ Verify long capture on a vertical article and horizontal table; pause, delete first/middle/last frames, restitch, undo/redo, and continue, then test fixed top/bottom suggestions and manual pixels. Use dynamic, repetitive/solid, reverse, and width/DPR-change samples to confirm explicit failure preserves the last good output.
- [ ] 录屏分别导出 WebM、H.264 MP4 与 GIF；验证暂停/继续、取消、剪辑、保存失败重试与超限保护。/ Export WebM, H.264 MP4, and GIF; verify pause/resume, cancel, trim, save-failure retry, and size-limit protection.
- [ ] 在默认关闭、仅系统声音、仅麦克风和两者混音四种模式下分别录制；验证 macOS 权限拒绝/音源缺失时明确失败，不会静默丢失用户已选的音频。/ Record with audio off, system-only, microphone-only, and mixed audio; verify macOS permission denial or a missing source fails explicitly instead of silently dropping requested audio.
- [ ] 分别开启点击提示、快捷键提示、摄像头与成片画笔录制；确认普通未修饰文字不泄露、特殊键/组合键规则正确，helper 失败只关闭提示，摄像头拒绝可重试/断开可清理，笔迹可清除且各层真实写入成片。/ Record with click prompts, shortcut prompts, camera, and baked-in pen; confirm ordinary unmodified text is not exposed, named/special shortcut rules are correct, helper failure only disables prompts, camera denial is retryable/disconnect cleans up, pen strokes can be cleared, and every enabled layer is baked into output.
- [ ] 在 Retina 与多显示器不同缩放组合上验证录制裁区、点击/快捷键、摄像头、画笔和输出文件名尺寸均对齐真实媒体流像素。/ Across Retina and mixed-scale multi-display setups, verify crop, click/shortcut prompts, camera, pen, and filename dimensions all align with actual media-stream pixels.
- [ ] 历史记录的搜索、筛选、复制、导出、批量删除与清空正常；选择多张图片导出多页 PDF，用 Preview 核对顺序/页数，并确认视频、缺失项和超限输入被拒绝。/ Verify history search, filters, copy, export, bulk delete, and clear; export selected images as a multi-page PDF, confirm order/page count in Preview, and verify video, missing, and over-limit inputs are rejected.
- [ ] 分别配置截图/录屏文件名模板，验证所有变量、真实宽高、非法路径/字符拒绝和同名文件 `-2` 避让；确认单张截图 PDF 仍为单页。/ Configure screenshot and recording filename templates; verify all tokens, real dimensions, invalid path/character rejection, and `-2` collision handling, and confirm single-screenshot PDF remains one page.
- [ ] 全局快捷键可注册、可修改，冲突时有可理解反馈。/ Global shortcuts register and can be changed; conflicts have understandable feedback.
- [ ] 在应用未启动和已启动两种情况下，验证 `--capture=region|fullscreen|window|ocr|long|record`；验证区域/全屏 `--delay=1..300` 及非法参数反馈。/ With the app stopped and already running, verify `--capture=region|fullscreen|window|ocr|long|record`, region/full-screen `--delay=1..300`, and invalid-argument feedback.

## 3. AI、隐私与秘密 / AI, privacy, and secrets

- [ ] 用测试密钥分别验证已支持的文本路由、视觉路由、连接测试和模型列表；发布记录列出实际测试的提供商与模型。/ With test credentials, verify supported text routing, vision routing, connection tests, and model listing; record the providers/models actually tested.
- [ ] 验证仅在用户触发 AI 功能时发送数据，并用代理或服务端日志确认请求发往用户配置的 Base URL。/ Confirm that data is sent only after an AI action and, using a proxy or provider logs, that requests go to the configured Base URL.
- [ ] 验证文本任务发送哪些文字、视觉任务发送哪张图；隐私说明与实测一致。/ Confirm which text and image each route sends; privacy documentation matches observation.
- [ ] 分别验收 AI 表格识别的 Markdown/CSV 和公式识别的 LaTeX 输出；视觉提供方与“本地 OCR 后发文本”路由分别测试，不夸大纯文本路由对复杂表格的结构还原能力。/ Verify Markdown/CSV table and LaTeX formula output; test vision and local-OCR-then-text routes separately, without overstating complex table reconstruction from OCR text.
- [ ] 在 AI 表格结果中编辑首/中/末单元格，分别复制 CSV、TSV、Markdown 并粘贴到目标应用；验证危险公式前缀被防护，超行列/字符结果明确拒绝且不会卡死界面。/ Edit first/middle/last cells in an AI table, copy CSV, TSV, and Markdown into target apps, and verify dangerous formula prefixes are protected while row/column/character overflows fail explicitly without freezing the UI.
- [ ] 截图一级动作的第一位为“翻译”、第二位为“OCR”，且常用窗口宽度下无需进入“更多”即可触发翻译；逐一验证 8 种目标语言和含译文的复制/保存结果。/ Translate is the first primary screenshot action and OCR second, with translation usable without opening More at normal window widths; verify all eight targets and copied/saved images containing the translated layer.
- [ ] UI、IPC 返回、日志、崩溃信息、演示素材和 Git 历史均不泄露 API Key。/ UI, IPC responses, logs, crash output, demo media, and Git history do not expose API keys.
- [ ] 在系统加密可用时确认密钥密文落盘；不可用时确认新密钥不会以明文持久化。/ With system encryption available, confirm encrypted persistence; without it, confirm new secrets are not persisted in plaintext.

## 4. 演示与双语文档 / Demo and bilingual documentation

- [ ] `docs/assets/demo.gif` 来自当前待发布提交的真实应用操作，画面已脱敏，大小适合 GitHub。/ `docs/assets/demo.gif` is captured from the release commit, redacted, and reasonably sized for GitHub.
- [ ] README 中引用的每张截图都存在、可渲染且来自当前 UI；没有占位图或断链。/ Every README screenshot exists, renders, reflects the current UI, and is neither a placeholder nor a broken link.
- [ ] `README.md` 与 `README_EN.md` 顶部语言切换互链正常，核心状态、隐私和限制含义一致。/ Language links work and both READMEs communicate equivalent status, privacy, and limitations.
- [ ] `LICENSE`、`SECURITY.md`、`CONTRIBUTING.md` 与 `THIRD_PARTY_NOTICES.md` 已随源码发布。/ The source release includes all policy and license files.

## 5. 二进制与许可证 / Binary and licensing

- [ ] OCR 语言数据的准确来源、版本和许可证已确认并留档。/ Exact source, version, and license of OCR language data are documented.
- [ ] KaTeX 及其随包字体/许可证已盘点并保留在源码与最终产物的第三方声明中。/ KaTeX, bundled fonts, and their licenses are inventoried and retained in source and final-artifact third-party notices.
- [ ] 最终 DMG/ZIP 内实际包含的依赖和原生二进制已重新盘点。/ Re-inventory dependencies and native binaries inside the final DMG/ZIP.
- [ ] 含 `ffmpeg-static`/FFmpeg 的产物已满足适用的 GPL/FFmpeg 声明、许可证文本及源码提供义务。/ Artifacts containing `ffmpeg-static`/FFmpeg satisfy applicable GPL/FFmpeg notice, license-text, and source-offer obligations.
- [ ] Electron、Chromium、Node.js 及其他第三方许可证文件在产物中保留。/ Electron, Chromium, Node.js, and other required third-party notices are retained.
- [ ] 对 `.app`、DMG 和 ZIP 分别执行完整性检查；哈希写入发布说明。/ Check `.app`, DMG, and ZIP integrity and publish hashes.
- [ ] 对外正式产物使用 `codesign`、Gatekeeper 与 Apple 公证结果在另一台 Mac 上独立验证；不得用本地证书签名冒充 Developer ID 或公证证据。/ Independently verify public formal artifacts with `codesign`, Gatekeeper, Apple notarization results, and another Mac; never present a local-certificate signature as Developer ID or notarization evidence.
- [ ] 本地测试包通过 `npm run dist:mac:local` 生成，校验输出确认所有应用都锚定到预期固定证书且不含 Hardened Runtime；产物未被上传或标记为正式发布。/ Local test artifacts were built through `npm run dist:mac:local`; verification confirms every app is anchored to the expected fixed certificate and lacks Hardened Runtime; the artifacts were neither uploaded nor labeled as a formal release.
- [ ] `npm run dist:mac:adhoc` 只用于一次性隔离测试；其产物未覆盖日常安装版本、未作为安装更新交付，也未用于判断 TCC 权限能否延续。/ `npm run dist:mac:adhoc` was used only for a one-off isolated test; its artifacts did not replace the day-to-day install, deliver an update, or serve as evidence of TCC continuity.
- [ ] 正式产物使用 `npm run dist:mac:release` 在空的 `dist/release-mac` 目录生成；记录凭据方式名称，但不记录任何凭据值。/ Formal artifacts were produced by `npm run dist:mac:release` in an empty `dist/release-mac`; record credential method names, never credential values.
- [ ] 保留构建后校验输出：未打包/DMG/ZIP 内应用的 Developer ID、Hardened Runtime、Gatekeeper 和 stapled ticket 验证，以及 DMG/ZIP 完整性与 SHA-256。/ Retain post-build evidence for Developer ID, Hardened Runtime, Gatekeeper, and stapled-ticket checks on unpacked/DMG/ZIP apps, plus DMG/ZIP integrity and SHA-256.
- [ ] 从对外发布位置重新下载 DMG 和 ZIP，在另一台 Mac 上验证 Gatekeeper 首次打开和核心功能。/ Re-download the DMG and ZIP from the public release location and verify first launch through Gatekeeper and core functionality on another Mac.

## 6. GitHub 发布后核验 / Post-publication GitHub verification

- [ ] 仓库可匿名访问，默认分支指向预期发布提交。/ Repository is anonymously accessible and the default branch points to the intended release commit.
- [ ] 从 GitHub 匿名全新 clone 后可按 README 执行 `npm ci`、`npm run test:all` 与 `npm start`。/ From an anonymous fresh clone, the README setup flow works.
- [ ] CI 在公开仓库默认分支通过。/ CI passes on the public default branch.
- [ ] Release 页面、源码归档、演示素材和校验和可访问；没有把旧的未验证构建误标为当前版本。/ Release page, source archives, demo assets, and checksums are accessible; no stale unverified build is presented as current.
- [ ] GitHub Security 页面存在可用的私密报告入口；若不可用，`SECURITY.md` 的备用流程仍可执行。/ GitHub Security exposes a private reporting entry; otherwise the fallback in `SECURITY.md` remains actionable.
