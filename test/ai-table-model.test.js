'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

const {
  extractStructuredTable,
  serializeCsv,
  serializeTsv,
  serializeMarkdown,
} = require('../src/renderer/ai/table-model');

test('extracts fenced CSV including quoted commas, quotes, and embedded newlines', () => {
  const parsed = extractStructuredTable([
    '识别结果：',
    '```csv',
    '姓名,备注,数值',
    '困困,"带,逗号","他说""你好"""',
    '小明,"第一行',
    '第二行",42',
    '```',
  ].join('\n'));

  assert.equal(parsed.format, 'csv');
  assert.deepEqual(parsed.rows, [
    ['姓名', '备注', '数值'],
    ['困困', '带,逗号', '他说"你好"'],
    ['小明', '第一行\n第二行', '42'],
  ]);
});

test('extracts GFM tables, ignores the alignment row, and preserves escaped pipes', () => {
  const parsed = extractStructuredTable([
    '下面是表格：',
    '| 名称 | 说明 |',
    '| :--- | ---: |',
    '| A | 左\\|右 |',
    '| B |  空格保留在内容中  |',
  ].join('\n'));

  assert.equal(parsed.format, 'markdown');
  assert.deepEqual(parsed.rows, [
    ['名称', '说明'],
    ['A', '左|右'],
    ['B', '空格保留在内容中'],
  ]);
});

test('normalizes ragged rows and rejects malformed or unbounded input', () => {
  assert.deepEqual(extractStructuredTable('| A | B |\n| --- | --- |\n| 1 |').rows, [
    ['A', 'B'],
    ['1', ''],
  ]);
  assert.throws(() => extractStructuredTable('```csv\n"unterminated\n```'), /CSV|引号/);
  assert.throws(() => extractStructuredTable('没有表格'), /表格/);
  assert.throws(() => extractStructuredTable('x'.repeat(1_000_001)), /过大/);
});

test('serializers round-trip values and protect spreadsheet formula injection', () => {
  const rows = [
    ['名称', '内容'],
    ['公式', '=HYPERLINK("https://evil.invalid")'],
    ['空白前缀', '  +1+1'],
    ['正常', 'hello, "world"'],
    ['多行', 'a\nb'],
  ];

  const csv = serializeCsv(rows);
  assert.match(csv, /公式,"'=HYPERLINK\(""https:\/\/evil\.invalid""\)"/);
  assert.match(csv, /空白前缀,'  \+1\+1/);
  assert.match(csv, /正常,"hello, ""world"""/);
  assert.match(csv, /多行,"a\nb"/);

  const tsv = serializeTsv(rows);
  assert.match(tsv, /公式\t"?'=HYPERLINK/);
  assert.equal(tsv.includes('\t  +1+1'), false);

  const markdown = serializeMarkdown([['A|B', '换\n行'], ['\\', 'ok']]);
  assert.equal(markdown, '| A\\|B | 换<br>行 |\n| --- | --- |\n| \\\\ | ok |');
});

test('AI result page loads the parser and exposes an editable, text-only table workspace', () => {
  const html = fs.readFileSync(path.join(root, 'src/renderer/ai/ai.html'), 'utf8');
  const js = fs.readFileSync(path.join(root, 'src/renderer/ai/ai.js'), 'utf8');

  assert.match(html, /<script src="\.\/table-model\.js"><\/script>\s*<script src="\.\/ai\.js"><\/script>/);
  assert.match(html, /id="tableWorkspace"/);
  assert.match(html, /id="btnCopyCsv"/);
  assert.match(html, /id="btnCopyTsv"/);
  assert.match(html, /id="btnCopyMarkdown"/);

  assert.match(js, /KKTableModel\.extractStructuredTable/);
  assert.match(js, /document\.createElement\(['"]input['"]\)/);
  assert.match(js, /cellInput\.value\s*=/);
  assert.doesNotMatch(js, /innerHTML\s*=\s*(?:cell|value|row|liveText|parsed)/);
});
