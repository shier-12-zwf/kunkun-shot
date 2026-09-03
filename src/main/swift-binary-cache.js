'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  assertPackagedHelper,
  helperFilename,
  helperSourceHash,
  validateHelperRequest
} = require('./swift-helper-contract');

function isUsableBinary(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile() && stat.size > 0;
  } catch (_) {
    return false;
  }
}

function normalizeHelperLanguage(value) {
  if (value === undefined || value === null || value === '') return 'swift';
  if (value === 'swift' || value === 'c') return value;
  throw new TypeError(`native helper language is invalid: ${String(value)}`);
}

function createSwiftBinaryCache(options) {
  const cacheDir = options && options.cacheDir;
  const compile = options && options.compile;
  if (typeof cacheDir !== 'function') throw new TypeError('cacheDir is required');
  if (typeof compile !== 'function') throw new TypeError('compile is required');

  const inFlight = new Map();

  function ensureBinary({ name, source, language }) {
    try {
      validateHelperRequest(name, source);
      language = normalizeHelperLanguage(language);
    } catch (error) {
      return Promise.reject(error);
    }

    const hash = helperSourceHash(source);
    const dir = cacheDir();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const binaryPath = path.join(dir, `${name}-${hash}`);
    if (isUsableBinary(binaryPath)) return Promise.resolve(binaryPath);
    if (inFlight.has(binaryPath)) return inFlight.get(binaryPath);

    const pending = (async () => {
      const suffix = `${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
      const sourcePath = `${binaryPath}.${suffix}.${language === 'c' ? 'c' : 'swift'}`;
      const temporaryBinaryPath = `${binaryPath}.${suffix}.tmp`;
      try {
        fs.writeFileSync(sourcePath, source, {
          encoding: 'utf8',
          mode: 0o600,
          flag: 'wx'
        });
        await compile(sourcePath, temporaryBinaryPath, { name, source, language });
        if (!isUsableBinary(temporaryBinaryPath)) {
          throw new Error('swiftc 没有生成可执行文件。');
        }
        fs.chmodSync(temporaryBinaryPath, 0o700);
        fs.renameSync(temporaryBinaryPath, binaryPath);
        if (!isUsableBinary(binaryPath)) {
          throw new Error('Swift helper 缓存验证失败。');
        }
        return binaryPath;
      } finally {
        try { fs.unlinkSync(sourcePath); } catch (_) {}
        try { fs.unlinkSync(temporaryBinaryPath); } catch (_) {}
      }
    })();

    inFlight.set(binaryPath, pending);
    void pending.finally(() => {
      if (inFlight.get(binaryPath) === pending) inFlight.delete(binaryPath);
    }).catch(() => {});
    return pending;
  }

  return { ensureBinary };
}

function createSwiftBinaryProvider(options) {
  const isPackaged = options && options.isPackaged;
  const resourcesPath = options && options.resourcesPath;
  const runtimeArch = options && options.runtimeArch;
  const developmentCache = options && options.developmentCache;
  if (typeof isPackaged !== 'function') throw new TypeError('isPackaged is required');
  if (typeof resourcesPath !== 'function') throw new TypeError('resourcesPath is required');
  if (typeof runtimeArch !== 'function') throw new TypeError('runtimeArch is required');
  if (!developmentCache || typeof developmentCache.ensureBinary !== 'function') {
    throw new TypeError('developmentCache.ensureBinary is required');
  }

  async function ensureBinary(request) {
    const { name, source } = request || {};
    validateHelperRequest(name, source);
    normalizeHelperLanguage(request && request.language);
    if (!isPackaged()) return developmentCache.ensureBinary(request);

    const arch = runtimeArch();
    if (arch !== 'arm64' && arch !== 'x64') {
      throw new Error(`已打包应用不支持当前 Swift helper 架构：${String(arch)}`);
    }
    const packagedPath = path.join(
      resourcesPath(),
      'native-helpers',
      helperFilename(name, source)
    );
    assertPackagedHelper(packagedPath, [arch], name, {
      allowAdditionalArchitectures: true
    });
    return packagedPath;
  }

  return { ensureBinary };
}

module.exports = {
  createSwiftBinaryCache,
  createSwiftBinaryProvider,
  isUsableBinary,
  normalizeHelperLanguage
};
