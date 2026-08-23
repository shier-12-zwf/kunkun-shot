// App-owned temporary files. Every file lives in a newly-created 0700 directory so another
// local process cannot pre-create a symlink at the destination. Only paths created in this
// process are eligible for cleanup.
const fs = require('fs');
const os = require('os');
const path = require('path');

const ownedDirs = new Set();

function safePart(value, fallback) {
  const cleaned = String(value || '').toLowerCase().replace(/[^a-z0-9-]/g, '');
  return cleaned || fallback;
}

function createPrivateTempPath(prefix, ext) {
  const safePrefix = safePart(prefix, 'kkshot');
  const safeExt = safePart(ext, 'tmp');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${safePrefix}-`));
  fs.chmodSync(dir, 0o700);
  ownedDirs.add(path.resolve(dir));
  return path.join(dir, `payload.${safeExt}`);
}

function writePrivateTempFile(data, prefix, ext) {
  const file = createPrivateTempPath(prefix, ext);
  let fd = null;
  try {
    fd = fs.openSync(file, 'wx', 0o600);
    fs.writeFileSync(fd, data);
    fs.closeSync(fd);
    fd = null;
    return file;
  } catch (err) {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch (_) {}
    }
    cleanupTempPath(file);
    throw err;
  }
}

function cleanupTempPath(file) {
  if (typeof file !== 'string' || !file) return false;
  const dir = path.resolve(path.dirname(file));
  if (!ownedDirs.has(dir)) return false;
  try { fs.unlinkSync(path.resolve(file)); } catch (_) {}
  try { fs.rmdirSync(dir); } catch (_) {}
  ownedDirs.delete(dir);
  return true;
}

function scheduleCleanup(file, delayMs) {
  const timer = setTimeout(() => cleanupTempPath(file), Math.max(1000, Number(delayMs) || 60_000));
  if (timer && typeof timer.unref === 'function') timer.unref();
  return timer;
}

function cleanupAll() {
  for (const dir of [...ownedDirs]) {
    try {
      for (const name of fs.readdirSync(dir)) {
        const candidate = path.join(dir, name);
        try { fs.unlinkSync(candidate); } catch (_) {}
      }
      fs.rmdirSync(dir);
      ownedDirs.delete(dir);
    } catch (_) {}
  }
}

module.exports = {
  createPrivateTempPath,
  writePrivateTempFile,
  cleanupTempPath,
  scheduleCleanup,
  cleanupAll,
};
