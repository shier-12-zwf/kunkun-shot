// Vision OCR：用 macOS Vision 框架识别图中文字（每行文字 + 百分比边界框）。
// 开发模式使用安全二进制缓存；已打包模式使用构建阶段写入 Resources 的 helper。
const path = require('path');
const fs = require('fs');
const os = require('os');
const swiftcache = require('./swiftcache');
const { VISION_BOXES_SOURCE } = require('./swift-helper-sources');

// 每次识别一个随机临时目录：路径不可预测，防脚本种毒与符号链接劫持；0700 仅本用户可进。
function makeWorkDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kk-shot-ocr-'));
  try {
    fs.chmodSync(dir, 0o700);
  } catch (_) {}
  return dir;
}

function randomName(prefix, ext) {
  return prefix + '-' + Date.now() + '-' + Math.floor(Math.random() * 1e9).toString(36) + '.' + ext;
}

function dataURLToFile(dataURL, workDir) {
  const m = /^data:image\/(\w+);base64,([\s\S]*)$/.exec(String(dataURL || ''));
  let ext = m ? m[1] : 'png';
  const b64 = m ? m[2] : String(dataURL || '').replace(/^data:[^,]*,/, '');
  // ext 理论上已被正则 \w+ 约束，仍做白名单兜底，杜绝任何路径分隔符进入文件名。
  if (!/^[a-z0-9]+$/i.test(ext)) ext = 'png';
  const p = path.join(workDir, randomName('shot', ext));
  fs.writeFileSync(p, Buffer.from(b64, 'base64'), { mode: 0o600 });
  return p;
}

// 删除整个工作目录，失败不抛。
function cleanup(workDir) {
  if (!workDir) return;
  try {
    for (const f of fs.readdirSync(workDir)) {
      try {
        fs.unlinkSync(path.join(workDir, f));
      } catch (_) {}
    }
    fs.rmdirSync(workDir);
  } catch (_) {}
}

// 返回 { lines: [{t,x,y,w,h}] } 或 { error: '...' }
async function runOCRBoxes(dataURL) {
  let workDir = null;
  try {
    workDir = makeWorkDir();
    const imgPath = dataURLToFile(dataURL, workDir);
    const bin = await swiftcache.ensureBinary({
      name: 'vision-boxes',
      source: VISION_BOXES_SOURCE
    });
    const stdout = await swiftcache.runBinary(bin, [imgPath], 30000);
    cleanup(workDir);
    workDir = null;
    try {
      const arr = JSON.parse(String(stdout || '[]').trim());
      const lines = Array.isArray(arr)
        ? arr
            .filter((it) => it && it.t && String(it.t).trim())
            .map((it) => ({
              t: String(it.t),
              x: Number(it.x),
              y: Number(it.y),
              w: Number(it.w),
              h: Number(it.h)
            }))
            .filter((it) => [it.x, it.y, it.w, it.h].every((n) => !isNaN(n)))
        : [];
      return { lines };
    } catch (e) {
      return { error: '解析 Vision 结果失败：' + (e && e.message ? e.message : e) };
    }
  } catch (e) {
    cleanup(workDir);
    return { error: 'Vision OCR 失败：' + (e && e.message ? e.message : e) };
  }
}

module.exports = { runOCRBoxes };
