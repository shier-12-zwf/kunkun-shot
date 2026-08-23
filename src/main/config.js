// 配置持久化：读写 userData/config.json，并与默认配置深合并。
// 安全：API Key 落盘前用 Electron safeStorage 加密（macOS 走 Keychain），内存中始终是明文，
// 因此 app 其余部分读取行为不变；旧的明文配置会在下次保存时自动迁移为密文。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app, safeStorage } = require('electron');
const { DEFAULT_CONFIG } = require('../shared/config-schema');
const { normalizeConfigPatch } = require('./ipc-validation');

let cache = null;
let filePath = null;

// 需要加密的敏感字段路径（[父对象键, 字段键]）
const SECRET_PATHS = [
  ['deepseek', 'apiKey'],
  ['minimax', 'apiKey'],
  ['openai', 'apiKey'], // 通用 OpenAI 兼容服务商（硅基流动/通义千问/Kimi/自定义）的 Key
];
const ENC_PREFIX = 'enc:v1:'; // 密文标记，便于区分明文/密文与版本演进
const MAX_CONFIG_FILE_BYTES = 512 * 1024;

function getFilePath() {
  if (!filePath) filePath = path.join(app.getPath('userData'), 'config.json');
  return filePath;
}

// 有上限地读取普通文件，避免损坏/恶意 config.json 在应用启动时造成无界内存占用。
// 固定多读 1 字节用于发现读取期间增长的文件，规避 stat→read 的竞态。
function readConfigFileText() {
  let fd = null;
  try {
    fd = fs.openSync(getFilePath(), 'r');
  } catch (e) {
    if (e && e.code === 'ENOENT') return null;
    throw e;
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error('config.json 不是普通文件。');
    if (stat.size > MAX_CONFIG_FILE_BYTES) throw new Error('config.json 超过 512 KiB 上限。');
    const buffer = Buffer.allocUnsafe(MAX_CONFIG_FILE_BYTES + 1);
    let total = 0;
    while (total < buffer.length) {
      const count = fs.readSync(fd, buffer, total, buffer.length - total, null);
      if (!count) break;
      total += count;
    }
    if (total > MAX_CONFIG_FILE_BYTES) throw new Error('config.json 超过 512 KiB 上限。');
    return buffer.subarray(0, total).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

function readParsedConfigFromDisk() {
  const text = readConfigFileText();
  if (text === null) return {};
  return JSON.parse(text);
}

function normalizeDiskConfig(parsed) {
  let candidate = parsed;
  const encryptedSecrets = [];
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    candidate = { ...parsed };
    for (const [a, b] of SECRET_PATHS) {
      const section = parsed[a];
      const stored = section && typeof section === 'object' && !Array.isArray(section) ? section[b] : null;
      if (typeof stored === 'string' && stored.startsWith(ENC_PREFIX)) {
        const base64 = stored.slice(ENC_PREFIX.length);
        if (
          stored.length > 64 * 1024 ||
          !base64 ||
          base64.length % 4 !== 0 ||
          !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)
        ) {
          throw new Error(`${a}.${b} 密文格式无效。`);
        }
        // IPC schema 的 16 KiB 限制约束明文输入；safeStorage 密文经 Base64 后可能更长。
        // 先用空值校验其余磁盘 schema，再把经过独立上限/格式校验的密文放回。
        candidate[a] = { ...section, [b]: '' };
        encryptedSecrets.push([a, b, stored]);
      }
    }
  }
  const normalized = normalizeConfigPatch(candidate, 'main');
  for (const [a, b, stored] of encryptedSecrets) {
    normalized[a] = { ...normalized[a], [b]: stored };
  }
  return normalized;
}

function readValidatedConfigFromDisk() {
  const parsed = readParsedConfigFromDisk();
  // 磁盘数据与 renderer 输入一样不可信：只接受 DEFAULT_CONFIG 中存在且类型正确的字段。
  return normalizeDiskConfig(parsed);
}

function canEncrypt() {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch (_) {
    return false;
  }
}

// 明文 → 密文（带前缀）。空值原样返回；加密不可用或失败返回 null。
// 绝不能在失败时回退明文，否则 safeStorage 短暂报错就会把 API Key 写进 config.json。
function encField(plain) {
  if (!plain || typeof plain !== 'string') return plain;
  if (!canEncrypt()) return null;
  try {
    return ENC_PREFIX + safeStorage.encryptString(plain).toString('base64');
  } catch (_) {
    return null;
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
    const onDisk = readValidatedConfigFromDisk();
    const v = onDisk && onDisk[a] && onDisk[a][b];
    return typeof v === 'string' ? v : '';
  } catch (_) {
    return '';
  }
}

