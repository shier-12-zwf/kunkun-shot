'use strict';

// desktopCapturer source order is not an API contract. On some macOS releases
// display_id is empty, so matching sources[displayIndex] can silently capture a
// different monitor after hot-plugging or source reordering. Keep the fallback
// rules deterministic and fail closed when the target cannot be identified.

function parseScreenSourceIndex(sourceId) {
  if (typeof sourceId !== 'string') return null;
  const match = /^screen:(\d+):/i.exec(sourceId);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) ? value : null;
}

function sourceThumbnailRatio(source) {
  try {
    if (!source || !source.thumbnail || typeof source.thumbnail.getSize !== 'function') return null;
    const size = source.thumbnail.getSize();
    const width = Number(size && size.width);
    const height = Number(size && size.height);
    if (!(width > 0) || !(height > 0)) return null;
    return width / height;
  } catch (_) {
    return null;
  }
}

function displayRatio(display) {
  const size = display && (display.size || display.bounds);
  const width = Number(size && size.width);
  const height = Number(size && size.height);
  return width > 0 && height > 0 ? width / height : null;
}

function exactlyOne(items) {
  return items.length === 1 ? items[0] : null;
}

function selectDisplaySource(sources, display, displays) {
  const list = Array.isArray(sources) ? sources.filter(Boolean) : [];
  if (!list.length) throw new Error('未获取到屏幕源。');
  if (!display || display.id == null) throw new Error('目标显示器无效。');

  const targetId = String(display.id);
  const direct = exactlyOne(list.filter((source) => {
    return source.display_id != null && String(source.display_id) !== '' && String(source.display_id) === targetId;
  }));
  if (direct) return direct;
  if (list.length === 1) return list[0];

  const orderedDisplays = Array.isArray(displays) ? displays : [];
  const targetIndex = orderedDisplays.findIndex((candidate) => candidate && String(candidate.id) === targetId);
  const parsed = list.map((source) => ({ source, index: parseScreenSourceIndex(source.id) }));

  // Chromium may encode either the platform display id or its zero-based screen
  // index in screen:<number>:<number>. Prefer an unambiguous platform-id match,
  // then the index corresponding to Electron's display list.
  const encodedId = exactlyOne(parsed.filter((item) => item.index !== null && String(item.index) === targetId));
  if (encodedId) return encodedId.source;
  if (targetIndex >= 0) {
    const encodedIndex = exactlyOne(parsed.filter((item) => item.index === targetIndex));
    if (encodedIndex) return encodedIndex.source;
  }

  // A source thumbnail normally preserves the display aspect ratio. Only use it
  // when the best candidate is close and clearly separated from the runner-up;
  // identical-size monitors remain intentionally ambiguous.
  const expectedRatio = displayRatio(display);
  if (expectedRatio) {
    const ranked = list
      .map((source) => {
        const ratio = sourceThumbnailRatio(source);
        return ratio ? { source, error: Math.abs(Math.log(ratio / expectedRatio)) } : null;
      })
      .filter(Boolean)
      .sort((a, b) => a.error - b.error);
    if (
      ranked.length &&
      ranked[0].error <= 0.015 &&
      (ranked.length === 1 || ranked[1].error - ranked[0].error >= 0.01)
    ) return ranked[0].source;
  }

  throw new Error('无法可靠匹配目标显示器；请重试或重新连接显示器。');
}

function serializeCaptureSources(sources) {
  return (Array.isArray(sources) ? sources : []).filter(Boolean).map((source) => ({
    id: source.id,
    name: source.name,
    display_id: source.display_id,
    screen_index: parseScreenSourceIndex(source.id),
  }));
}

module.exports = {
  parseScreenSourceIndex,
  selectDisplaySource,
  serializeCaptureSources,
};
