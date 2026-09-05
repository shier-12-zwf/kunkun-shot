# Kunkun Shot

[简体中文](README.md) | English

An open-source, macOS-first Electron screenshot utility with precision capture and annotation, pinned reference windows, multilingual offline OCR, QR/barcode recognition, editable scrolling capture, region recording with camera/action overlays, and optional AI-assisted image Q&A, translation, table recognition, and formula recognition.

> Status: early preview, v0.3.4. Available source code and automated tests do not imply that every hands-on flow has passed acceptance. Application binaries must be rebuilt from the release source and pass negative-content scans before upload. Once those gates pass, the GitHub Release attaches exactly one informed-testing DMG in addition to GitHub's generated source archives, and no application ZIP. The outer DMG is not separately code-signed; its contained `.app` uses the fixed local development certificate, not Apple Developer ID, and is neither notarized nor stapled. The project does not claim Windows/Linux support. See the [release checklist](docs/RELEASE_CHECKLIST.md) for its evidence and risk boundaries.

> Current source version: `v0.3.4`.

Start with the [complete Chinese user guide](docs/使用指南.md). The [PixPin comparison and improvement report](docs/PixPin-竞品对比与改进报告.md) documents the evidence, current gaps, and priorities. v0.3.4 introduces visual scrolling capture; see the workflow below and section 12 of the user guide, plus the [v0.3.4 release notes](docs/release-notes-v0.3.4.md) for verification records and the installer checksum. The earlier pin-visibility hotfix remains documented in the [v0.3.3 release notes](docs/release-notes-v0.3.3.md); see the [changelog](CHANGELOG.md) for version history.

![Kunkun Shot demo](docs/assets/demo.gif)

> These assets come from the real Electron renderer running in an isolated session. The background, history items, and AI response are synthesized locally; no personal data or network request is used.

| Main window | Capture and annotation | AI workspace |
| --- | --- | --- |
| ![Main window](docs/assets/screenshot-main.png) | ![Capture overlay](docs/assets/screenshot-overlay.png) | ![AI workspace](docs/assets/screenshot-ai.png) |

## Capabilities

- Region, window, full-screen, and timed capture. Regions support exact source-pixel width/height, common size presets, free/1:1/4:3/16:9 ratios, keyboard adjustment, and independent X/Y mapping for scaled displays.
- Rectangle, ellipse, arrow, line, pen, highlighter, polyline, text, mosaic, numbered marker, real blur, elliptical spotlight, text watermark, and exportable magnifier annotations with undo/redo.
- Translation is the first top-level capture action, with its target-language selector immediately beside it instead of under More, followed by OCR. Pin, Copy, and Cancel also remain top-level; lower-frequency actions live under More.
- Pin images, text, colors, or Finder files to the desktop. Image pins support annotation, crop, 90-degree rotation, horizontal/vertical flip, and composite copy/save/OCR/AI/drag-out. The decoded image element itself is committed to the visible window, and the latest payload is injected again after a renderer reload to reduce intermittent blank pins. Multiple pins can be grouped for movement, collapsed/expanded, and ungrouped. A local KaTeX window creates LaTeX formula pins without a network request. Open pins are restored as a local workspace after a normal quit.
- Offline OCR with bundled Simplified Chinese, Traditional Chinese, English, Japanese, Korean, French, German, Spanish, and Portuguese data, plus preset language-plus-English combinations. macOS Vision provides a separate local text-box path.
- Persistent QR/common-barcode results, with a manual full-resolution rescan when the initial scan fails.
- Screenshot history is stored under `history/` in Electron's user-data directory. Automatic history capture is off by default, but a successful Save or Quick Save still stores another copy in history. Clearing history removes only those history copies, not files saved elsewhere by the user. History supports search, filters, copy, export, and bulk deletion.
- Screenshot export to PNG, JPEG, WebP, BMP, AVIF, or single-page PDF. PNG, JPEG, and PDF do not need external FFmpeg; WebP, BMP, and AVIF require a separately installed system FFmpeg build with the applicable encoder. Separate screenshot/recording filename templates support date, time, timestamp, type, index, width, and height variables. History can merge up to 100 selected images into one ordered multi-page PDF.
- Region recording defaults to untrimmed WebM without external FFmpeg. GIF, H.264 MP4, and recording trim require a separately installed system FFmpeg build with the necessary encoders and filters. Without FFmpeg, a GIF request automatically falls back to WebM, while a trim request asks the user to save the full untrimmed WebM or cancel. System audio and microphone are independent opt-ins. Camera picture-in-picture, click/special-key or modifier-shortcut prompts, and encoded pen strokes can be written into the output. Cropping and overlays use the desktop stream's actual pixel dimensions for Retina/multi-display mapping.
- An AI workspace for OCR-assisted Q&A, translation, summarization, and rewriting. Recognized tables are editable cell by cell and can be copied as CSV, TSV, or GFM Markdown with spreadsheet-formula-injection protection. Formula recognition returns LaTeX; a configured vision model can receive the selected image directly.
- Scrolling capture automatically captures the first frame after region selection, keeps a transparent, click-through selection outline visible, and previews the stitched result outside the selection while you scroll the original page. Vertical and horizontal modes support pause/continue, raw-frame deletion and restitching, undo/redo, suggested or manually configured fixed top/bottom regions, and output cropping. Failed recomposition rolls back to the last exportable result, and unreachable raw frames are released under the memory budget. It remains experimental and requires manual review on dynamic or complex pages.

