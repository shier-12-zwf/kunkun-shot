'use strict';

const AX_PROBE_SOURCE = [
  'import Foundation',
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
  '        let raw = v,',
  '        CFGetTypeID(raw) == AXValueGetTypeID() else { return .zero }',
  '  let ax = unsafeBitCast(raw, to: AXValue.self)',
  '  var pt = CGPoint.zero',
  '  AXValueGetValue(ax, .cgPoint, &pt)',
  '  return pt',
  '}',
  '',
  'func attrSize() -> CGSize {',
  '  var v: CFTypeRef?',
  '  guard AXUIElementCopyAttributeValue(e, kAXSizeAttribute as CFString, &v) == .success,',
  '        let raw = v,',
  '        CFGetTypeID(raw) == AXValueGetTypeID() else { return .zero }',
  '  let ax = unsafeBitCast(raw, to: AXValue.self)',
  '  var sz = CGSize.zero',
  '  AXValueGetValue(ax, .cgSize, &sz)',
  '  return sz',
  '}',
  '',
  'let pos = attrPoint()',
  'let size = attrSize()',
  'let payload: [String: Any] = [',
  '  "x": Double(pos.x),',
  '  "y": Double(pos.y),',
  '  "w": Double(size.width),',
  '  "h": Double(size.height),',
  '  "role": attrStr(kAXRoleAttribute as CFString) ?? "",',
  '  "title": attrStr(kAXTitleAttribute as CFString) ?? ""',
  ']',
  'do {',
  '  let data = try JSONSerialization.data(withJSONObject: payload, options: [])',
  '  guard let json = String(data: data, encoding: .utf8) else { exit(3) }',
  '  print(json)',
  '} catch {',
  '  FileHandle.standardError.write("json-failed".data(using: .utf8)!)',
  '  exit(3)',
  '}',
  ''
].join('\n');

const VISION_BOXES_SOURCE = [
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
  ''
].join('\n');

