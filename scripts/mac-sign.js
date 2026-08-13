// 自定义签名钩子（electron-builder `mac.customSign`）：
// 钥匙串里存在两张同名证书 "KUN Translator Local Signing"（一张有效、一张过期），
// electron-builder 只按证书名签名会报 ambiguous；这里改用证书哈希直接签，彻底消歧。
// 与 scripts/resign-mac.sh 使用同一哈希，保证 designated requirement 稳定（TCC 授权不失效）。
const path = require('path');
const { signAsync } = require('@electron/osx-sign');

const CERT_HASH = 'A99DC43611DA8D6FDBD2FBCB6281B6DF6580B296'; // KUN Translator Local Signing（有效那张）

module.exports = async function (options) {
  const entitlements = path.join(__dirname, '..', 'build', 'entitlements.mac.plist');
  await signAsync({
    app: options.app,
    identity: CERT_HASH,
    // 绕过 osx-sign 的 find-identity 校验：它不带 -p codesigning，本机返回 0 个身份；
    // 哈希直接进 codesign --sign，codesign 支持哈希签名。
    identityValidation: false,
    hardenedRuntime: true,
    entitlements,
    entitlementsInherit: entitlements,
  });
};