### v0.3.4: visual scrolling capture

Select the content region → the first frame is captured automatically, without clicking Start → scroll down in the original page → watch the live thumbnail outside the selection → click Done, choose a save location, and have the result copied after saving succeeds. The app captures and stitches automatically; it does not scroll the page for you. Canceling or failing to save keeps the session available for retry.

The compact toolbar shows only direction, Pause/Continue, Adjust, Done, and Cancel. Clicking Adjust pauses capture and expands frame editing, fixed top/bottom controls, and output cropping. Clicking Continue collapses the adjustment panel and resumes capture. Vertical is the default; switch to horizontal while only the first frame is retained, before new content has been stitched. Direction is locked once two frames are retained.

The selection outline and preview let mouse scrolling reach the original page, and the toolbar does not actively take focus when first shown. If there is not enough room outside the selection, the preview is hidden with an explanatory message; the app does not shrink or move your selection. The toolbar stays within the active display and is temporarily hidden during capture if it overlaps the selection. Prefer the Done and Cancel buttons: `Enter` / `Escape` work only while the toolbar has focus, not as global shortcuts. Automated checks do not replace hands-on mouse-wheel, multi-display, and complex-page acceptance on the target Mac.

## Quick start

Requirements:

- macOS (the current development and support focus)
- Node.js 22.12 or later
- npm
- Network access to npm during initial dependency installation
- Optional: install system FFmpeg separately for WebP/BMP/AVIF, GIF, H.264 MP4, or recording trim, and confirm that build includes the encoders/filters required by the target format; neither the app nor its installer bundles `ffmpeg-static` or a standalone FFmpeg CLI

```bash
git clone https://github.com/shier-12-zwf/kunkun-shot.git
cd kunkun-shot
npm ci
npm run test:all
npm start
```

The main window opens by default and a menu-bar entry is also available. If a global shortcut is already owned by macOS or another app, change it in Settings.

### macOS screen and audio permissions

Capture, scrolling capture, and recording require **System Settings → Privacy & Security → Screen Recording**. A development run may appear as Electron or as the terminal that launched it.

1. Start the app and trigger a capture once.
2. Grant access to the relevant process in System Settings.
3. Fully quit Electron/the app, then run `npm start` again.

Without access, the app may capture only wallpaper, a black frame, or an empty image. Permission changes usually take effect only after a process restart.

System audio and microphone recording are off by default. The app asks for the corresponding macOS permission only after each source is enabled in Settings. If an explicitly requested source is denied or unavailable, recording fails clearly instead of silently producing a video without that audio. Both audio paths still require hands-on acceptance on the target macOS version and the actual signed artifact.

