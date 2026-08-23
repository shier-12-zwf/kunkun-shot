// 媒体处理：保存图片、保存录屏、webm -> gif 转换（ffmpeg）。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const tempFiles = require('./temp-files');

// 解析 ffmpeg 可执行路径：优先 ffmpeg-static（随包），否则退回系统 ffmpeg。
function resolveFfmpeg() {
  try {
    let p = require('ffmpeg-static');
    if (p) {
      // 打包后 ffmpeg-static 的二进制被压进 app.asar，spawn 无法执行 asar 内文件；
      // electron-builder 通过 asarUnpack 把它解到 app.asar.unpacked，这里把路径改指向解包副本。
      if (p.includes('app.asar') && !p.includes('app.asar.unpacked')) {
        p = p.replace('app.asar', 'app.asar.unpacked');
      }
      if (fs.existsSync(p)) return p;
    }
  } catch (_) {}
  return 'ffmpeg';
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

function runFfmpegAtomic(outputPath, makeArgs, failureLabel) {
  return new Promise((resolve, reject) => {
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
      proc = spawn(resolveFfmpeg(), makeArgs(stage));
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
        fail(new Error(`${failureLabel}（ffmpeg 退出码 ${code}）：${stderr.slice(-500)}`));
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
function convertToGif(inputPath, outputPath, fps, preArgs) {
  const rate = fps || 12;
  const vf = `fps=${rate},scale=iw:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse`;
  return runFfmpegAtomic(
    outputPath,
    (stage) => ['-y'].concat(preArgs || []).concat(['-i', inputPath, '-vf', vf, '-loop', '0', stage]),
    'GIF 转换失败'
  );
}

// 图片格式转换（PNG 源 → JPG/WebP 等）：ffmpeg 按输出扩展名推断编码。
// extraArgs：质量参数（如 ['-q:v','3'] 或 ['-quality','85']），由调用方按格式给。
function convertImage(inputPath, outputPath, extraArgs) {
  return runFfmpegAtomic(
    outputPath,
    (stage) => ['-y', '-i', inputPath].concat(extraArgs || []).concat([stage]),
    '图片转换失败'
  );
}

// WebM 的浏览器录制编码可能是 VP8；VP8 不能直接 `-c copy` 进 MP4。统一转成兼容性
// 更好的 H.264/yuv420p，避免用户选了 MP4 却在保存阶段失败。
function convertToMp4(inputPath, outputPath, preArgs) {
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
    'MP4 转码失败'
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
};
