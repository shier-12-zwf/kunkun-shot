// 修长截图重复：把 matchOverlap 从「第一个过92%严格阈值」改为「取相似度最高的重叠(argmax)」，
// 并忽略右侧滚动条列、放宽行内阈值。只有真的几乎无重叠(滚太快)才整帧接，避免误判导致整帧重复。
const fs = require('fs');
const path = require('path');
const p = path.join(__dirname, '..', 'src', 'renderer', 'longshot', 'longshot.js');
let s = fs.readFileSync(p, 'utf8');
if (s.indexOf('scoreOverlap') >= 0) { console.log('ALREADY'); process.exit(0); }

const startAnchor = '  function matchOverlap(frameCtx, frameW, frameH) {';
const endAnchor = '  async function consumeFrame(frame) {';
const i0 = s.indexOf(startAnchor);
const i1 = s.indexOf(endAnchor);
if (i0 < 0 || i1 < 0 || i1 <= i0) { console.log('ANCHOR_MISS i0=' + i0 + ' i1=' + i1); process.exit(1); }

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
  '    // 一行内有多少比例的采样列接近，才算该行“相似”（放宽到 0.82，容忍光标/抗锯齿噪声）',
  '    const ROW_RATIO = 0.82;',
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
  '    // 给候选 overlap 打分：在重叠区抽 SEARCH_ROWS 行，算“相似行”占比',
  '    function scoreOverlap(overlap) {',
  '      let ok = 0;',
  '      let total = 0;',
  '      for (let i = 0; i < SEARCH_ROWS; i++) {',
  '        const fRow = Math.floor(((i + 0.5) / SEARCH_ROWS) * overlap);',
  '        const sRow = stitchSampleH - overlap + fRow;',
  '        if (sRow < 0 || sRow >= stitchSampleH || fRow >= stitchSampleH) continue;',
  '        total++;',
  '        if (rowSimilar(fRow, sRow)) ok++;',
  '      }',
  '      return total === 0 ? 0 : ok / total;',
  '    }',
  '    const maxOverlap = stitchSampleH;',
  '    const minOverlap = SEARCH_ROWS;',
  '    // 取相似度最高的 overlap；并列时偏向更大的 overlap（少接内容、避免重复）',
  '    let bestOv = 0;',
  '    let bestScore = 0;',
  '    for (let ov = maxOverlap; ov >= minOverlap; ov -= STEP) {',
  '      const sc = scoreOverlap(ov);',
  '      if (sc > bestScore) {',
  '        bestScore = sc;',
  '        bestOv = ov;',
  '      }',
  '    }',
  '    // 有足够相似的重叠 → 用它；否则判定为“真没重叠/滚太快”，整帧接上',
  '    if (bestScore >= 0.62 && bestOv >= minOverlap) {',
  '      return { overlap: bestOv };',
  '    }',
  '    return { overlap: 0 };',
  '  }',
  '',
  '',
].join('\n');

s = s.slice(0, i0) + fn + s.slice(i1);

// 顺手把采集间隔从 700ms 调到 500ms，让相邻帧重叠更多、更易匹配
s = s.replace('const TICK_MS = 700;', 'const TICK_MS = 500;');

fs.writeFileSync(p, s);
console.log('PATCHED');
