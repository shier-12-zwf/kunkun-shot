# Third-Party Notices / 第三方软件声明

This notice was prepared from `package-lock.json` (lockfile version 3) and the installed package metadata for the current dependency graph. The lockfile is the source of truth for resolved versions. It does not replace the license files shipped by each upstream project.

本声明依据当前 `package-lock.json`（lockfile version 3）及已安装包的元数据整理。解析版本以 lockfile 为准；本文不能替代各上游项目随附的完整许可证文本。

## Project code / 项目代码

Original source code in this repository is offered under the [MIT License](LICENSE). That license does not relicense third-party code, model data, native binaries, Electron/Chromium/Node.js, or operating-system components.

本仓库原创源码以 [MIT License](LICENSE) 提供。MIT 许可不会重新许可第三方代码、模型数据、原生二进制、Electron/Chromium/Node.js 或操作系统组件。

## Direct production dependencies / 直接运行时依赖

| Package | Resolved version | Declared license | Upstream |
| --- | ---: | --- | --- |
| `ffmpeg-static` | 5.3.0 | GPL-3.0-or-later | [eugeneware/ffmpeg-static](https://github.com/eugeneware/ffmpeg-static) |
| `jsqr` | 1.4.0 | Apache-2.0 | [cozmo/jsQR](https://github.com/cozmo/jsQR) |
| `katex` | 0.18.5 | MIT | [KaTeX/KaTeX](https://github.com/KaTeX/KaTeX) |
| `tesseract.js` | 5.1.1 | Apache-2.0 | [naptha/tesseract.js](https://github.com/naptha/tesseract.js) |

The renderer also contains a vendored `jsQR` browser bundle at `src/renderer/overlay/vendor/jsQR.js`; the jsQR Apache-2.0 terms continue to apply to that copy. A copy of Apache-2.0 is included at [`LICENSES/Apache-2.0.txt`](LICENSES/Apache-2.0.txt).

渲染层还在 `src/renderer/overlay/vendor/jsQR.js` 中包含一份 jsQR 浏览器 bundle，该副本仍受 jsQR 的 Apache-2.0 条款约束。Apache-2.0 全文副本位于 [`LICENSES/Apache-2.0.txt`](LICENSES/Apache-2.0.txt)。

公式贴图窗口在本机加载 KaTeX 及其随附字体，不依赖 CDN。KaTeX 的 MIT 许可证副本位于 [`LICENSES/KaTeX-MIT.txt`](LICENSES/KaTeX-MIT.txt)。

### Important FFmpeg distribution note / FFmpeg 分发特别说明

`ffmpeg-static` installs a platform-specific FFmpeg executable and declares `GPL-3.0-or-later`. Its own README states that binary releases are covered by their respective licenses. A packaged application that includes this executable must preserve the applicable notices and independently satisfy the corresponding GPL/FFmpeg source-offer and redistribution obligations. The repository's MIT license must not be presented as the only license governing such a binary distribution.

`ffmpeg-static` 会安装平台对应的 FFmpeg 可执行文件，并声明为 `GPL-3.0-or-later`。其上游 README 同时说明，各平台二进制受各自许可证约束。若安装包包含该可执行文件，发布者必须保留适用声明，并独立履行相应 GPL/FFmpeg 源码提供及再分发义务；不得把仓库的 MIT 许可证描述成整个二进制分发物唯一适用的许可证。

Relevant upstream materials / 上游材料：

- [ffmpeg-static license](https://github.com/eugeneware/ffmpeg-static/blob/master/LICENSE)
- [ffmpeg-static binary sources](https://github.com/eugeneware/ffmpeg-static#sources-of-the-binaries)
- [FFmpeg legal information](https://ffmpeg.org/legal.html)

## Other installed production packages / 其他已解析运行时包

The following packages are present in the current `npm ls --omit=dev --all` tree. License identifiers are taken from installed package metadata; `parse-cache-control` uses the generic `BSD` label in its package metadata and carries a BSD-style license file, so no more specific SPDX identifier is asserted here.

下列软件包出现在当前 `npm ls --omit=dev --all` 依赖树中。许可证标识来自已安装包元数据；`parse-cache-control` 的包元数据只写作通用 `BSD`，并随附 BSD 风格许可证，因此本文不推断更具体的 SPDX 标识。

| License metadata | Packages and resolved versions |
| --- | --- |
| Apache-2.0 | `caseless@0.12.0`, `idb-keyval@6.3.0`, `tesseract.js-core@5.1.1`, `wasm-feature-detect@1.9.0` |
| BSD-2-Clause | `webidl-conversions@3.0.1` |
| BSD (upstream metadata) | `parse-cache-control@1.0.1` |
| ISC | `inherits@2.0.4` |
| MIT | `@derhuerst/http-basic@8.2.4`, `@types/node@10.17.60`, `agent-base@6.0.2`, `bmp-js@0.1.0`, `buffer-from@1.1.2`, `commander@15.0.0`, `concat-stream@2.0.0`, `debug@4.4.3`, `encoding@0.1.13`, `env-paths@2.2.1`, `http-response-object@3.0.2`, `https-proxy-agent@5.0.1`, `iconv-lite@0.6.3`, `is-electron@2.2.2`, `is-url@1.2.4`, `ms@2.1.3`, `node-fetch@2.7.0`, `opencollective-postinstall@2.0.3`, `progress@2.0.3`, `readable-stream@3.6.2`, `regenerator-runtime@0.13.11`, `safe-buffer@5.2.1`, `safer-buffer@2.1.2`, `string_decoder@1.3.0`, `tr46@0.0.3`, `typedarray@0.0.6`, `util-deprecate@1.0.2`, `whatwg-url@5.0.0`, `zlibjs@0.3.1` |

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
