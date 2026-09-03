/* Editable table parsing/export helpers. This file runs in both Electron renderer and Node tests. */
(function exposeTableModel(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (root) root.KKTableModel = api;
})(typeof window !== 'undefined' ? window : globalThis, function createTableModel() {
  'use strict';

  const MAX_SOURCE_LENGTH = 1_000_000;
  const MAX_ROWS = 500;
  const MAX_COLUMNS = 100;
  const MAX_CELL_LENGTH = 10_000;

  function assertSource(source) {
    const text = String(source == null ? '' : source);
    if (text.length > MAX_SOURCE_LENGTH) throw new Error('表格结果过大，无法安全编辑。');
    return text;
  }

  function assertCell(cell) {
    const text = String(cell == null ? '' : cell);
    if (text.length > MAX_CELL_LENGTH) throw new Error('表格单元格过大，无法安全编辑。');
    return text;
  }

  function normalizeRows(inputRows) {
    if (!Array.isArray(inputRows) || inputRows.length === 0) throw new Error('没有找到可编辑的表格。');
    if (inputRows.length > MAX_ROWS) throw new Error(`表格行数超过 ${MAX_ROWS} 行限制。`);

    let width = 0;
    const rows = inputRows.map((row) => {
      if (!Array.isArray(row)) throw new Error('表格数据格式无效。');
      if (row.length > MAX_COLUMNS) throw new Error(`表格列数超过 ${MAX_COLUMNS} 列限制。`);
      width = Math.max(width, row.length);
      return row.map(assertCell);
    });
    if (width === 0) throw new Error('没有找到可编辑的表格。');
    for (const row of rows) while (row.length < width) row.push('');
    return rows;
  }

  function parseCsv(source) {
    const text = assertSource(source).replace(/^\uFEFF/, '');
    const rows = [];
    let row = [];
    let field = '';
    let inQuotes = false;
    let quoteClosed = false;

    function append(char) {
      field += char;
      if (field.length > MAX_CELL_LENGTH) throw new Error('CSV 单元格过大。');
    }

    function pushField() {
      row.push(field);
      if (row.length > MAX_COLUMNS) throw new Error(`CSV 列数超过 ${MAX_COLUMNS} 列限制。`);
      field = '';
      quoteClosed = false;
    }

    function pushRow() {
      pushField();
      rows.push(row);
      if (rows.length > MAX_ROWS) throw new Error(`CSV 行数超过 ${MAX_ROWS} 行限制。`);
      row = [];
    }

    for (let i = 0; i < text.length; i += 1) {
      const char = text[i];
      if (inQuotes) {
        if (char === '"') {
          if (text[i + 1] === '"') {
            append('"');
            i += 1;
          } else {
            inQuotes = false;
            quoteClosed = true;
          }
        } else if (char === '\r' && text[i + 1] === '\n') {
          append('\n');
          i += 1;
        } else {
          append(char);
        }
        continue;
      }

      if (quoteClosed) {
        if (char === ',') {
          pushField();
          continue;
        }
        if (char === '\n' || char === '\r') {
          if (char === '\r' && text[i + 1] === '\n') i += 1;
          pushRow();
          continue;
        }
        if (char === ' ' || char === '\t') continue;
        throw new Error('CSV 引号后的内容格式无效。');
      }

      if (char === '"') {
        if (field.length !== 0) throw new Error('CSV 引号必须位于单元格开头。');
        inQuotes = true;
      } else if (char === ',') {
        pushField();
      } else if (char === '\n' || char === '\r') {
        if (char === '\r' && text[i + 1] === '\n') i += 1;
        pushRow();
      } else {
        append(char);
      }
    }

    if (inQuotes) throw new Error('CSV 存在未闭合的引号。');
    if (field.length > 0 || row.length > 0 || (text && !/[\r\n]$/.test(text))) pushRow();
    while (rows.length > 1 && rows[rows.length - 1].every((cell) => cell === '')) rows.pop();
    return normalizeRows(rows);
  }

  function isEscapedAt(text, index) {
    let slashes = 0;
    for (let i = index - 1; i >= 0 && text[i] === '\\'; i -= 1) slashes += 1;
    return slashes % 2 === 1;
  }

  function splitMarkdownRow(line) {
    let text = String(line == null ? '' : line).trim();
    if (text.startsWith('|')) text = text.slice(1);
    if (text.endsWith('|') && !isEscapedAt(text, text.length - 1)) text = text.slice(0, -1);

    const cells = [];
    let cell = '';
    for (let i = 0; i < text.length; i += 1) {
      const char = text[i];
      if (char === '\\' && i + 1 < text.length && (text[i + 1] === '|' || text[i + 1] === '\\')) {
        cell += text[i + 1];
        i += 1;
      } else if (char === '|') {
        cells.push(cell.trim());
        cell = '';
      } else {
        cell += char;
      }
    }
    cells.push(cell.trim());
    return cells.map(assertCell);
  }

  function isMarkdownDelimiter(cells) {
    return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.trim()));
  }

  function parseMarkdownTable(source) {
    const lines = assertSource(source).replace(/\r\n?/g, '\n').split('\n');
    for (let delimiterIndex = 1; delimiterIndex < lines.length; delimiterIndex += 1) {
      const delimiter = splitMarkdownRow(lines[delimiterIndex]);
      if (!isMarkdownDelimiter(delimiter)) continue;
      const header = splitMarkdownRow(lines[delimiterIndex - 1]);
      if (header.length !== delimiter.length || !lines[delimiterIndex - 1].includes('|')) continue;

      const rows = [header];
      for (let i = delimiterIndex + 1; i < lines.length; i += 1) {
        if (!lines[i].includes('|') || !lines[i].trim()) break;
        rows.push(splitMarkdownRow(lines[i]));
        if (rows.length > MAX_ROWS) throw new Error(`Markdown 表格超过 ${MAX_ROWS} 行限制。`);
      }
      return normalizeRows(rows);
    }
    throw new Error('没有找到有效的 Markdown 表格。');
  }

  function extractStructuredTable(source) {
    const text = assertSource(source);
    const fencedCsv = /```[ \t]*csv[ \t]*\r?\n([\s\S]*?)\r?\n?```/i.exec(text);
    if (fencedCsv) return { format: 'csv', rows: parseCsv(fencedCsv[1]) };

    try {
      return { format: 'markdown', rows: parseMarkdownTable(text) };
    } catch (markdownError) {
      if (/[,，]/.test(text) && /[\r\n]/.test(text)) {
        try {
          return { format: 'csv', rows: parseCsv(text) };
        } catch (_) {
          // Keep the more useful Markdown/no-table message below.
        }
      }
      throw markdownError;
    }
  }

  function protectSpreadsheetFormula(value) {
    const text = String(value == null ? '' : value);
    return /^[\s]*[=+\-@]/.test(text) ? `'${text}` : text;
  }

  function quoteDelimited(value, delimiter) {
    const safe = protectSpreadsheetFormula(value);
    return safe.includes(delimiter) || /["\r\n]/.test(safe)
      ? `"${safe.replace(/"/g, '""')}"`
      : safe;
  }

  function serializeCsv(inputRows) {
    return normalizeRows(inputRows)
      .map((row) => row.map((cell) => quoteDelimited(cell, ',')).join(','))
      .join('\n');
  }

  function serializeTsv(inputRows) {
    return normalizeRows(inputRows)
      .map((row) => row.map((cell) => quoteDelimited(cell, '\t')).join('\t'))
      .join('\n');
  }

  function markdownCell(value) {
    return String(value == null ? '' : value)
      .replace(/\\/g, '\\\\')
      .replace(/\|/g, '\\|')
      .replace(/\r\n?|\n/g, '<br>');
  }

  function serializeMarkdown(inputRows) {
    const rows = normalizeRows(inputRows);
    const lines = [`| ${rows[0].map(markdownCell).join(' | ')} |`];
    lines.push(`| ${rows[0].map(() => '---').join(' | ')} |`);
    for (const row of rows.slice(1)) lines.push(`| ${row.map(markdownCell).join(' | ')} |`);
    return lines.join('\n');
  }

  return Object.freeze({
    MAX_SOURCE_LENGTH,
    MAX_ROWS,
    MAX_COLUMNS,
    MAX_CELL_LENGTH,
    extractStructuredTable,
    parseCsv,
    parseMarkdownTable,
    serializeCsv,
    serializeTsv,
    serializeMarkdown,
    protectSpreadsheetFormula,
  });
});
