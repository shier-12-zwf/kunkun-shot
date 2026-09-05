# macOS 构建、签名与公证 / macOS Build, Signing, and Notarization

这个项目有三条刻意分开的 macOS 打包路径：默认本地包使用固定的本机证书稳定签名；ad-hoc 包只用于一次性隔离测试；正式包必须使用 Developer ID、Hardened Runtime 和 Apple 公证，并通过产物校验。

This project deliberately separates three macOS packaging paths: the default local build uses a fixed local certificate for a stable identity, the ad-hoc build is only for one-off isolated tests, and formal artifacts require Developer ID, Hardened Runtime, Apple notarization, and artifact verification.

## 0. 工具链前置检查 / Toolchain prerequisites

- 使用 Node.js `>=22.12.0`，并确认 `node --version` 与执行 `npm` 时使用的是同一套 Node.js。
- 打包过程会编译 `axprobe` 与 `vision-boxes` 两个 Swift 原生 helper，因此需要一套完整且一致的 Xcode 或 Command Line Tools；至少先确认 `xcrun --find swiftc`、`xcrun --show-sdk-path` 可用。
- 如果机器安装了多套 Xcode，可仅为当前命令指定工具链，例如：`DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer npm run dist:mac:local`。这不会修改系统全局的 `xcode-select` 设置。
- 若 Swift 报告 `SwiftBridging` 重复定义、SDK 模块映射冲突等错误，应修复或重装 Command Line Tools/Xcode；不要直接删除 SDK 头文件或模块映射文件来绕过错误。

Use Node.js `>=22.12.0`, and make sure `node` and `npm` resolve through the same installation. Packaging compiles the `axprobe` and `vision-boxes` Swift helpers, so a complete, internally consistent Xcode or Command Line Tools installation is required. When multiple Xcode installations exist, scope `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer` to the build command instead of changing global `xcode-select` state. Duplicate `SwiftBridging` or SDK module-map errors indicate a damaged or mixed toolchain that should be repaired or reinstalled, not worked around by deleting SDK files.

## 1. 稳定本地签名构建 / Stable local-signed build

```bash
npm run dist:mac:local
```

`npm run dist` 与兼容别名 `npm run dist:mac` 都指向这条默认本地路径。它要求通过 `KK_MAC_SIGNING_IDENTITY` 配置一项钥匙串中存在且带私钥的固定代码签名身份，并把产物写入 `dist/local-signed-mac`。构建完成后会验证未打包应用、DMG 内应用和 ZIP 内应用都锚定到该证书；这不表示 DMG 外层容器已经单独 codesign。也可单独执行：

```bash
npm run verify:mac:local
```

本地签名路径明确关闭公证、Hardened Runtime 和时间戳，构建命令本身不会上传产物。固定证书让同一台 Mac 上的开发安装在更新后仍能匹配屏幕录制、辅助功能、麦克风等 TCC 权限；它不是 Developer ID 分发签名，不能证明 Gatekeeper 兼容或正式发布。若人工上传这种产物，只能明确标记为知情测试/预览包。配置步骤见 [本机构建签名指南](MACOS_LOCAL_BUILD.md)。

`npm run dist` and the compatibility alias `npm run dist:mac` both use this default local path. It requires `KK_MAC_SIGNING_IDENTITY` to resolve to one fixed keychain code-signing identity with a private key, writes artifacts to `dist/local-signed-mac`, and verifies that the unpacked app and the apps inside the DMG and ZIP are anchored to that certificate. `npm run verify:mac:local` can repeat the verification independently.

The local-signed path explicitly disables notarization, Hardened Runtime, and timestamping, and the build command itself never uploads artifacts. The fixed certificate lets development installs on the same Mac continue to match Screen Recording, Accessibility, microphone, and other TCC permissions after an update. It is not a Developer ID distribution signature and is not evidence of Gatekeeper acceptance or a formal release. Any manually uploaded artifact from this path must be clearly labeled as an informed-testing/preview package. See the [local signing guide](MACOS_LOCAL_BUILD.md) for setup.

## 2. 临时 ad-hoc 构建 / Temporary ad-hoc build

```bash
npm run dist:mac:adhoc
```

这条入口明确禁用稳定签名与公证，只适合不需要保留权限的一次性隔离测试。ad-hoc 指定要求会绑定到随构建变化的 CDHash；不要用其产物覆盖日常安装版本、交付安装更新或测试 TCC 权限延续性，否则 macOS 可能继续显示开关已开启，但新构建仍无法匹配旧权限记录。

This entry explicitly disables stable signing and notarization and is only for one-off isolated tests that do not need retained permissions. Its ad-hoc designated requirement is tied to a build-specific CDHash. Never use it to replace the day-to-day install, deliver an update, or test TCC continuity: macOS can leave a permission switch visibly enabled while the new build no longer matches the stored requirement.

## 3. 正式发布构建 / Formal release build

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

## 4. 正式产物独立重验 / Independent formal-artifact re-verification

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
