# macOS 本机构建签名

`npm run dist:mac:local` 默认生成“稳定本地签名”产物。这样 macOS 的屏幕录制、辅助功能、麦克风等 TCC 权限会绑定到固定证书，而不是每次构建都会变化的 ad-hoc CDHash。

## 首次配置

1. 查看本机有效签名身份：

   ```sh
   security find-identity -v -p codesigning
   ```

2. 把所选身份的 40 位 SHA-1 指纹写入已被 Git 忽略的 `.env.local`：

   ```text
   KK_MAC_SIGNING_IDENTITY=0123456789ABCDEF0123456789ABCDEF01234567
   ```

也可以只为单次命令设置同名环境变量。构建脚本会在打包前确认该身份存在且带有私钥，并拒绝空值、重复名称和 ad-hoc 身份。

如果第 1 步没有可用身份，可在“钥匙串访问”里选择“证书助理 → 创建证书”，证书类型选“代码签名”，并保持同一张证书供日常本地构建使用。创建后重新执行 `security find-identity -v -p codesigning`，再按指纹配置；不要用证书名称代替指纹，以免同名证书导致误签。

## 构建与验证

```sh
npm run dist:mac:local
```

产物写入 `dist/local-signed-mac`。同一命令会检查未解包应用、DMG 和 ZIP 内应用的深度签名，并确认指定要求锚定到配置的证书。

本地自签证书没有 Apple Team ID，因此本地配置明确关闭 Hardened Runtime 和时间戳；正式发布仍使用独立的 Developer ID、公证及 Hardened Runtime 流程。

只有不需要保留 macOS 权限的一次性隔离测试才使用：

```sh
npm run dist:mac:adhoc
```

不要用 ad-hoc 产物覆盖日常安装版本，否则下一次启动时 TCC 权限会失效。
