# 发布检查清单 / Release Checklist

这份清单刻意区分“自动化证据”和“真机人工验收”。只有命令在准备发布的提交上重新运行并留下结果，才能勾选；历史上曾经通过不算本次发布证据。

This checklist intentionally separates automated evidence from hands-on validation. Check an item only after rerunning it on the exact release commit and retaining the result; a historical pass is not release evidence.

## 状态约定 / Status convention

- `[ ]`：未验证、结果未知或需要重跑。/ Not verified, unknown, or requires a fresh run.
- `[x]`：已在待发布提交或产物上完成，并在发布记录中附有证据。/ Completed against the release commit or artifact, with evidence recorded in the release notes.
- 不允许以“代码看起来没问题”代替真机验收。/ Code inspection is not a substitute for hands-on acceptance.

> 截至本次源码盘点，仓库只提供正式签名/公证流水线与自动校验，没有 Apple 凭据、公证记录或经验证正式产物。流水线存在不得被视为已签名、已公证或已发布的证据。
>
> As of this source audit, the repository provides a formal signing/notarization pipeline and automated verification only; it contains no Apple credentials, notarization record, or verified formal artifact. Pipeline availability is not evidence that a release is signed, notarized, or published.

## 1. 源码与自动化验证 / Source and automated verification

- [ ] 工作区干净，发布提交 SHA 已记录。/ Worktree is clean and the release commit SHA is recorded.
- [ ] 在全新目录使用 Node.js 22.12 或更高版本执行 `npm ci` 成功。/ `npm ci` succeeds in a clean directory with Node.js 22.12 or later.
- [ ] `npm test` 全部通过，测试数量和输出已记录。/ `npm test` passes; test count and output are recorded.
- [ ] 对仓库 JavaScript 执行 `node --check`，无语法错误。/ `node --check` passes for repository JavaScript files.
- [ ] `npm ls --depth=0` 无缺失或无效直接依赖。/ `npm ls --depth=0` reports no missing or invalid direct dependencies.
- [ ] `npm audit --omit=dev` 结果已审阅；任何例外均有风险说明。/ `npm audit --omit=dev` is reviewed and every exception is documented.
- [ ] 媒体回归覆盖 VP8 WebM → H.264 MP4、GIF 及失败清理。/ Media regressions cover VP8 WebM → H.264 MP4, GIF, and failure cleanup.
- [ ] 图片导出回归覆盖 PNG/JPEG/WebP/BMP/AVIF/PDF 的真实编码、扩展名/内容匹配、原子写入与失败清理。/ Image-export regressions cover real PNG/JPEG/WebP/BMP/AVIF/PDF encoding, extension/content agreement, atomic writes, and failure cleanup.
- [ ] 录屏回归覆盖默认无声、系统声音/麦克风独立开启、双源混音、权限拒绝、取消与资源清理。/ Recording regressions cover backward-compatible silent defaults, independent system/microphone opt-in, dual-source mixing, permission denial, cancellation, and resource cleanup.
- [ ] 配置密钥脱敏、加密不可用行为、私有文件权限、历史路径穿越、贴图文件能力边界均有回归测试。/ Regressions cover secret redaction, unavailable-encryption behavior, private file modes, history traversal, and pin-file capability boundaries.
- [ ] 贴图标注合成、标注后 OCR/AI/保存/复制/拖出，以及工作区原子持久化、内容哈希校验和恢复异常均有回归测试。/ Regressions cover pin-annotation composition, annotated OCR/AI/save/copy/drag-out, and atomic pin-workspace persistence, content-hash verification, and restore failures.
- [ ] 启动参数解析与单实例路由回归通过；未知、重复、越界参数均失败关闭。/ Launch-argument parsing and single-instance routing regressions pass; unknown, duplicate, and out-of-range values fail closed.
- [ ] 对当前树和完整 Git 历史执行秘密扫描，人工审阅疑似命中；输出不得泄露秘密。/ Scan the current tree and full Git history for secrets, manually review findings, and never print secret values.
- [ ] 检查仓库中没有本地配置、证书、签名身份、用户历史或未授权截图。/ Confirm no local configuration, certificates, signing identities, user history, or unauthorized captures are tracked.
- [ ] macOS 发布链路回归测试通过：本地构建明确禁用签名/公证，正式构建对缺失或混用凭据失败关闭。/ macOS release-pipeline regressions pass: local builds explicitly disable signing/notarization, and formal builds fail closed for missing or mixed credentials.

## 2. 真机功能验收（macOS）/ Hands-on functional acceptance (macOS)

以下项目默认均为未验证，不能因自动测试通过而自动勾选。

All items below are manual and remain unverified until exercised on a real Mac; automated tests do not complete them.

