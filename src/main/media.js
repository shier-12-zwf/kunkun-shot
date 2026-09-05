// 媒体处理：保存图片、保存录屏、webm -> gif 转换（ffmpeg）。
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const tempFiles = require('./temp-files');

const COMMON_FFMPEG_PATHS = Object.freeze([
  '/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg',
  '/usr/local/opt/ffmpeg-full/bin/ffmpeg',
  '/opt/homebrew/bin/ffmpeg',
  '/usr/local/bin/ffmpeg',
  '/opt/local/bin/ffmpeg',
  '/usr/bin/ffmpeg',
]);

const FFMPEG_INSTALL_MESSAGE = [
  '未找到可执行的系统 FFmpeg。',
  'PNG、JPEG、PDF 和未剪辑 WebM 可直接保存；MP4、GIF、WebP、BMP、AVIF 或剪辑录屏需要 FFmpeg。',
  '请先在终端运行“brew install ffmpeg”，然后完全退出并重新打开困困截图工具；',
  '若所装版本缺少 WebP/AVIF 编码器，可安装 ffmpeg-full，或用 KUNKUN_SHOT_FFMPEG_PATH 指定其他系统 FFmpeg。',
].join('');

function isExecutableFile(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return fs.statSync(filePath).isFile();
  } catch (_) {
    return false;
  }
}

// 正式安装包不再携带来源不明或标记为 nonfree 的 FFmpeg 二进制。优先使用用户显式
// 指定的绝对路径，再检查当前进程 PATH、用户级常见路径和 macOS 包管理器路径。
// Finder 启动的应用往往拿不到 shell PATH，因此常见绝对路径必须单独列出。
function resolveFfmpeg(options) {
  const opts = options && typeof options === 'object' ? options : {};
  const env = opts.env && typeof opts.env === 'object' ? opts.env : process.env;
  const commonPaths = Array.isArray(opts.commonPaths) ? opts.commonPaths : COMMON_FFMPEG_PATHS;
  const executableCheck = typeof opts.isExecutable === 'function' ? opts.isExecutable : isExecutableFile;
  const candidates = [];
  const explicit = typeof env.KUNKUN_SHOT_FFMPEG_PATH === 'string'
    ? env.KUNKUN_SHOT_FFMPEG_PATH.trim()
    : '';
  if (explicit && path.isAbsolute(explicit)) candidates.push(explicit);
  const pathValue = typeof env.PATH === 'string' ? env.PATH : '';
  for (const directory of pathValue.split(path.delimiter)) {
    if (!directory || !path.isAbsolute(directory)) continue;
    candidates.push(path.join(directory, 'ffmpeg'));
  }
  // Finder 启动的应用通常拿不到 shell 的 ~/.local/bin；显式补上用户级常见路径。
  candidates.push(path.join(os.homedir(), '.local', 'bin', 'ffmpeg'));
  candidates.push(...commonPaths);
  const seen = new Set();
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || !path.isAbsolute(candidate)) continue;
    const normalized = path.normalize(candidate);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    if (executableCheck(normalized)) return normalized;
  }
  return null;
}

function resolveRecordingExportMode(requestedGif, ffmpegPath) {
  const gifRequested = !!requestedGif;
  const available = ffmpegPath === undefined ? !!resolveFfmpeg() : !!ffmpegPath;
  return {
    wantGif: gifRequested && available,
    fallbackToWebm: gifRequested && !available,
  };
}

function resolveRecordingExportTarget(filePath, wantGif, ffmpegPath) {
  if (typeof filePath !== 'string' || !filePath.trim() || filePath.includes('\0')) {
    throw new Error('录屏保存路径无效。');
  }
  const available = !!ffmpegPath;
  const defaultFormat = wantGif ? 'gif' : 'webm';
  const extension = path.extname(filePath).toLowerCase();
  const outputPath = extension ? filePath : `${filePath}.${defaultFormat}`;
  const format = extension ? extension.slice(1) : defaultFormat;

  if (wantGif) {
    if (!available) throw new Error(FFMPEG_INSTALL_MESSAGE);
    if (format !== 'gif') throw new Error('GIF 录屏只能保存为 .gif 文件。');
    return { outputPath, format: 'gif' };
  }
  if (format === 'webm') return { outputPath, format: 'webm' };
  if (format === 'mp4') {
    if (!available) throw new Error(`保存 MP4 需要系统 FFmpeg。${FFMPEG_INSTALL_MESSAGE}`);
    return { outputPath, format: 'mp4' };
  }
  throw new Error(available
    ? '录屏仅支持 .webm 或 .mp4 目标文件；GIF 请在录屏设置中开启。'
    : `未找到系统 FFmpeg 时，录屏只能保存为 .webm 文件。${FFMPEG_INSTALL_MESSAGE}`);
}

