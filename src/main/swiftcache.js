// Swift 源码 → 预编译二进制缓存（P2-7/P1-8 共用）。
// 解决两个问题：①swift 解释执行每次数秒编译；②H3 要求脚本不落可预测固定路径。
// 方案：编译产物放 userData/swift-bin/<name>-<contentHash>（0700 目录），内容哈希命名
// （源码变了自然换新二进制），首次用时 swiftc -O 编译，之后直接复用。
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { app } = require('electron');

const SWIFTC = '/usr/bin/swiftc';

function binDir() {
  const dir = path.join(app.getPath('userData'), 'swift-bin');
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (_) {}
  return dir;
}

// 返回已编译二进制路径；首次调用会编译（秒级~十几秒）。
function ensureBinary({ name, source }) {
  return new Promise((resolve, reject) => {
    let hash;
    try {
      hash = crypto.createHash('sha256').update(source).digest('hex').slice(0, 16);
    } catch (_) {
      reject(new Error('哈希计算失败'));
      return;
    }
    const dir = binDir();
    const bin = path.join(dir, `${name}-${hash}`);
    if (fs.existsSync(bin)) {
      resolve(bin);
      return;
    }
    const tmpSrc = path.join(dir, `${name}-${hash}.swift`);
    const tmpBin = bin + '.tmp';
    try {
      fs.writeFileSync(tmpSrc, source, { encoding: 'utf8', mode: 0o600 });
    } catch (e) {
      reject(new Error('写入源码失败：' + (e && e.message)));
      return;
    }
    execFile(SWIFTC, ['-O', tmpSrc, '-o', tmpBin], { timeout: 120000 }, (err) => {
      try {
        fs.unlinkSync(tmpSrc);
      } catch (_) {}
      if (err) {
        const raw = String((err && err.message) || err || '');
        // 已知系统问题：CLT 与 SDK 的 SwiftBridging modulemap 冲突（macOS 更新后常见）
        if (raw.indexOf('SwiftBridging') >= 0) {
          reject(
            new Error(
              'Swift 工具链异常（SwiftBridging 模块冲突）。请重装命令行工具后重试：' +
                '终端执行 `sudo rm -rf /Library/Developer/CommandLineTools && xcode-select --install`，' +
                '完成后重启本应用。'
            )
          );
        } else {
          reject(new Error('swiftc 编译失败：' + raw));
        }
        return;
      }
      try {
        fs.renameSync(tmpBin, bin);
      } catch (_) {}
      resolve(bin);
    });
  });
}

// 跑二进制并收集 stdout（带超时，超时 kill 进程）
function runBinary(binPath, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const proc = execFile(binPath, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error((stderr && stderr.trim()) || (err && err.message) || '执行失败'));
        return;
      }
      resolve(String(stdout || ''));
    });
    // execFile 的 timeout 参数已带 kill 语义；保险起见再挂一层
    const t = setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch (_) {}
    }, timeoutMs + 500);
    proc.on('close', () => clearTimeout(t));
  });
}

module.exports = { ensureBinary, runBinary };
