#!/bin/bash
# 用固定的自签名证书重签 macOS app，保证屏幕录制等 TCC 权限「授权一次永久有效」。
#
# 原理：TCC 用 app 的 designated requirement（= bundle id + 证书指纹）识别 app。
# ad-hoc 签名每次 cdhash 都变 → 权限失效；用同一张自签名证书签名 → DR 稳定 → 授权持久。
#
# 用法：
#   bash scripts/resign-mac.sh                                   # 重签 dist 里打包好的 app
#   bash scripts/resign-mac.sh "/Applications/困困截图工具.app"   # 重签已安装的 app
#
# 前置：钥匙串「登录」里需有名为 "KunKun Shot Codesign" 的自签名代码签名证书。
set -e

CERT="KunKun Shot Codesign"
APP="${1:-dist/mac-arm64/困困截图工具.app}"

if [ ! -d "$APP" ]; then
  echo "❌ 找不到 app: $APP"
  exit 1
fi

echo "→ 用「$CERT」重签: $APP"
codesign --force --deep --sign "$CERT" "$APP"
codesign --verify --deep --strict "$APP" && echo "✅ 重签完成且签名有效"
echo "→ designated requirement（应锚定证书指纹，保证 TCC 稳定）："
codesign -d -r- "$APP" 2>&1 | grep -i designated || true