function formatFfmpegFailure(failureLabel, code, stderr) {
  const detail = String(stderr || '').slice(-500);
  const unknown = /Unknown encoder\s+['"]?([^'"\s]+)/i.exec(detail);
  if (unknown) {
    return `${failureLabel}（当前系统 FFmpeg 缺少 ${unknown[1]} 编码器）。`
      + '请安装带所需编码器的 FFmpeg（WebP/AVIF 可尝试“brew install ffmpeg-full”），'
      + `或用 KUNKUN_SHOT_FFMPEG_PATH 指定可用版本。原始退出码：${code}。`;
  }
  return `${failureLabel}（ffmpeg 退出码 ${code}）：${detail}`;
}

function dataURLToBuffer(dataURL) {
  const comma = dataURL.indexOf(',');
  const b64 = comma >= 0 ? dataURL.slice(comma + 1) : dataURL;
  return Buffer.from(b64, 'base64');
}

function createStagingPath(outputPath) {
  const parent = path.dirname(outputPath);
  fs.mkdirSync(parent, { recursive: true });
  const ext = path.extname(outputPath);
  const stage = path.join(parent, `.kkshot-${process.pid}-${crypto.randomBytes(8).toString('hex')}.tmp${ext}`);
  const fd = fs.openSync(stage, 'wx', 0o600);
  fs.closeSync(fd);
  return stage;
}

function commitStagingFile(stage, outputPath) {
  const stat = fs.statSync(stage);
  if (!stat.isFile() || stat.size <= 0) throw new Error('输出文件为空。');
  const fd = fs.openSync(stage, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(stage, outputPath);
  try { fs.chmodSync(outputPath, 0o600); } catch (_) {}
  return outputPath;
}

function cleanupStage(stage) {
  try { if (stage) fs.unlinkSync(stage); } catch (_) {}
}

function saveImageFile(dataURL, filePath) {
  const stage = createStagingPath(filePath);
  try {
    fs.writeFileSync(stage, dataURLToBuffer(dataURL), { mode: 0o600 });
    return commitStagingFile(stage, filePath);
  } catch (err) {
    cleanupStage(stage);
    throw err;
  }
}

// 把一段录屏 buffer 写到临时 webm 文件
function writeTempRecording(buffer, ext) {
  return tempFiles.writePrivateTempFile(Buffer.from(buffer), 'kkshot-rec', ext || 'webm');
}

function copyFileAtomic(inputPath, outputPath) {
  const stage = createStagingPath(outputPath);
  try {
    fs.copyFileSync(inputPath, stage);
    return commitStagingFile(stage, outputPath);
  } catch (err) {
    cleanupStage(stage);
    throw err;
  }
}

function runFfmpegAtomic(outputPath, makeArgs, failureLabel, runtime) {
  return new Promise((resolve, reject) => {
    const runtimeOptions = runtime && typeof runtime === 'object' ? runtime : {};
    const findFfmpeg = typeof runtimeOptions.resolveFfmpeg === 'function'
      ? runtimeOptions.resolveFfmpeg
      : resolveFfmpeg;
    const spawnProcess = typeof runtimeOptions.spawn === 'function' ? runtimeOptions.spawn : spawn;
    const ffmpeg = findFfmpeg();
    if (!ffmpeg) {
      reject(new Error(FFMPEG_INSTALL_MESSAGE));
      return;
    }
    let stage;
    try {
      stage = createStagingPath(outputPath);
    } catch (err) {
      reject(err);
      return;
    }
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      cleanupStage(stage);
      reject(err);
    };
    let proc;
    try {
      proc = spawnProcess(ffmpeg, makeArgs(stage));
    } catch (err) {
      fail(new Error(`ffmpeg 启动失败：${err.message}`));
      return;
    }
    let stderr = '';
    proc.stderr.on('data', (d) => {
      stderr = (stderr + d.toString()).slice(-64 * 1024);
    });
    proc.on('error', (err) => fail(new Error(`ffmpeg 启动失败：${err.message}`)));
    proc.on('close', (code) => {
      if (settled) return;
      if (code !== 0) {
        fail(new Error(formatFfmpegFailure(failureLabel, code, stderr)));
        return;
      }
      try {
        commitStagingFile(stage, outputPath);
        settled = true;
        resolve(outputPath);
      } catch (err) {
        fail(new Error(`${failureLabel}：${err.message}`));
      }
    });
  });
}

// webm/mp4 -> gif，使用 palettegen/paletteuse 提升质量
// preArgs：可选前置参数（剪辑用 ['-ss','3','-t','5']）
function convertToGif(inputPath, outputPath, fps, preArgs, runtime) {
  const rate = fps || 12;
  const vf = `fps=${rate},scale=iw:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse`;
  return runFfmpegAtomic(
    outputPath,
    (stage) => ['-y'].concat(preArgs || []).concat(['-i', inputPath, '-vf', vf, '-loop', '0', stage]),
    'GIF 转换失败',
    runtime
  );
}

// 图片格式转换（PNG 源 → JPG/WebP 等）：ffmpeg 按输出扩展名推断编码。
// extraArgs：质量参数（如 ['-q:v','3'] 或 ['-quality','85']），由调用方按格式给。
function convertImage(inputPath, outputPath, extraArgs, runtime) {
  return runFfmpegAtomic(
    outputPath,
    (stage) => ['-y', '-i', inputPath].concat(extraArgs || []).concat([stage]),
    '图片转换失败',
    runtime
  );
}

// WebM 的浏览器录制编码可能是 VP8；VP8 不能直接 `-c copy` 进 MP4。统一转成兼容性
// 更好的 H.264/yuv420p，避免用户选了 MP4 却在保存阶段失败。
function convertToMp4(inputPath, outputPath, preArgs, runtime) {
  return runFfmpegAtomic(
    outputPath,
    (stage) => ['-y'].concat(preArgs || []).concat([
      '-i', inputPath,
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '23',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-movflags', '+faststart',
      stage,
    ]),
    'MP4 转码失败',
    runtime
  );
}

module.exports = {
  dataURLToBuffer,
  saveImageFile,
  writeTempRecording,
  copyFileAtomic,
  convertToGif,
  convertImage,
  convertToMp4,
  resolveFfmpeg,
  resolveRecordingExportMode,
  resolveRecordingExportTarget,
  FFMPEG_INSTALL_MESSAGE,
};
