// 让开发版(electron .)也在 Dock 显示自定义图标（mac）。打包版本来就有图标，这里有 isEmpty 守卫，安全。
const fs = require('fs');
const path = require('path');
const p = path.join(__dirname, '..', 'src', 'main', 'main.js');
let s = fs.readFileSync(p, 'utf8');
if (s.indexOf('app.dock.setIcon') >= 0) { console.log('ALREADY'); process.exit(0); }
const a = '    config.get();\n    registerIpc();';
if (s.indexOf(a) < 0) { console.log('MISS'); process.exit(1); }
const b = [
  '    config.get();',
  "    if (process.platform === 'darwin' && app.dock) {",
  '      try {',
  "        const _ic = nativeImage.createFromPath(path.join(__dirname, '..', '..', 'build', 'icon.png'));",
  '        if (!_ic.isEmpty()) app.dock.setIcon(_ic);',
  '      } catch (_) {}',
  '    }',
  '    registerIpc();',
].join('\n');
s = s.replace(a, b);
fs.writeFileSync(p, s);
console.log('PATCHED');