// 生成「落盘副本」：敏感字段加密，其余共享引用（不修改内存中的明文 cache）。
// 关键保护：若某 secret 字段内存值为空（多为 safeStorage 不可用时 decField 返回 '' 所致），
// 但磁盘上仍存有非空密文，则保留磁盘原值，绝不用空串覆盖——防止无关设置改动导致 Key 丢失。
function toDiskForm(cfg, patch) {
  const out = { ...cfg };
  for (const [a, b] of SECRET_PATHS) {
    if (out[a] && typeof out[a] === 'object' && typeof out[a][b] === 'string') {
      const encryptionAvailable = canEncrypt();
      const explicitlyUpdated = !!(
        patch &&
        patch[a] &&
        Object.prototype.hasOwnProperty.call(patch[a], b)
      );
      const explicitlyCleared = explicitlyUpdated && patch[a][b] === '';
      let enc = '';
      if (explicitlyUpdated && !explicitlyCleared && !encryptionAvailable) {
        throw new Error(`系统安全存储不可用，${a} API Key 未保存。`);
      }
      if (encryptionAvailable && out[a][b]) {
        enc = encField(out[a][b]);
      }
      if (explicitlyUpdated && !explicitlyCleared && enc === null) {
        throw new Error(`${a} API Key 加密失败，未保存。`);
      }
      if (enc === null || (!encryptionAvailable && !explicitlyCleared)) {
        // 系统加密不可用或实际加密调用失败时，绝不把新明文 Key 写盘。若磁盘已有可恢复的密文则原样保留；
        // 非密钥设置仍可保存，但明确提交的新 Key 会在上方直接报错，绝不误报“已保存”。
        const disk = readDiskSecret(a, b);
        enc = disk.startsWith(ENC_PREFIX) ? disk : '';
      }
      out[a] = { ...out[a], [b]: enc };
    }
  }
  return out;
}

// 同目录临时文件 + fsync + rename，避免崩溃/断电留下半截 JSON；权限固定为 0600。
function writeConfigFile(cfg, patch) {
  const target = getFilePath();
  const parent = path.dirname(target);
  fs.mkdirSync(parent, { recursive: true });
  const tmp = path.join(parent, `.config-${process.pid}-${crypto.randomBytes(8).toString('hex')}.tmp`);
  let fd = null;
  try {
    fd = fs.openSync(tmp, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify(toDiskForm(cfg, patch), null, 2), 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmp, target);
  } catch (err) {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch (_) {}
    }
    try { fs.unlinkSync(tmp); } catch (_) {}
    throw err;
  }
}

// 仅对「纯对象」做递归合并，数组与标量直接覆盖。
// P1-6：过滤 __proto__/constructor/prototype 键，杜绝渲染层 patch 造成的原型污染。
function deepMerge(base, patch) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  if (!patch || typeof patch !== 'object') return out;
  for (const key of Object.keys(patch)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
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
  let hadPlaintextSecret = false;
  try {
    const parsed = readParsedConfigFromDisk();
    // 即使其他字段导致 schema 校验失败，也要先识别旧版明文秘密，随后用安全默认值覆盖原文件。
    hadPlaintextSecret = SECRET_PATHS.some(
      ([a, b]) => parsed && parsed[a] && typeof parsed[a][b] === 'string' &&
        parsed[a][b] && !parsed[a][b].startsWith(ENC_PREFIX)
    );
    onDisk = normalizeDiskConfig(parsed);
  } catch (e) {
    console.error('[config] 读取失败，使用默认配置：', e.message);
    onDisk = {};
  }
  decryptSecretsInPlace(onDisk); // 磁盘密文 → 内存明文
  const loaded = deepMerge(DEFAULT_CONFIG, onDisk);
  // 安全迁移：磁盘上发现旧版明文 Key 就立即重写。系统加密可用时转成密文；不可用时
  // 从磁盘移除、只保留在本次进程内存，避免为了“继续持久化”而永久留下明文秘密。
  if (hadPlaintextSecret) {
    try {
      writeConfigFile(loaded);
    } catch (e) {
      console.error('[config] 旧版明文 API Key 安全迁移失败：', e.message);
      throw new Error(`旧版明文 API Key 安全迁移失败：${e.message}`, { cause: e });
    }
  }
  cache = loaded;
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
  const safePatch = normalizeConfigPatch(patch || {}, 'main');
  const merged = deepMerge(load(), safePatch);
  try {
    writeConfigFile(merged, safePatch); // 原子落盘；敏感字段必须成功加密或显式清空
  } catch (e) {
    console.error('[config] 写入失败：', e.message);
    throw e;
  }
  // 只有原子替换成功才发布新的内存视图；否则调用方收到失败后仍应继续使用旧配置。
  cache = merged; // 内存中保持明文
  // set() 的返回值会直接跨 IPC 送到渲染进程。永远只返回脱敏副本，避免当前或未来
  // 调用方无意中把主进程内存里的真实 API Key 暴露给 renderer。
  return publicView();
}

module.exports = { get, set, publicView };
