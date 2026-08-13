// 配置持久化：读写 userData/config.json，并与默认配置深合并。
// 安全：API Key 落盘前用 Electron safeStorage 加密（macOS 走 Keychain），内存中始终是明文，
// 因此 app 其余部分读取行为不变；旧的明文配置会在下次保存时自动迁移为密文。
const fs = require('fs');
const path = require('path');
const { app, safeStorage } = require('electron');
const { DEFAULT_CONFIG } = require('../shared/config-schema');

let cache = null;
let filePath = null;

// 需要加密的敏感字段路径（[父对象键, 字段键]）
const SECRET_PATHS = [
  ['deepseek', 'apiKey'],
  ['minimax', 'apiKey'],
  ['openai', 'apiKey'], // 通用 OpenAI 兼容服务商（硅基流动/通义千问/Kimi/自定义）的 Key
];
const ENC_PREFIX = 'enc:v1:'; // 密文标记，便于区分明文/密文与版本演进

function getFilePath() {
  if (!filePath) filePath = path.join(app.getPath('userData'), 'config.json');
  return filePath;
}

function canEncrypt() {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch (_) {
    return false;
  }
}

// 明文 → 密文（带前缀）。已是密文/空值/不可用则原样返回，保证不阻断。
function encField(plain) {
  if (!plain || typeof plain !== 'string' || plain.startsWith(ENC_PREFIX)) return plain;
  if (!canEncrypt()) return plain;
  try {
    return ENC_PREFIX + safeStorage.encryptString(plain).toString('base64');
  } catch (_) {
    return plain;
  }
}

// 密文 → 明文。无前缀=旧明文，原样返回；不可用/解密失败返回空串（避免把密文当 Key 用）。
function decField(stored) {
  if (!stored || typeof stored !== 'string' || !stored.startsWith(ENC_PREFIX)) return stored;
  if (!canEncrypt()) return '';
  try {
    const buf = Buffer.from(stored.slice(ENC_PREFIX.length), 'base64');
    return safeStorage.decryptString(buf);
  } catch (_) {
    return '';
  }
}

// 在对象上就地解密敏感字段（用于刚从磁盘读出的对象）。
function decryptSecretsInPlace(obj) {
  if (!obj || typeof obj !== 'object') return;
  for (const [a, b] of SECRET_PATHS) {
    if (obj[a] && typeof obj[a] === 'object' && typeof obj[a][b] === 'string') {
      obj[a][b] = decField(obj[a][b]);
    }
  }
}

// 读取磁盘上现有配置里某个 secret 字段的原始存储值（可能是密文/明文/空）。
// 用于「内存里该字段为空」时的兜底：避免用空串覆盖盘上仍有效的密文（safeStorage
// 临时不可用——如 Linux 无 libsecret / 钥匙串被锁——会让 decField 返回 ''，此时若直接
// 落盘就会永久丢失用户已保存的 Key）。
function readDiskSecret(a, b) {
  try {
    if (!fs.existsSync(getFilePath())) return '';
    const onDisk = JSON.parse(fs.readFileSync(getFilePath(), 'utf-8'));
    const v = onDisk && onDisk[a] && onDisk[a][b];
    return typeof v === 'string' ? v : '';
  } catch (_) {
    return '';
  }
}

// 生成「落盘副本」：敏感字段加密，其余共享引用（不修改内存中的明文 cache）。
// 关键保护：若某 secret 字段内存值为空（多为 safeStorage 不可用时 decField 返回 '' 所致），
// 但磁盘上仍存有非空密文，则保留磁盘原值，绝不用空串覆盖——防止无关设置改动导致 Key 丢失。
function toDiskForm(cfg) {
  const out = { ...cfg };
  for (const [a, b] of SECRET_PATHS) {
    if (out[a] && typeof out[a] === 'object' && typeof out[a][b] === 'string') {
      let enc = encField(out[a][b]);
      // 仅在「加密不可用」时兜底：此时内存空极可能是 decField 解密失败所致（并非用户主动清空），
      // 若盘上还有密文就保留，避免误覆盖丢 Key。加密可用时，空串代表用户真想清空，照常写空。
      if (!enc && !canEncrypt()) {
        const disk = readDiskSecret(a, b);
        if (disk) enc = disk;
      }
      out[a] = { ...out[a], [b]: enc };
    }
  }
  return out;
}

// 仅对「纯对象」做递归合并，数组与标量直接覆盖。
function deepMerge(base, patch) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  if (!patch || typeof patch !== 'object') return out;
  for (const key of Object.keys(patch)) {
    const pv = patch[key];
    const bv = out[key];
    if (pv && typeof pv === 'object' && !Array.isArray(pv) && bv && typeof bv === 'object' && !Array.isArray(bv)) {
      out[key] = deepMerge(bv, pv);
    } else {
      out[key] = pv;
    }
  }
  return out;
}

function load() {
  if (cache) return cache;
  let onDisk = {};
  try {
    if (fs.existsSync(getFilePath())) {
      onDisk = JSON.parse(fs.readFileSync(getFilePath(), 'utf-8'));
    }
  } catch (e) {
    console.error('[config] 读取失败，使用默认配置：', e.message);
  }
  const hadPlaintextSecret = SECRET_PATHS.some(
    ([a, b]) => onDisk[a] && typeof onDisk[a][b] === 'string' && onDisk[a][b] && !onDisk[a][b].startsWith(ENC_PREFIX)
  );
  decryptSecretsInPlace(onDisk); // 磁盘密文 → 内存明文
  cache = deepMerge(DEFAULT_CONFIG, onDisk);
  // 安全迁移：磁盘上发现明文 Key 且当前可加密 → 立即重写为密文（一次性），不必等用户下次保存。
  if (hadPlaintextSecret && canEncrypt()) {
    try {
      fs.mkdirSync(path.dirname(getFilePath()), { recursive: true });
      fs.writeFileSync(getFilePath(), JSON.stringify(toDiskForm(cache), null, 2), 'utf-8');
    } catch (_) {}
  }
  return cache;
}

function get() {
  return load();
}

// H2 修复：供渲染层读取的公开视图。API Key 一律替换为掩码，绝不把明文 Key 送进任何渲染进程；
// 其余字段照常返回（深拷贝，渲染层拿不到主进程内存里的引用）。渲染层判断「是否已配置」用 truthy 即可。
const KEY_MASK = '••••••••••••';
function publicView() {
  const out = deepMerge({}, load());
  for (const [a, b] of SECRET_PATHS) {
    if (out[a] && typeof out[a][b] === 'string' && out[a][b]) {
      out[a] = { ...out[a], [b]: KEY_MASK };
    }
  }
  return out;
}

function set(patch) {
  const merged = deepMerge(load(), patch || {});
  cache = merged; // 内存中保持明文
  try {
    fs.mkdirSync(path.dirname(getFilePath()), { recursive: true });
    fs.writeFileSync(getFilePath(), JSON.stringify(toDiskForm(merged), null, 2), 'utf-8'); // 落盘加密
  } catch (e) {
    console.error('[config] 写入失败：', e.message);
  }
  return merged;
}

module.exports = { get, set, publicView };