- [ ] 在一个干净的 macOS 用户数据目录首次启动，主窗口与菜单栏入口正常。/ First launch works with a clean macOS user-data directory; main window and menu-bar entry are usable.
- [ ] 屏幕录制权限未授予时提示准确；授权并重启后恢复。/ Missing Screen Recording permission produces accurate guidance and works after permission plus restart.
- [ ] 单显示器与多显示器分别验证区域、窗口、全屏、3/5/10 秒及自定义延时截图。/ Verify region, window, full-screen, 3/5/10-second, and custom timed capture on single- and multi-display setups.
- [ ] 验证矩形、椭圆、箭头、直线、画笔、高亮、折线、文字、马赛克、序号、撤销与重做。/ Verify rectangle, ellipse, arrow, line, pen, highlight, polyline, text, mosaic, numbered marker, undo, and redo.
- [ ] 验证复制、另存、快速保存与 PNG/JPEG/WebP/BMP/AVIF/PDF 导出；用 Preview/Finder 重新打开产物，确认扩展名与实际内容一致。/ Verify copy, Save As, quick save, and PNG/JPEG/WebP/BMP/AVIF/PDF export; reopen artifacts in Preview/Finder and confirm extensions match the actual content.
- [ ] 验证贴图置顶/锁定/穿透/缩略、拖出文件和恢复最近贴图。对图片贴图添加各类标注后，确认复制、保存、OCR、AI 和拖出获得的都是合成图。/ Verify pin on-top/lock/pass-through/thumbnail, drag-out, and restore-last-pin; after annotating an image pin, confirm copy, save, OCR, AI, and drag-out all use the composite.
- [ ] 保留多张贴图正常退出并重启，验证内容、标注、窗口状态与当前边界恢复；损坏工作区文件不得被当作有效内容。/ Quit normally with multiple pins open, relaunch, and verify content, annotations, window state, and current bounds; corrupted workspace files must not be trusted.
- [ ] 验证图片、文字、颜色和 Finder 文件的剪贴板贴图顺序与行为。/ Verify clipboard pinning behavior and precedence for image, text, color, and Finder file content.
- [ ] 本地 OCR 在断网且内置中英文语言包可用时完成识别；语言包缺失时明确失败，绝不会回退到 CDN 或其他网络下载。/ Local OCR works offline with bundled Chinese/English data; missing data causes an explicit failure and never falls back to a CDN or other network download.
- [ ] 二维码检测与复制结果正常。/ QR detection and result copying work.
- [ ] 长截图在至少一个普通滚动页面验证，并明确记录实验性限制。/ Exercise long capture on at least one normal scrolling page and document its experimental limitations.
- [ ] 录屏分别导出 WebM、H.264 MP4 与 GIF；验证暂停/继续、取消、剪辑、保存失败重试与超限保护。/ Export WebM, H.264 MP4, and GIF; verify pause/resume, cancel, trim, save-failure retry, and size-limit protection.
- [ ] 在默认关闭、仅系统声音、仅麦克风和两者混音四种模式下分别录制；验证 macOS 权限拒绝/音源缺失时明确失败，不会静默丢失用户已选的音频。/ Record with audio off, system-only, microphone-only, and mixed audio; verify macOS permission denial or a missing source fails explicitly instead of silently dropping requested audio.
- [ ] 历史记录的搜索、筛选、复制、导出、批量删除与清空正常。/ Verify history search, filters, copy, export, bulk delete, and clear.
- [ ] 全局快捷键可注册、可修改，冲突时有可理解反馈。/ Global shortcuts register and can be changed; conflicts have understandable feedback.
- [ ] 在应用未启动和已启动两种情况下，验证 `--capture=region|fullscreen|window|ocr|long|record`；验证区域/全屏 `--delay=1..300` 及非法参数反馈。/ With the app stopped and already running, verify `--capture=region|fullscreen|window|ocr|long|record`, region/full-screen `--delay=1..300`, and invalid-argument feedback.

## 3. AI、隐私与秘密 / AI, privacy, and secrets

- [ ] 用测试密钥分别验证已支持的文本路由、视觉路由、连接测试和模型列表；发布记录列出实际测试的提供商与模型。/ With test credentials, verify supported text routing, vision routing, connection tests, and model listing; record the providers/models actually tested.
- [ ] 验证仅在用户触发 AI 功能时发送数据，并用代理或服务端日志确认请求发往用户配置的 Base URL。/ Confirm that data is sent only after an AI action and, using a proxy or provider logs, that requests go to the configured Base URL.
- [ ] 验证文本任务发送哪些文字、视觉任务发送哪张图；隐私说明与实测一致。/ Confirm which text and image each route sends; privacy documentation matches observation.
- [ ] 分别验收 AI 表格识别的 Markdown/CSV 和公式识别的 LaTeX 输出；视觉提供方与“本地 OCR 后发文本”路由分别测试，不夸大纯文本路由对复杂表格的结构还原能力。/ Verify Markdown/CSV table and LaTeX formula output; test vision and local-OCR-then-text routes separately, without overstating complex table reconstruction from OCR text.
- [ ] UI、IPC 返回、日志、崩溃信息、演示素材和 Git 历史均不泄露 API Key。/ UI, IPC responses, logs, crash output, demo media, and Git history do not expose API keys.
- [ ] 在系统加密可用时确认密钥密文落盘；不可用时确认新密钥不会以明文持久化。/ With system encryption available, confirm encrypted persistence; without it, confirm new secrets are not persisted in plaintext.

