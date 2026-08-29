// Swift helper 二进制解析。已打包应用只允许使用 Resources/native-helpers
// 中与源码哈希、当前 CPU 架构一致的构建产物，绝不在用户机器上调用 swiftc。
// 开发模式仍保留 userData/swift-bin 内容哈希缓存，方便本地调试。
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const { app } = require('electron');
const { createSwiftBinaryCache, createSwiftBinaryProvider } = require('./swift-binary-cache');

const SWIFTC = '/usr/bin/swiftc';

function binDir() {
  const dir = path.join(app.getPath('userData'), 'swift-bin');
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (_) {}
  return dir;
}

function compileSwift(sourcePath, outputPath) {
  return new Promise((resolve, reject) => {
    execFile(SWIFTC, ['-O', sourcePath, '-o', outputPath], { timeout: 120000 }, (err) => {
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
      resolve();
    });
  });
}

const binaryCache = createSwiftBinaryCache({ cacheDir: binDir, compile: compileSwift });
const binaryProvider = createSwiftBinaryProvider({
  isPackaged: () => app.isPackaged,
  resourcesPath: () => process.resourcesPath,
  runtimeArch: () => process.arch,
  developmentCache: binaryCache
});

// 已打包模式返回包内 helper；开发模式首次调用才编译并缓存。
// 同一进程的并发请求共享编译 Promise；临时文件名包含随机后缀，避免多进程互相覆盖。
function ensureBinary({ name, source }) {
  return binaryProvider.ensureBinary({ name, source });
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