// Emits a bounded NDJSON stream of global mouse/key actions while recording.
// This helper is deliberately plain C/Quartz instead of Swift: it remains buildable when a
// macOS update leaves the local Swift compiler and SDK module versions temporarily mismatched.
// Ordinary unmodified text is never emitted; only named keys and explicit shortcuts are shown.
const RECORD_ACTIONS_SOURCE = String.raw`
#include <ApplicationServices/ApplicationServices.h>
#include <CoreFoundation/CoreFoundation.h>
#include <math.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>

static uint64_t sequenceNumber = 0;
static uint64_t lastDragTimestamp = 0;
static CGPoint lastDragPoint = {0, 0};
static CFMachPortRef globalEventTap = NULL;

static const char *jsonBool(bool value) { return value ? "true" : "false"; }

static void emitModifiers(CGEventFlags flags) {
  fprintf(stdout,
    "\"modifiers\":{\"alt\":%s,\"control\":%s,\"meta\":%s,\"shift\":%s}",
    jsonBool((flags & kCGEventFlagMaskAlternate) != 0),
    jsonBool((flags & kCGEventFlagMaskControl) != 0),
    jsonBool((flags & kCGEventFlagMaskCommand) != 0),
    jsonBool((flags & kCGEventFlagMaskShift) != 0));
}

static void emitMouse(const char *type, const char *button, CGEventRef event) {
  const CGPoint point = CGEventGetLocation(event);
  fprintf(stdout,
    "{\"type\":\"%s\",\"button\":\"%s\",\"x\":%.3f,\"y\":%.3f,\"seq\":%llu,",
    type, button, point.x, point.y, ++sequenceNumber);
  emitModifiers(CGEventGetFlags(event));
  fputs("}\n", stdout);
}

static void emitKey(const char *key, CGEventFlags flags) {
  fprintf(stdout, "{\"type\":\"key\",\"key\":\"%s\",\"seq\":%llu,",
    key, ++sequenceNumber);
  emitModifiers(flags);
  fputs("}\n", stdout);
}

static const char *namedKey(CGKeyCode code) {
  switch (code) {
    case 36: return "Return"; case 48: return "Tab"; case 49: return "Space";
    case 51: return "Delete"; case 53: return "Esc"; case 71: return "Clear";
    case 76: return "Enter"; case 115: return "Home"; case 116: return "PageUp";
    case 117: return "ForwardDelete"; case 119: return "End"; case 121: return "PageDown";
    case 123: return "Left"; case 124: return "Right"; case 125: return "Down";
    case 126: return "Up"; case 122: return "F1"; case 120: return "F2";
    case 99: return "F3"; case 118: return "F4"; case 96: return "F5";
    case 97: return "F6"; case 98: return "F7"; case 100: return "F8";
    case 101: return "F9"; case 109: return "F10"; case 103: return "F11";
    case 111: return "F12"; default: return NULL;
  }
}

static const char *shortcutCharacter(CGKeyCode code) {
  switch (code) {
    case 0: return "A"; case 11: return "B"; case 8: return "C";
    case 2: return "D"; case 14: return "E"; case 3: return "F";
    case 5: return "G"; case 4: return "H"; case 34: return "I";
    case 38: return "J"; case 40: return "K"; case 37: return "L";
    case 46: return "M"; case 45: return "N"; case 31: return "O";
    case 35: return "P"; case 12: return "Q"; case 15: return "R";
    case 1: return "S"; case 17: return "T"; case 32: return "U";
    case 9: return "V"; case 13: return "W"; case 7: return "X";
    case 16: return "Y"; case 6: return "Z"; case 29: return "0";
    case 18: return "1"; case 19: return "2"; case 20: return "3";
    case 21: return "4"; case 23: return "5"; case 22: return "6";
    case 26: return "7"; case 28: return "8"; case 25: return "9";
    default: return NULL;
  }
}

static const char *allowShortcutCharacter(CGKeyCode code, CGEventFlags flags) {
  const CGEventFlags explicitShortcut =
    kCGEventFlagMaskCommand | kCGEventFlagMaskControl | kCGEventFlagMaskAlternate;
  if ((flags & explicitShortcut) == 0) return NULL;
  return shortcutCharacter(code);
}

static bool shouldEmitDrag(CGEventRef event) {
  const uint64_t timestamp = CGEventGetTimestamp(event);
  const CGPoint point = CGEventGetLocation(event);
  const double distance = hypot(point.x - lastDragPoint.x, point.y - lastDragPoint.y);
  if (lastDragTimestamp != 0 && timestamp > lastDragTimestamp
      && timestamp - lastDragTimestamp < 16000000ULL && distance < 2.0) return false;
  lastDragTimestamp = timestamp;
  lastDragPoint = point;
  return true;
}

static CGEventRef handleEvent(CGEventTapProxy proxy, CGEventType type,
                              CGEventRef event, void *context) {
  (void)proxy; (void)context;
  if (type == kCGEventTapDisabledByTimeout || type == kCGEventTapDisabledByUserInput) {
    if (globalEventTap != NULL) CGEventTapEnable(globalEventTap, true);
    return event;
  }
  switch (type) {
    case kCGEventLeftMouseDown: emitMouse("mouse-down", "left", event); break;
    case kCGEventLeftMouseUp: emitMouse("mouse-up", "left", event); break;
    case kCGEventLeftMouseDragged:
      if (shouldEmitDrag(event)) emitMouse("mouse-dragged", "left", event);
      break;
    case kCGEventRightMouseDown: emitMouse("mouse-down", "right", event); break;
    case kCGEventRightMouseUp: emitMouse("mouse-up", "right", event); break;
    case kCGEventKeyDown: {
      const CGKeyCode code = (CGKeyCode)CGEventGetIntegerValueField(
        event, kCGKeyboardEventKeycode);
      const CGEventFlags flags = CGEventGetFlags(event);
      const char *key = namedKey(code);
      if (key == NULL) key = allowShortcutCharacter(code, flags);
      if (key != NULL) emitKey(key, flags);
      break;
    }
    default: break;
  }
  return event;
}

int main(void) {
  setvbuf(stdout, NULL, _IOLBF, 0);
  const CGEventMask mask = CGEventMaskBit(kCGEventLeftMouseDown)
    | CGEventMaskBit(kCGEventLeftMouseUp) | CGEventMaskBit(kCGEventLeftMouseDragged)
    | CGEventMaskBit(kCGEventRightMouseDown) | CGEventMaskBit(kCGEventRightMouseUp)
    | CGEventMaskBit(kCGEventKeyDown);
  CFMachPortRef tap = CGEventTapCreate(kCGSessionEventTap, kCGHeadInsertEventTap,
    kCGEventTapOptionListenOnly, mask, handleEvent, NULL);
  if (tap == NULL) {
    fputs("global-monitor-unavailable\n", stderr);
    return 3;
  }
  globalEventTap = tap;
  CFRunLoopSourceRef source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0);
  if (source == NULL) {
    CFRelease(tap);
    fputs("run-loop-source-unavailable\n", stderr);
    return 4;
  }
  CFRunLoopAddSource(CFRunLoopGetCurrent(), source, kCFRunLoopCommonModes);
  fputs("{\"type\":\"ready\"}\n", stdout);
  CFRunLoopRun();
  CFRunLoopRemoveSource(CFRunLoopGetCurrent(), source, kCFRunLoopCommonModes);
  CFRelease(source);
  globalEventTap = NULL;
  CFRelease(tap);
  return 0;
}
`;

const SWIFT_HELPERS = Object.freeze([
  Object.freeze({ name: 'axprobe', source: AX_PROBE_SOURCE }),
  Object.freeze({ name: 'vision-boxes', source: VISION_BOXES_SOURCE }),
  Object.freeze({ name: 'record-actions', source: RECORD_ACTIONS_SOURCE, language: 'c' })
]);

module.exports = {
  AX_PROBE_SOURCE,
  RECORD_ACTIONS_SOURCE,
  SWIFT_HELPERS,
  VISION_BOXES_SOURCE,
};
