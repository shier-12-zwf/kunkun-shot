// P1-8 智能 UI 元素识别：macOS 辅助功能 API（AXUIElement）探针。
// 开发模式使用安全二进制缓存；已打包模式使用构建阶段写入 Resources 的 helper。
const swiftcache = require('./swiftcache');
const { AX_PROBE_SOURCE } = require('./swift-helper-sources');

// 查询屏幕坐标 (x, y)（全局点坐标，原点在主屏左上）处的 UI 元素 frame。
// 返回 { frame: {x,y,w,h,role,title} } 或 { error }。
async function probeAtPoint(x, y, timeoutMs) {
  const bin = await swiftcache.ensureBinary({ name: 'axprobe', source: AX_PROBE_SOURCE });
  const out = await swiftcache.runBinary(bin, [String(x), String(y)], timeoutMs || 700);
  const text = String(out).trim();
  if (!text) return { frame: null };
  try {
    return { frame: JSON.parse(text) };
  } catch (_) {
    return { error: 'AX 探针输出异常' };
  }
}

module.exports = { probeAtPoint, AX_PROBE_SOURCE };
