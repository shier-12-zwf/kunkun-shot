// macOS 通用剪贴板的无损快照/恢复。
// Electron 的 writeText/writeImage 只能恢复单一表示；Finder 文件、RTF/HTML、PDF 和应用自定义
// pasteboard type 会因此丢失。JXA helper 通过 AppKit 枚举每个 NSPasteboardItem 的全部 type/data，
// 不依赖 Xcode/Swift 工具链；快照存进进程自有的 0700 临时目录，恢复后立即销毁。
const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');
const tempFiles = require('./temp-files');

const COPY_SCRIPT = 'tell application "System Events" to keystroke "c" using command down';
const COPY_TIMEOUT_MS = 1500;

function resolveHelperPath(baseDir = __dirname) {
  let helperPath = path.join(baseDir, 'pasteboard-preserver.jxa');
  // 外部 osascript 无法读取 ASAR 虚拟路径。electron-builder 按 asarUnpack
  // 将该脚本放在相邻的 app.asar.unpacked 目录，因此打包后显式改指向解包副本。
  if (helperPath.includes('app.asar') && !helperPath.includes('app.asar.unpacked')) {
    helperPath = helperPath.replace('app.asar', 'app.asar.unpacked');
  }
  return helperPath;
}

const HELPER_PATH = resolveHelperPath();

// 模拟 Cmd+C 必须有确定的退出路径：辅助功能服务或 osascript 异常时，子进程可能既不 close
// 也不 error。超时强杀，同时接受 AbortSignal 供调用方主动终止；所有路径只 settle 一次。
function simulateCopy({ timeoutMs = COPY_TIMEOUT_MS, signal, spawnImpl = spawn } = {}) {
  const boundedTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : COPY_TIMEOUT_MS;
  return new Promise((resolve) => {
    if (signal && signal.aborted) {
      resolve(false);
      return;
    }

    let child = null;
    let timer = null;
    let settled = false;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      if (child && typeof child.removeListener === 'function') {
        child.removeListener('error', onError);
        child.removeListener('close', onClose);
      }
    };
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(ok);
    };
    const terminate = (killSignal) => {
      try {
        if (child && !child.killed && typeof child.kill === 'function') child.kill(killSignal);
      } catch (_) {}
      finish(false);
    };
    const onAbort = () => terminate('SIGTERM');
    const onError = () => finish(false);
    const onClose = (code) => finish(code === 0);

    try {
      child = spawnImpl('/usr/bin/osascript', ['-e', COPY_SCRIPT], { stdio: 'ignore' });
    } catch (_) {
      finish(false);
      return;
    }
    if (!child || typeof child.once !== 'function') {
      terminate('SIGKILL');
      return;
    }

    child.once('error', onError);
    child.once('close', onClose);
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => terminate('SIGKILL'), boundedTimeout);
  });
}

function runHelper(action, file) {
  const extraArgs = Array.prototype.slice.call(arguments, 2).map(String);
  return new Promise((resolve, reject) => {
    const args = ['-l', 'JavaScript', HELPER_PATH, action];
    if (file !== undefined) args.push(String(file));
    args.push(...extraArgs);
    execFile(
      '/usr/bin/osascript',
      args,
      { timeout: 5000, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error((stderr && stderr.trim()) || err.message || 'AppKit 剪贴板辅助程序执行失败'));
          return;
        }
        resolve(String(stdout || '').trim());
      }
    );
  });
}

function parseHelperReport(output, action) {
  try {
    const report = JSON.parse(output);
    if (!report || typeof report !== 'object') throw new Error('结果不是对象');
    return report;
  } catch (err) {
    throw new Error(`${action} 返回了无效结果：${(err && err.message) || String(err)}`);
  }
}

function requireChangeCount(value) {
  if (!Number.isInteger(value)) throw new Error('剪贴板辅助程序返回了无效代际');
  return value;
}

function snapshotFile(snapshotRecord) {
  const file = typeof snapshotRecord === 'string' ? snapshotRecord : snapshotRecord && snapshotRecord.file;
  if (typeof file !== 'string' || !file) throw new Error('剪贴板快照引用无效');
  return file;
}

async function snapshot() {
  if (process.platform !== 'darwin') throw new Error('完整剪贴板快照仅支持 macOS');
  const file = tempFiles.createPrivateTempPath('kkshot-pasteboard', 'json');
  try {
    const report = parseHelperReport(await runHelper('snapshot', file), 'snapshot');
    const changeCount = requireChangeCount(report.changeCount);
    fs.chmodSync(file, 0o600);
    return { file, changeCount };
  } catch (err) {
    tempFiles.cleanupTempPath(file);
    throw new Error('无法安全备份剪贴板，已取消划词翻译：' + ((err && err.message) || String(err)));
  }
}

async function clearIfCurrent(expectedChangeCount) {
  const expected = requireChangeCount(expectedChangeCount);
  const report = parseHelperReport(await runHelper('clear-if-current', expected), 'clear-if-current');
  return {
    started: report.started === true,
    changeCount: requireChangeCount(report.changeCount),
  };
}

async function begin() {
  const snapshotRecord = await snapshot();
  try {
    const started = await clearIfCurrent(snapshotRecord.changeCount);
    if (!started.started) {
      tempFiles.cleanupTempPath(snapshotRecord.file);
      return null;
    }
    return {
      file: snapshotRecord.file,
      originalChangeCount: snapshotRecord.changeCount,
      changeCount: started.changeCount,
    };
  } catch (err) {
    // clear-if-current 若在系统调用后异常退出，无法证明当前代际仍属于本轮；保留私有快照到进程退出，
    // 但绝不做无条件恢复。
    throw new Error('无法安全准备剪贴板，已取消划词翻译：' + ((err && err.message) || String(err)));
  }
}

async function getChangeCount() {
  const report = parseHelperReport(await runHelper('change-count'), 'change-count');
  return requireChangeCount(report.changeCount);
}

async function restore(snapshotRecord, expectedChangeCount) {
  const file = snapshotFile(snapshotRecord);
  const expected = requireChangeCount(expectedChangeCount);
  try {
    const report = parseHelperReport(await runHelper('restore', file, expected), 'restore');
    const restored = report.restored === true;
    requireChangeCount(report.changeCount);
    tempFiles.cleanupTempPath(file);
    return restored;
  } catch (err) {
    // 恢复失败时保留私有快照到本进程退出，便于仍在运行时重试/排障；绝不把内容打印到日志。
    throw new Error('剪贴板恢复失败（私有快照暂时保留）：' + ((err && err.message) || String(err)));
  }
}

module.exports = {
  begin,
  snapshot,
  clearIfCurrent,
  getChangeCount,
  restore,
  simulateCopy,
  HELPER_PATH,
  runHelper,
  resolveHelperPath,
};
