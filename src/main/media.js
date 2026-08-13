// 媒体处理：保存图片、保存录屏、webm -> gif 转换（ffmpeg）。
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

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

function saveImageFile(dataURL, filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, dataURLToBuffer(dataURL));
  return filePath;
}

// 把一段录屏 buffer 写到临时 webm 文件
function writeTempRecording(buffer, ext) {
  const tmp = path.join(os.tmpdir(), `kkshot-rec-${Date.now()}.${ext || 'webm'}`);
  fs.writeFileSync(tmp, Buffer.from(buffer));
  return tmp;
}

// webm/mp4 -> gif，使用 palettegen/paletteuse 提升质量
function convertToGif(inputPath, outputPath, fps) {
  return new Promise((resolve, reject) => {
    const ffmpeg = resolveFfmpeg();
    const rate = fps || 12;
    const vf = `fps=${rate},scale=iw:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse`;
    const args = ['-y', '-i', inputPath, '-vf', vf, '-loop', '0', outputPath];
    const proc = spawn(ffmpeg, args);
    let stderr = '';
    proc.stderr.on('data', (d) => (stderr += d.toString()));
    proc.on('error', (e) => reject(new Error(`ffmpeg 启动失败：${e.message}`)));
    proc.on('close', (code) => {
      if (code === 0) resolve(outputPath);
      else reject(new Error(`ffmpeg 退出码 ${code}：${stderr.slice(-500)}`));
    });
  });
}

module.exports = { dataURLToBuffer, saveImageFile, writeTempRecording, convertToGif, resolveFfmpeg };