## Default shortcuts (macOS)

| Action | Shortcut |
| --- | --- |
| Region capture | `⌘ ⇧ A` |
| Capture and OCR | `⌘ ⇧ O` |
| Scrolling capture | `⌘ ⇧ L` |
| Region recording | `⌘ ⇧ R` |
| Pin clipboard content | `⌘ ⇧ P` |
| Restore the most recently closed pin | `⌘ 3` |
| Translate selected text | `⌘ ⇧ T` |

Global shortcuts are configurable. Single-key actions inside capture and pin windows have a separate settings group.

## Launch arguments (automation)

Development runs and packaged applications can enter the same controlled capture workflows through launch arguments. Development examples:

```bash
npm start -- --capture=region
npm start -- --capture=fullscreen --delay=5
npm start -- --capture=window
npm start -- --capture=ocr
```

`--capture` accepts `region`, `fullscreen`, `window`, `ocr`, `long`, or `record`. `--delay=1..300` can be combined only with `region` or `fullscreen`; a second launch of the single-instance app processes the arguments too. This is not a headless export API: capture still uses the graphical interface and requires the relevant macOS permissions. Duplicate, unknown, or out-of-range arguments fail explicitly.

## AI and data boundaries

AI is optional. Local capture, annotation, pinning, and local OCR do not require an API key.

Understand the data flow before enabling AI:

- Text tasks send prompts, user input, or locally recognized OCR text to the currently configured provider Base URL.
- Vision tasks send the screenshot explicitly selected by the user to a provider that accepts image input. In the current routing, MiniMax handles direct image input; text-only providers receive locally recognized text instead of the image.
- AI table/formula recognition follows the same boundary: the vision route sends the selected image, while a text-only route sends only local OCR text and may be unable to reconstruct a complex table reliably.
- “Auto” uses a fixed route: text-only tasks go only to DeepSeek and vision tasks go only to MiniMax, so both must be configured. If the provider required for a task is incomplete, the request stops with an explicit error and never switches to another provider using residual credentials.
- Connection tests and model-list requests also contact the configured endpoint.
- Local OCR reads only the repository/application `tessdata` resources. Settings support `chi_sim`, `chi_tra`, `eng`, `jpn`, `kor`, `fra`, `deu`, `spa`, `por`, and the bundled language-plus-English presets. If required language data is missing, OCR fails explicitly and never falls back to a CDN or any other network download.
- API keys are persisted only after Electron `safeStorage` encrypts them successfully. If secure storage is unavailable or encryption fails, saving reports an explicit error—keys are never written as plaintext or falsely reported as saved.

Do not send screenshots containing personal data, trade secrets, or restricted third-party content to an untrusted model provider. Provider privacy, retention, and billing terms apply independently.

## Repository layout

```text
src/
├── main/       Electron main process: capture, config, history, OCR, media, and AI requests
├── preload/    contextBridge allowlisted API
├── renderer/   Framework-free HTML/CSS/JavaScript UI
└── shared/     IPC channels and default configuration
test/           Node regression tests
tessdata/       Local OCR language data
docs/           Product and release documentation
```

The renderer has no Node integration and communicates with the main process only through the `window.kkapi` preload bridge. There is no front-end bundling stage; Electron loads local HTML/CSS/JavaScript directly.

## Development and verification

```bash
npm run test:all
npm audit --audit-level=high
npm audit --omit=dev
npm ls --depth=0
```

Regenerate the assets above with the real renderer and isolated local demo data:

```bash
env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron scripts/capture-demo.js
```

Automated tests cannot replace hands-on checks for screen permission, multiple displays, global shortcuts, OCR, recording, pin drag-and-drop, or Apple's distribution pipeline. Before publishing, complete [docs/RELEASE_CHECKLIST.md](docs/RELEASE_CHECKLIST.md) and attach actual evidence to the release notes.