## 4. 演示与双语文档 / Demo and bilingual documentation

- [ ] `docs/assets/demo.gif` 来自当前待发布提交的真实应用操作，画面已脱敏，大小适合 GitHub。/ `docs/assets/demo.gif` is captured from the release commit, redacted, and reasonably sized for GitHub.
- [ ] README 中引用的每张截图都存在、可渲染且来自当前 UI；没有占位图或断链。/ Every README screenshot exists, renders, reflects the current UI, and is neither a placeholder nor a broken link.
- [ ] `README.md` 与 `README_EN.md` 顶部语言切换互链正常，核心状态、隐私和限制含义一致。/ Language links work and both READMEs communicate equivalent status, privacy, and limitations.
- [ ] `LICENSE`、`SECURITY.md`、`CONTRIBUTING.md` 与 `THIRD_PARTY_NOTICES.md` 已随源码发布。/ The source release includes all policy and license files.

## 5. 二进制与许可证 / Binary and licensing

- [ ] OCR 语言数据的准确来源、版本和许可证已确认并留档。/ Exact source, version, and license of OCR language data are documented.
- [ ] 最终 DMG/ZIP 内实际包含的依赖和原生二进制已重新盘点。/ Re-inventory dependencies and native binaries inside the final DMG/ZIP.
- [ ] 含 `ffmpeg-static`/FFmpeg 的产物已满足适用的 GPL/FFmpeg 声明、许可证文本及源码提供义务。/ Artifacts containing `ffmpeg-static`/FFmpeg satisfy applicable GPL/FFmpeg notice, license-text, and source-offer obligations.
- [ ] Electron、Chromium、Node.js 及其他第三方许可证文件在产物中保留。/ Electron, Chromium, Node.js, and other required third-party notices are retained.
- [ ] 对 `.app`、DMG 和 ZIP 分别执行完整性检查；哈希写入发布说明。/ Check `.app`, DMG, and ZIP integrity and publish hashes.
- [ ] 若声称签名或公证，使用 `codesign`、Gatekeeper 与 Apple 公证结果在另一台 Mac 上独立验证；否则发布页显著写明“未签名/未公证”。/ If signing or notarization is claimed, independently verify with `codesign`, Gatekeeper, Apple notarization results, and another Mac; otherwise prominently label the release unsigned/not notarized.
- [ ] 本地测试包只通过 `npm run dist:mac:local` 生成，且未被上传或标记为正式发布。/ Local test artifacts were built only through `npm run dist:mac:local` and were neither uploaded nor labeled as a formal release.
- [ ] 正式产物使用 `npm run dist:mac:release` 在空的 `dist/release-mac` 目录生成；记录凭据方式名称，但不记录任何凭据值。/ Formal artifacts were produced by `npm run dist:mac:release` in an empty `dist/release-mac`; record credential method names, never credential values.
- [ ] 保留构建后校验输出：未打包/DMG/ZIP 内应用的 Developer ID、Hardened Runtime、Gatekeeper 和 stapled ticket 验证，以及 DMG/ZIP 完整性与 SHA-256。/ Retain post-build evidence for Developer ID, Hardened Runtime, Gatekeeper, and stapled-ticket checks on unpacked/DMG/ZIP apps, plus DMG/ZIP integrity and SHA-256.
- [ ] 从对外发布位置重新下载 DMG 和 ZIP，在另一台 Mac 上验证 Gatekeeper 首次打开和核心功能。/ Re-download the DMG and ZIP from the public release location and verify first launch through Gatekeeper and core functionality on another Mac.

## 6. GitHub 发布后核验 / Post-publication GitHub verification

- [ ] 仓库可匿名访问，默认分支指向预期发布提交。/ Repository is anonymously accessible and the default branch points to the intended release commit.
- [ ] 从 GitHub 匿名全新 clone 后可按 README 执行 `npm ci`、`npm test` 与 `npm start`。/ From an anonymous fresh clone, the README setup flow works.
- [ ] CI 在公开仓库默认分支通过。/ CI passes on the public default branch.
- [ ] Release 页面、源码归档、演示素材和校验和可访问；没有把旧的未验证构建误标为当前版本。/ Release page, source archives, demo assets, and checksums are accessible; no stale unverified build is presented as current.
- [ ] GitHub Security 页面存在可用的私密报告入口；若不可用，`SECURITY.md` 的备用流程仍可执行。/ GitHub Security exposes a private reporting entry; otherwise the fallback in `SECURITY.md` remains actionable.
