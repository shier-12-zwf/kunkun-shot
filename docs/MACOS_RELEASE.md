# macOS 构建、签名与公证 / macOS Build, Signing, and Notarization

这个项目有两条刻意分开的 macOS 打包路径。本地包只用于开发验证；正式包必须签名、公证并通过产物校验。

This project deliberately separates two macOS packaging paths. Local artifacts are for development only; formal artifacts must be signed, notarized, and pass artifact verification.

## 0. 工具链前置检查 / Toolchain prerequisites

- 使用 Node.js `>=22.12.0`，并确认 `node --version` 与执行 `npm` 时使用的是同一套 Node.js。
- 打包过程会编译 `axprobe` 与 `vision-boxes` 两个 Swift 原生 helper，因此需要一套完整且一致的 Xcode 或 Command Line Tools；至少先确认 `xcrun --find swiftc`、`xcrun --show-sdk-path` 可用。
- 如果机器安装了多套 Xcode，可仅为当前命令指定工具链，例如：`DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer npm run dist:mac:local`。这不会修改系统全局的 `xcode-select` 设置。
- 若 Swift 报告 `SwiftBridging` 重复定义、SDK 模块映射冲突等错误，应修复或重装 Command Line Tools/Xcode；不要直接删除 SDK 头文件或模块映射文件来绕过错误。

Use Node.js `>=22.12.0`, and make sure `node` and `npm` resolve through the same installation. Packaging compiles the `axprobe` and `vision-boxes` Swift helpers, so a complete, internally consistent Xcode or Command Line Tools installation is required. When multiple Xcode installations exist, scope `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer` to the build command instead of changing global `xcode-select` state. Duplicate `SwiftBridging` or SDK module-map errors indicate a damaged or mixed toolchain that should be repaired or reinstalled, not worked around by deleting SDK files.

## 1. 本地无签名构建 / Local unsigned build

```bash
npm run dist:mac:local
```

这个命令同时关闭签名身份自动发现和公证，也不会发布产物。`npm run dist` 与兼容别名 `npm run dist:mac` 都指向这条本地路径。成功只说明“打包完成”，不能声称 Apple 签名、公证或 Gatekeeper 兼容。

This command disables identity auto-discovery and notarization and never publishes artifacts. `npm run dist` and the compatibility alias `npm run dist:mac` both use this local path. Success means only that packaging completed; it is not evidence of Apple signing, notarization, or Gatekeeper acceptance.

## 2. 正式发布构建 / Formal release build

```bash
npm run dist:mac:release
```

正式命令在调用 `electron-builder` 前执行失败关闭预检，且固定 `--publish never`。它必须同时找到：

1. 一种签名方式：
   - `CSC_LINK` + `CSC_KEY_PASSWORD`；或
   - 钥匙串中已安装证书的明确 `CSC_NAME`。
2. 且仅一种完整的公证凭据组：
   - 推荐：`APPLE_API_KEY` + `APPLE_API_KEY_ID` + `APPLE_API_ISSUER`；
   - 或：`APPLE_ID` + `APPLE_APP_SPECIFIC_PASSWORD` + `APPLE_TEAM_ID`；
   - 或：`APPLE_KEYCHAIN_PROFILE`，可选加 `APPLE_KEYCHAIN`。

The formal command performs a fail-closed preflight before invoking `electron-builder` and always uses `--publish never`. It requires:

1. Exactly one signing method: `CSC_LINK` + `CSC_KEY_PASSWORD`, or an explicit installed-keychain `CSC_NAME`.
2. Exactly one complete notarization family: the three API-key variables (recommended), the three Apple-ID variables, or `APPLE_KEYCHAIN_PROFILE` with optional `APPLE_KEYCHAIN`.

部分凭据、混用多组凭据、`CSC_NAME=-`、非 macOS 主机、或非空的 `dist/release-mac` 都会在打包前失败。凭据值不会被该脚本打印。不要把证书、`.p8` 私钥、密码或包含它们的 `.env` 提交到仓库；发布时也不要开启 shell tracing (`set -x`)。

Partial credentials, mixed credential families, `CSC_NAME=-`, a non-macOS host, or a non-empty `dist/release-mac` directory fail before packaging. Credential values are never printed by the wrapper. Never commit certificates, `.p8` private keys, passwords, or a credential-bearing `.env`; do not enable shell tracing (`set -x`) during a release.

正式配置使用 Hardened Runtime，并设置 `forceCodeSigning: true` 与 `mac.notarize: true`。`electron-builder` 成功后，同一命令会继续检查：

- 未打包 `.app`、DMG 内的 `.app` 和 ZIP 内的 `.app` 都是 Developer ID Application 签名，非 ad-hoc，含 Team ID 和 Hardened Runtime；
- `codesign --verify`、Gatekeeper `spctl --assess` 和 `stapler validate` 通过；
- DMG 通过 `hdiutil verify`，ZIP 通过完整性与路径安全检查；
- 输出 DMG/ZIP SHA-256，便于写入发布说明。

The formal config enables Hardened Runtime and sets `forceCodeSigning: true` and `mac.notarize: true`. After `electron-builder` succeeds, the same command verifies the unpacked app and the app inside each DMG/ZIP, checks Developer ID (not ad-hoc), Team ID, Hardened Runtime, `codesign`, Gatekeeper, the stapled ticket, DMG/ZIP integrity and safe ZIP paths, then prints SHA-256 hashes.

## 3. 独立重验 / Independent re-verification

若产物仍在默认目录：

```bash
npm run verify:mac:release
```

也可指定其他目录：

```bash
node scripts/verify-macos-release.js /absolute/path/to/release-output
```

这些本机证据仍不能代替从发布页重新下载后，在另一台 Mac 上进行的 Gatekeeper 与功能验收。只有针对确定发布提交和确定产物保留了命令输出，才能在发布检查清单中勾选对应项。

Local evidence still does not replace Gatekeeper and functional acceptance on another Mac after downloading the public artifact. Check release-list items only when command output has been retained for the exact release commit and exact artifacts.