`npm run dist:mac:local` (`dist` and `dist:mac` remain compatibility aliases) uses a configured, fixed local code-signing certificate by default and verifies the resulting local artifacts. This path is not notarized, has no stapled ticket, and is not built with Hardened Runtime; its purpose is to keep development installs on the same Mac matched to Screen Recording and other TCC permissions across updates. It is not a Developer ID distribution signature and is not evidence of Gatekeeper acceptance or a formal release. The sole application-binary attachment planned for v0.3.4 is a DMG freshly built by that pipeline from the final commit after its negative-content scans pass: the outer DMG will not be separately code-signed, while its contained `.app` will use the fixed local development certificate. It is explicitly an informed-testing/preview package; no application ZIP will be uploaded, and download availability must not be presented as Gatekeeper or cross-Mac validation. Do not reuse a stale build; verify that the new artifact's `app.asar`, `app.asar.unpacked`, and mounted DMG contain neither `ffmpeg-static` nor a standalone FFmpeg CLI. `npm run dist:mac:adhoc` is available for one-off isolated tests, but its ad-hoc identity is unstable: never use it to replace the day-to-day install, deliver an update, or preserve TCC permissions. Only `npm run dist:mac:release` is the fail-closed Developer ID, Hardened Runtime, and Apple notarization path. See the [local signing guide](docs/MACOS_LOCAL_BUILD.md) and [macOS release guide](docs/MACOS_RELEASE.md) for setup, credentials, procedure, and hands-on evidence requirements. The repository currently contains no Apple credentials, notarization record, or artifact evidence proving a formal Apple distribution.

## Known limitations

- macOS is the only current support and acceptance focus. Generic Electron APIs in the source are not a cross-platform support commitment.
- Automatic frame capture does not mean automatic scrolling: scrolling capture still requires you to scroll manually and remains experimental. Animation, live updates, reverse scrolling, and complex nested containers can prevent reliable stitching; fixed top/bottom assistance still requires human confirmation. If there is not enough space outside the selection, the thumbnail is hidden without changing the selected region.
- Optional conversions depend on the user's particular FFmpeg build; merely finding an `ffmpeg` executable does not prove that it has the WebP/AVIF/H.264/GIF encoders or filters required by a requested format. GIF conversion can be slow and storage-intensive, especially for long, high-resolution recordings.
- System audio, microphone and camera hot-plug behavior, mixed-DPI multi-display mapping, AVIF/PDF behavior in Preview/Finder, and cross-restart pin-workspace restoration still require acceptance on target macOS hardware.
- The recording pen is encoded into the resulting video but is not shown as a separate live desktop overlay. A camera disconnected during recording does not stop the screen recording, but it cannot hot-reconnect within that same recording.
- Global shortcuts may conflict with macOS or other applications.
- OCR accuracy depends on image quality, language data, and layout. AI output can also be wrong.
- There is no in-app auto-update or notarized public installer. v0.3.4 will attach one informed-testing DMG only after a clean rebuild passes the release checklist; its outer container will not be separately code-signed and its contained `.app` will use the fixed local development certificate. No application ZIP is planned, and updates remain manual.
- Any unchecked automated or manual item in the release checklist remains unverified.

## Contributing and security

- Contribution guide: [CONTRIBUTING.md](CONTRIBUTING.md)
- Vulnerability reporting: [SECURITY.md](SECURITY.md)
- Release verification: [docs/RELEASE_CHECKLIST.md](docs/RELEASE_CHECKLIST.md)

Never paste API keys, access tokens, or unredacted personal data into a public issue, log, or demo capture.

## License

Original project source is available under the [MIT License](LICENSE), copyright © 2026 Kunkun / 困困.

Runtime distributions include third-party components under other licenses. The current dependency manifest and lockfile no longer include `ffmpeg-static`, and new builds deliberately exclude a standalone FFmpeg CLI. Optional media conversion invokes system FFmpeg installed and managed separately by the user; its license and redistribution terms remain independent from this project's MIT license. Read [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and inventory the exact contents of every source or binary artifact before distribution.
