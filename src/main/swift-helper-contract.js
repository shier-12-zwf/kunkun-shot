'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const HELPER_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const CPU_TYPE_X64 = 0x01000007;
const CPU_TYPE_ARM64 = 0x0100000c;

function validateHelperRequest(name, source) {
  if (!HELPER_NAME_PATTERN.test(String(name || ''))) {
    throw new Error('Swift helper 名称无效。');
  }
  if (typeof source !== 'string' || source.length === 0) {
    throw new Error('Swift helper 源码为空。');
  }
}

function helperSourceHash(source) {
  if (typeof source !== 'string' || source.length === 0) {
    throw new Error('Swift helper 源码为空。');
  }
  return crypto.createHash('sha256').update(source).digest('hex').slice(0, 16);
}

function helperFilename(name, source) {
  validateHelperRequest(name, source);
  return `${name}-${helperSourceHash(source)}`;
}

function cpuTypeToArch(cpuType) {
  const value = cpuType >>> 0;
  if (value === CPU_TYPE_X64) return 'x64';
  if (value === CPU_TYPE_ARM64) return 'arm64';
  return null;
}

function readCpuType(buffer, offset, littleEndian, filePath) {
  if (offset + 4 > buffer.length) {
    throw new Error(`Mach-O 架构表损坏：${filePath}`);
  }
  const cpuType = littleEndian
    ? buffer.readUInt32LE(offset)
    : buffer.readUInt32BE(offset);
  const arch = cpuTypeToArch(cpuType);
  if (!arch) {
    throw new Error(`Swift helper 包含不支持的 Mach-O CPU 类型 0x${cpuType.toString(16)}：${filePath}`);
  }
  return arch;
}

function inspectMachOArchitectures(filePath) {
  const buffer = fs.readFileSync(filePath);
  if (buffer.length < 8) {
    throw new Error(`Swift helper 不是有效的 Mach-O 文件：${filePath}`);
  }

  const magicBE = buffer.readUInt32BE(0);
  const magicLE = buffer.readUInt32LE(0);
  if (magicLE === 0xfeedface || magicLE === 0xfeedfacf) {
    return [readCpuType(buffer, 4, true, filePath)];
  }
  if (magicBE === 0xfeedface || magicBE === 0xfeedfacf) {
    return [readCpuType(buffer, 4, false, filePath)];
  }

  let littleEndian;
  let entrySize;
  if (magicBE === 0xcafebabe || magicBE === 0xcafebabf) {
    littleEndian = false;
    entrySize = magicBE === 0xcafebabf ? 32 : 20;
  } else if (magicLE === 0xcafebabe || magicLE === 0xcafebabf) {
    littleEndian = true;
    entrySize = magicLE === 0xcafebabf ? 32 : 20;
  } else {
    throw new Error(`Swift helper 不是有效的 Mach-O 文件：${filePath}`);
  }

  const count = littleEndian ? buffer.readUInt32LE(4) : buffer.readUInt32BE(4);
  if (count === 0 || count > 32 || 8 + count * entrySize > buffer.length) {
    throw new Error(`Mach-O 架构表损坏：${filePath}`);
  }

  const architectures = [];
  for (let index = 0; index < count; index += 1) {
    const arch = readCpuType(buffer, 8 + index * entrySize, littleEndian, filePath);
    if (!architectures.includes(arch)) architectures.push(arch);
  }
  return architectures;
}

function assertPackagedHelper(filePath, expectedArchitectures, label, options) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch (error) {
    throw new Error(`包内缺少 Swift helper ${label || path.basename(filePath)}：${filePath}`, { cause: error });
  }
  if (!stat.isFile() || stat.size === 0) {
    throw new Error(`Swift helper ${label || path.basename(filePath)} 不是非空文件：${filePath}`);
  }
  if ((stat.mode & 0o111) === 0) {
    throw new Error(`Swift helper ${label || path.basename(filePath)} 不可执行：${filePath}`);
  }

  const actual = inspectMachOArchitectures(filePath);
  const expected = Array.from(new Set(expectedArchitectures || [])).sort();
  const normalizedActual = Array.from(new Set(actual)).sort();
  const allowAdditional = Boolean(options && options.allowAdditionalArchitectures);
  const hasExpected = expected.every((arch) => normalizedActual.includes(arch));
  if (
    expected.length === 0 ||
    !hasExpected ||
    (!allowAdditional && expected.length !== normalizedActual.length)
  ) {
    throw new Error(
      `Swift helper ${label || path.basename(filePath)} 架构不匹配：期望 ${expected.join('+')}，实际 ${normalizedActual.join('+') || '无'}`
    );
  }
  return actual;
}

module.exports = {
  assertPackagedHelper,
  helperFilename,
  helperSourceHash,
  inspectMachOArchitectures,
  validateHelperRequest
};
