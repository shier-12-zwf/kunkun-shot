# Third-Party Notices / 第三方软件声明

This notice was prepared from `package-lock.json` (lockfile version 3) and the installed package metadata for the current dependency graph. The lockfile is the source of truth for resolved versions. It does not replace the license files shipped by each upstream project.

本声明依据当前 `package-lock.json`（lockfile version 3）及已安装包的元数据整理。解析版本以 lockfile 为准；本文不能替代各上游项目随附的完整许可证文本。

## Project code / 项目代码

Original source code in this repository is offered under the [MIT License](LICENSE). That license does not relicense third-party code, model data, native binaries, Electron/Chromium/Node.js, or operating-system components.

本仓库原创源码以 [MIT License](LICENSE) 提供。MIT 许可不会重新许可第三方代码、模型数据、原生二进制、Electron/Chromium/Node.js 或操作系统组件。

## Direct production dependencies / 直接运行时依赖

| Package | Resolved version | Declared license | Upstream |
| --- | ---: | --- | --- |
| `jsqr` | 1.4.0 | Apache-2.0 | [cozmo/jsQR](https://github.com/cozmo/jsQR) |
| `katex` | 0.18.5 | MIT | [KaTeX/KaTeX](https://github.com/KaTeX/KaTeX) |
| `tesseract.js` | 5.1.1 | Apache-2.0 | [naptha/tesseract.js](https://github.com/naptha/tesseract.js) |

The renderer also contains a vendored `jsQR` browser bundle at `src/renderer/overlay/vendor/jsQR.js`; the jsQR Apache-2.0 terms continue to apply to that copy. A copy of Apache-2.0 is included at [`LICENSES/Apache-2.0.txt`](LICENSES/Apache-2.0.txt).

渲染层还在 `src/renderer/overlay/vendor/jsQR.js` 中包含一份 jsQR 浏览器 bundle，该副本仍受 jsQR 的 Apache-2.0 条款约束。Apache-2.0 全文副本位于 [`LICENSES/Apache-2.0.txt`](LICENSES/Apache-2.0.txt)。

公式贴图窗口在本机加载 KaTeX 及其随附字体，不依赖 CDN。KaTeX 代码的 MIT 许可证副本位于 [`LICENSES/KaTeX-MIT.txt`](LICENSES/KaTeX-MIT.txt)。随附 KaTeX 字体受 SIL Open Font License 1.1 约束，其版权声明与许可证全文位于 [`LICENSES/KaTeX-Fonts-OFL-1.1.txt`](LICENSES/KaTeX-Fonts-OFL-1.1.txt)。

`tr46@0.0.3` 的发布包元数据声明 MIT，但该旧 npm 包本身未携带许可证文件。仓库随附其上游维护者公布的 MIT 版权与许可文本，见 [`LICENSES/tr46-MIT.txt`](LICENSES/tr46-MIT.txt)。

### Important FFmpeg distribution note / FFmpeg 分发特别说明

The release application deliberately does **not** bundle `ffmpeg-static` or a standalone FFmpeg executable. PNG, JPEG, PDF, and untrimmed WebM work without one. Optional WebP/BMP/AVIF image conversion, GIF/H.264 MP4 recording export, and trimmed recording export invoke an executable installed and managed separately by the user. Some formats require a build containing the corresponding encoder. The license and redistribution terms of that separately installed executable remain independent from this project's MIT license.

正式安装包明确**不内置** `ffmpeg-static` 或独立 FFmpeg 可执行文件。PNG、JPEG、PDF 与未剪辑 WebM 无需它即可使用；WebP/BMP/AVIF 图片转换、GIF/H.264 MP4 录屏导出及剪辑录屏会调用用户另行安装和管理的可执行文件，部分格式还要求该构建包含对应编码器。这个外部程序的许可与再分发条款独立于本项目的 MIT 许可证。

Relevant upstream materials / 上游材料：

- [FFmpeg legal information](https://ffmpeg.org/legal.html)

## Other installed production packages / 其他已解析运行时包

The following packages are present in the current `npm ls --omit=dev --all` tree. License identifiers are taken from installed package metadata. Optional packages installed for `node-fetch` are included because the packager can include them in the application.

下列软件包出现在当前 `npm ls --omit=dev --all` 依赖树中。许可证标识来自已安装包元数据；同时列出为 `node-fetch` 安装的可选包，因为打包器可能把它们收入应用。

| License metadata | Packages and resolved versions |
| --- | --- |
| Apache-2.0 | `idb-keyval@6.3.0`, `tesseract.js-core@5.1.1`, `wasm-feature-detect@1.9.0` |
| BSD-2-Clause | `webidl-conversions@3.0.1` |
| MIT | `bmp-js@0.1.0`, `commander@15.0.0`, `encoding@0.1.13` (optional), `iconv-lite@0.6.3` (optional), `is-electron@2.2.2`, `is-url@1.2.4`, `node-fetch@2.7.0`, `opencollective-postinstall@2.0.3`, `regenerator-runtime@0.13.11`, `safer-buffer@2.1.2` (optional), `tr46@0.0.3`, `whatwg-url@5.0.0`, `zlibjs@0.3.1` |

## Electron and build tools / Electron 与构建工具

The direct development dependencies and the transitive signing helper noted below currently resolve to:

| Package | Resolved version | Declared license | Notes |
| --- | ---: | --- | --- |
| `electron` | 42.9.0 | MIT | Packaged applications also contain Chromium, Node.js, and their third-party notices. |
| `electron-builder` | 26.15.3 | MIT | Build-time tool. |
| `@electron/osx-sign` | 1.3.3 | BSD-2-Clause | Transitive via `electron-builder` → `app-builder-lib`; its presence does not mean a release is signed or notarized. |

Electron release artifacts include their own notices (for example Chromium and Node.js notices). Preserve those files when redistributing a packaged app.

Electron 发布产物包含其自身的第三方声明（例如 Chromium 与 Node.js 声明）。再分发打包应用时必须保留这些文件。

## OCR language data / OCR 语言数据

The repository contains the following byte-for-byte copies from the official [`tesseract-ocr/tessdata_fast`](https://github.com/tesseract-ocr/tessdata_fast) repository at commit [`87416418657359cb625c412a48b6e1d6d41c29bd`](https://github.com/tesseract-ocr/tessdata_fast/commit/87416418657359cb625c412a48b6e1d6d41c29bd). Upstream states that all data in that repository is licensed under Apache-2.0; the matching license text is retained at [`LICENSES/Apache-2.0.txt`](LICENSES/Apache-2.0.txt).

| Repository file | Upstream file | SHA-256 |
| --- | --- | --- |
| `tessdata/chi_sim.traineddata` | `chi_sim.traineddata` | `a5fcb6f0db1e1d6d8522f39db4e848f05984669172e584e8d76b6b3141e1f730` |
| `tessdata/chi_tra.traineddata` | `chi_tra.traineddata` | `529c5b5797d64b126065cd55f2bb4c7fd7b15790798091b1ff259941a829330b` |
| `tessdata/deu.traineddata` | `deu.traineddata` | `19d219bbb6672c869d20a9636c6816a81eb9a71796cb93ebe0cb1530e2cdb22d` |
| `tessdata/eng.traineddata` | `eng.traineddata` | `7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2` |
| `tessdata/fra.traineddata` | `fra.traineddata` | `ced037562e8c80c13122dece28dd477d399af80911a28791a66a63ac1e3445ca` |
| `tessdata/jpn.traineddata` | `jpn.traineddata` | `1f5de9236d2e85f5fdf4b3c500f2d4926f8d9449f28f5394472d9e8d83b91b4d` |
| `tessdata/kor.traineddata` | `kor.traineddata` | `6b85e11d9bbf07863b97b3523b1b112844c43e713df8b66418a081fd1060b3b2` |
| `tessdata/por.traineddata` | `por.traineddata` | `c4932b937207a9514b7514d518b931a99938c02a28a5a5a553f8599ed58b7deb` |
| `tessdata/spa.traineddata` | `spa.traineddata` | `6f2e04d02774a18f01bed44b1111f2cd7f3ba7ac9dc4373cd3f898a40ea6b464` |

仓库包含来自官方 [`tesseract-ocr/tessdata_fast`](https://github.com/tesseract-ocr/tessdata_fast) 仓库固定提交 [`87416418657359cb625c412a48b6e1d6d41c29bd`](https://github.com/tesseract-ocr/tessdata_fast/commit/87416418657359cb625c412a48b6e1d6d41c29bd) 的逐字节一致副本，文件与 SHA-256 如上表。上游明确声明该仓库全部数据采用 Apache-2.0；对应许可证全文保存在 [`LICENSES/Apache-2.0.txt`](LICENSES/Apache-2.0.txt)。若升级或替换语言数据，必须重新逐字节核验并同步更新本声明与发布清单。

## Distributor responsibility / 分发者责任

Before distributing a source archive, DMG, ZIP, or other bundle, review the exact artifact—not only this repository—and include every required copyright notice, license text, source offer, and attribution. Dependency or binary upgrades require regenerating this inventory. This document is informational and is not legal advice.

发布源码包、DMG、ZIP 或其他组合产物前，应以最终产物为对象重新审计，并附齐所需版权声明、许可证全文、源码提供方式与署名。依赖或二进制升级后必须重新生成清单。本文仅供信息参考，不构成法律意见。
