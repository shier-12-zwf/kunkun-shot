// Vision OCR：用 macOS 自带 swift + Vision 框架识别图中文字（每行文字 + 百分比边界框）。
// 本地、免费、坐标精准，专供「原位覆盖翻译」和「贴图内选字」用。返回坐标为相对整图百分比(0~100)、原点左上。
//
// H3 修复说明（2026-08-13）：
// 旧实现把 swift 脚本缓存到固定路径 /tmp/kk-shot-ocr/vision-boxes.swift，同用户的其他进程
// 可预先种入恶意 .swift，本应用下次识别时会以用户身份执行；固定目录名还可被符号链接劫持。
// 现改为：每次识别新建「随机名 + 0700 权限」的临时目录，脚本/图片用随机名写入（0600），
// 识别结束（无论成败）立即整体删除，不留任何可预测路径。
const path = require('path');
const fs = require('fs');
const os = require('os');
const swiftcache = require('./swiftcache');

const SWIFT_SOURCE = [
  'import Foundation',
  'import Vision',
  'import AppKit',
  '',
  'let args = CommandLine.arguments',
  'guard args.count > 1 else { exit(2) }',
  'let imgPath = args[1]',
  'guard let img = NSImage(contentsOfFile: imgPath),',
  '      let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else {',
  '  FileHandle.standardError.write("load-failed".data(using: .utf8)!)',
  '  exit(3)',
  '}',
  'let req = VNRecognizeTextRequest()',
  'req.recognitionLevel = .accurate',
  'req.usesLanguageCorrection = true',
  'req.recognitionLanguages = ["zh-Hans","zh-Hant","en-US","ja","ko"]',
  'let handler = VNImageRequestHandler(cgImage: cg, options: [:])',
  'do {',
  '  try handler.perform([req])',
  '  guard let obs = req.results as? [VNRecognizedTextObservation] else { print("[]"); exit(0) }',
  '  var out: [[String: Any]] = []',
  '  for o in obs {',
  '    guard let cand = o.topCandidates(1).first else { continue }',
  '    let b = o.boundingBox',
  '    out.append([',
  '      "t": cand.string,',
  '      "x": Double(b.minX) * 100.0,',
  '      "y": (1.0 - Double(b.maxY)) * 100.0,',
  '      "w": Double(b.width) * 100.0,',
  '      "h": Double(b.height) * 100.0',
  '    ])',
  '  }',
  '  let data = try JSONSerialization.data(withJSONObject: out, options: [])',
  '  print(String(data: data, encoding: .utf8) ?? "[]")',
  '} catch {',
  '  FileHandle.standardError.write("ocr-failed".data(using: .utf8)!)',
  '  exit(4)',
  '}',
  '',
].join('\n');

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
  // ext 理论上已被正则 \w+ 约束，仍做白名单兜底，杜绝任何路径分隔符进入文件名
  if (!/^[a-z0-9]+$/i.test(ext)) ext = 'png';
  const p = path.join(workDir, randomName('shot', ext));
  fs.writeFileSync(p, Buffer.from(b64, 'base64'), { mode: 0o600 });
  return p;
}

// 删除整个工作目录（脚本 + 图片 + 目录本身），失败不抛。
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
    // P2-7(B3)：swiftc 预编译缓存（userData/swift-bin，内容哈希命名），
    // 首次约 10 秒编译，之后每回几十毫秒——原位翻译/贴图选字不再每次等数秒。
    const bin = await swiftcache.ensureBinary({ name: 'vision-boxes', source: SWIFT_SOURCE });
    const stdout = await swiftcache.runBinary(bin, [imgPath], 30000);
    cleanup(workDir); // 无论成败，识别结束后立即清除临时图片
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
              h: Number(it.h),
            }))
            .filter((it) => [it.x, it.y, it.w, it.h].every((n) => !isNaN(n)))
        : [];
      return { lines: lines };
    } catch (e) {
      return { error: '解析 Vision 结果失败：' + (e && e.message ? e.message : e) };
    }
  } catch (e) {
    cleanup(workDir);
    return { error: 'Vision OCR 失败：' + (e && e.message ? e.message : e) };
  }
}

module.exports = { runOCRBoxes };
