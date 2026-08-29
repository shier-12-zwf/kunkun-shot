'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  const fd = fs.openSync(filePath, 'r');
  try {
    while (true) {
      const bytes = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (!bytes) break;
      hash.update(buffer.subarray(0, bytes));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function isMatchingRegularFile(sourcePath, destinationPath) {
  let source;
  let destination;
  try {
    source = fs.statSync(sourcePath);
    destination = fs.lstatSync(destinationPath);
  } catch (_) {
    return false;
  }
  if (!source.isFile() || source.size <= 0 || !destination.isFile() || destination.isSymbolicLink()) {
    return false;
  }
  if (source.size !== destination.size) return false;
  return sha256File(sourcePath) === sha256File(destinationPath);
}

// 用同目录临时文件原子替换缓存，并在 rename 前做内容级校验。
// 返回 true 表示已重写，false 表示目标原本就与源文件完全一致。
function ensureVerifiedCacheFile(sourcePath, destinationPath, options = {}) {
  const source = fs.statSync(sourcePath);
  if (!source.isFile() || source.size <= 0) {
    throw new Error(`缓存源文件无效：${sourcePath}`);
  }
  if (isMatchingRegularFile(sourcePath, destinationPath)) return false;

  const parent = path.dirname(destinationPath);
  fs.mkdirSync(parent, { recursive: true, mode: options.directoryMode || 0o700 });
  const stage = path.join(
    parent,
    `.${path.basename(destinationPath)}-${process.pid}-${crypto.randomBytes(6).toString('hex')}.tmp`,
  );
  let fd = null;
  try {
    fs.copyFileSync(sourcePath, stage, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(stage, options.fileMode || 0o600);
    fd = fs.openSync(stage, 'r');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    if (!isMatchingRegularFile(sourcePath, stage)) {
      throw new Error(`缓存文件内容校验失败：${destinationPath}`);
    }
    fs.renameSync(stage, destinationPath);
    return true;
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch (_) {}
    }
    try { fs.unlinkSync(stage); } catch (_) {}
  }
}

module.exports = {
  ensureVerifiedCacheFile,
  isMatchingRegularFile,
  sha256File,
};
