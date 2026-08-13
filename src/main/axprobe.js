// P1-8 智能 UI 元素识别：macOS 辅助功能 API（AXUIElement）探针。
// 预编译成二进制缓存（swiftcache），每次查询 ~几十毫秒，可支撑悬停节流探测。
const swiftcache = require('./swiftcache');

const AX_PROBE_SOURCE = [
  'import Cocoa',
  'import ApplicationServices',
  '',
  'let args = CommandLine.arguments',
  'guard args.count >= 3, let px = Double(args[1]), let py = Double(args[2]) else { exit(2) }',
  '',
  'let sys = AXUIElementCreateSystemWide()',
  'var el: AXUIElement?',
  'guard AXUIElementCopyElementAtPosition(sys, Float(px), Float(py), &el) == .success, let e = el else {',
  '  print("{}")',
  '  exit(0)',
  '}',
  '',
  'func attrStr(_ a: CFString) -> String? {',
  '  var v: CFTypeRef?',
  '  guard AXUIElementCopyAttributeValue(e, a, &v) == .success else { return nil }',
  '  return v as? String',
  '}',
  '',
  'func attrPoint() -> CGPoint {',
  '  var v: CFTypeRef?',
  '  guard AXUIElementCopyAttributeValue(e, kAXPositionAttribute as CFString, &v) == .success,',
  '        let ax = v as? AXValue else { return .zero }',
  '  var pt = CGPoint.zero',
  '  AXValueGetValue(ax, .cgPoint, &pt)',
  '  return pt',
  '}',
  '',
  'func attrSize() -> CGSize {',
  '  var v: CFTypeRef?',
  '  guard AXUIElementCopyAttributeValue(e, kAXSizeAttribute as CFString, &v) == .success,',
  '        let ax = v as? AXValue else { return .zero }',
  '  var sz = CGSize.zero',
  '  AXValueGetValue(ax, .cgSize, &sz)',
  '  return sz',
  '}',
  '',
  'let pos = attrPoint()',
  'let size = attrSize()',
  'let role = (attrStr(kAXRoleAttribute as CFString) ?? "").replacingOccurrences(of: "\\"", with: "\'")',
  'let title = (attrStr(kAXTitleAttribute as CFString) ?? "").replacingOccurrences(of: "\\"", with: "\'")',
  'print("{\\"x\\":\\(pos.x),\\"y\\":\\(pos.y),\\"w\\":\\(size.width),\\"h\\":\\(size.height),\\"role\\":\\"\\(role)\\",\\"title\\":\\"\\(title)\\"}")',
  '',
].join('\n');

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
