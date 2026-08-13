// 让「翻译」的结果面板优先出现在选区正下方（微信式），而不是默认塞到右侧。
const fs = require('fs');
const path = require('path');
const p = path.join(__dirname, '..', 'src', 'renderer', 'overlay', 'overlay.js');
let s = fs.readFileSync(p, 'utf8');
if (s.indexOf('翻译：优先放在选区正下方') >= 0) { console.log('ALREADY'); process.exit(0); }
const a = '    var x, y;\n    if (r.x + r.width + gap + w <= vw - 4) {';
if (s.indexOf(a) < 0) { console.log('MISS'); process.exit(1); }
const b = [
  '    var x, y;',
  "    if (kind === 'translate') {",
  '      // 翻译：优先放在选区正下方（微信式），放不下再往上、再退右侧',
  '      if (r.y + r.height + gap + 80 <= vh) {',
  '        x = r.x;',
  '        y = r.y + r.height + gap;',
  '      } else if (r.y - gap - 80 >= 4) {',
  '        x = r.x;',
  '        y = Math.max(4, r.y - gap - Math.min(h, Math.round(vh * 0.5)));',
  '      } else if (r.x + r.width + gap + w <= vw - 4) {',
  '        x = r.x + r.width + gap;',
  '        y = r.y;',
  '      } else {',
  '        x = r.x;',
  '        y = r.y + r.height + gap;',
  '      }',
  '    } else if (r.x + r.width + gap + w <= vw - 4) {',
].join('\n');
s = s.replace(a, b);
fs.writeFileSync(p, s);
console.log('PATCHED');
