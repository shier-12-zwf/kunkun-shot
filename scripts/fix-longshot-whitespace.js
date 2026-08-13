// 进一步修长截图：只在"有内容的行"上判定重叠，跳过纯空白行，避免留白/水印区乱匹配导致内容错位叠加。
const fs = require('fs');
const path = require('path');
const p = path.join(__dirname, '..', 'src', 'renderer', 'longshot', 'longshot.js');
let s = fs.readFileSync(p, 'utf8');
if (s.indexOf('isContentRow') >= 0) { console.log('ALREADY'); process.exit(0); }

const startAnchor = '  function matchOverlap(frameCtx, frameW, frameH) {';
const endAnchor = '  async function consumeFrame(frame) {';
const i0 = s.indexOf(startAnchor);
const i1 = s.indexOf(endAnchor);
if (i0 < 0 || i1 < 0 || i1 <= i0) { console.log('ANCHOR_MISS'); process.exit(1); }

const fn = [
  '  function matchOverlap(frameCtx, frameW, frameH) {',
  '    const stitchW = stitchCanvas.width;',
  '    const w = Math.min(frameW, stitchW);',
  '    // 忽略最右侧滚动条区域（约 3%），滚动条会移动、破坏匹配',
  '    const mw = Math.max(8, Math.floor(w * 0.97));',
  '    const stitchSampleH = Math.min(stitchedHeight, frameH);',
  '    if (stitchSampleH < SEARCH_ROWS) return { overlap: 0 };',
  '    const sBottom = stitchCtx.getImageData(0, stitchedHeight - stitchSampleH, w, stitchSampleH).data;',
  '    const fTop = frameCtx.getImageData(0, 0, w, stitchSampleH).data;',
  '    const cols = [];',
  '    for (let i = 0; i < SAMPLE_COLS; i++) cols.push(Math.floor(((i + 0.5) / SAMPLE_COLS) * mw));',
  '    const ROW_RATIO = 0.82;',
  '    // 判断某帧行是否“有内容”：采样列的明暗有明显变化（纯空白/纯色行=无内容，不参与判定）',
  '    function isContentRow(fRow) {',
  '      let lo = 255;',
  '      let hi = 0;',
  '      const base = fRow * w * 4;',
  '      for (let k = 0; k < cols.length; k++) {',
  '        const v = fTop[base + cols[k] * 4];',
  '        if (v < lo) lo = v;',
  '        if (v > hi) hi = v;',
  '      }',
  '      return hi - lo > 24;',
  '    }',
  '    function rowSimilar(fRow, sRow) {',
  '      let same = 0;',
  '      const fBase = fRow * w * 4;',
  '      const sBase = sRow * w * 4;',
  '      for (let k = 0; k < cols.length; k++) {',
  '        const x4 = cols[k] * 4;',
  '        const fi = fBase + x4;',
  '        const si = sBase + x4;',
  '        if (',
  '          Math.abs(fTop[fi] - sBottom[si]) <= MATCH_TOL &&',
  '          Math.abs(fTop[fi + 1] - sBottom[si + 1]) <= MATCH_TOL &&',
  '          Math.abs(fTop[fi + 2] - sBottom[si + 2]) <= MATCH_TOL',
  '        ) same++;',
  '      }',
  '      return same / cols.length >= ROW_RATIO;',
  '    }',
  '    // 只在“内容行”上判定重叠相似度；重叠区几乎全是空白行则判为无法判定(-1)',
  '    function scoreOverlap(overlap) {',
  '      let ok = 0;',
  '      let content = 0;',
  '      for (let i = 0; i < SEARCH_ROWS; i++) {',
  '        const fRow = Math.floor(((i + 0.5) / SEARCH_ROWS) * overlap);',
  '        const sRow = stitchSampleH - overlap + fRow;',
  '        if (sRow < 0 || sRow >= stitchSampleH || fRow >= stitchSampleH) continue;',
  '        if (!isContentRow(fRow)) continue;',
  '        content++;',
  '        if (rowSimilar(fRow, sRow)) ok++;',
  '      }',
  '      if (content < 2) return -1;',
  '      return ok / content;',
  '    }',
  '    const maxOverlap = stitchSampleH;',
  '    const minOverlap = SEARCH_ROWS;',
  '    // 取“内容行相似度”最高的 overlap；并列偏向更大 overlap（少接、避免重复）',
  '    let bestOv = 0;',
  '    let bestScore = 0;',
  '    let anyContent = false;',
  '    for (let ov = maxOverlap; ov >= minOverlap; ov -= STEP) {',
  '      const sc = scoreOverlap(ov);',
  '      if (sc < 0) continue;',
  '      anyContent = true;',
  '      if (sc > bestScore) {',
  '        bestScore = sc;',
  '        bestOv = ov;',
  '      }',
  '    }',
  '    if (anyContent && bestScore >= 0.62 && bestOv >= minOverlap) {',
  '      return { overlap: bestOv };',
  '    }',
  '    // 搜索区几乎全空白 → 无法靠像素判定，整帧接上（此时重复的只会是空白，肉眼看不出）',
  '    return { overlap: 0 };',
  '  }',
  '',
  '',
].join('\n');

s = s.slice(0, i0) + fn + s.slice(i1);
fs.writeFileSync(p, s);
console.log('PATCHED');
