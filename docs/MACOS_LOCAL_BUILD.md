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

产物写入 `dist/local-signed-mac`。同一命令会检查未解包应用、DMG 内应用和 ZIP 内应用的深度签名，并确认指定要求锚定到配置的证书；这不表示 DMG 外层容器已经单独 codesign。

本地自签证书没有 Apple Team ID，因此本地配置明确关闭 Hardened Runtime 和时间戳；正式发布仍使用独立的 Developer ID、公证及 Hardened Runtime 流程。

### Swift 工具链异常时的受控回退

正常构建会从仓库内源码重新编译 macOS Swift helper。如果 `swiftc` 报 `SwiftBridging` 模块重复定义等错误，应优先修复混装或损坏的 Command Line Tools / Xcode。不要为了构建本项目直接删除系统开发工具目录。

在确认旧安装来自同一份 helper 源码且其深度签名完整时，可临时复用其中的原生 helper：

```sh
codesign --verify --deep --strict --verbose=2 "/Applications/困困截图工具.app"
KK_MAC_NATIVE_HELPER_SOURCE_DIR="/Applications/困困截图工具.app/Contents/Resources/native-helpers" \
  npm run dist:mac:local
```

打包脚本只查找以当前源码哈希命名的 helper，并在复制前后检查文件非空、可执行以及 Mach-O CPU 架构；缺失或不匹配时会停止。源码哈希文件名和架构检查不能单独证明二进制来源，因此该变量只能指向你信任并已验证签名的旧构建，不能指向下载目录或第三方文件。GitHub CI 和工具链健康的开发机仍应走源码编译路径。

只有不需要保留 macOS 权限的一次性隔离测试才使用：

```sh
npm run dist:mac:adhoc
```

不要用 ad-hoc 产物覆盖日常安装版本，否则下一次启动时 TCC 权限会失效。
