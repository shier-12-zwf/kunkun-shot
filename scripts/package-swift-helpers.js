'use strict';

const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  assertPackagedHelper,
  helperFilename,
  validateHelperRequest
} = require('../src/main/swift-helper-contract');
const { SWIFT_HELPERS } = require('../src/main/swift-helper-sources');

const BUILDER_ARCHES = new Map([
  [1, 'x64'],
  [3, 'arm64'],
  [4, 'universal'],
  ['x64', 'x64'],
  ['arm64', 'arm64'],
  ['universal', 'universal']
]);

const TARGET_TRIPLES = {
  x64: 'x86_64-apple-macos11.0',
  arm64: 'arm64-apple-macos11.0'
};

function resolveBuilderArch(value) {
  const arch = BUILDER_ARCHES.get(value);
  if (!arch) throw new Error(`不支持的 macOS Swift helper 构建架构：${String(value)}`);
  return arch;
}

function expectedArchitectures(arch) {
  return arch === 'universal' ? ['x64', 'arm64'] : [arch];
}

async function compileThinSwiftHelper({ name, source, arch, outputPath }) {
  const target = TARGET_TRIPLES[arch];
  if (!target) throw new Error(`Swift helper ${name} 无法为 ${arch} 编译。`);

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kunkun-swift-build-'));
  const sourcePath = path.join(workDir, `${name}.swift`);
  const compiledPath = path.join(workDir, name);
  try {
    fs.writeFileSync(sourcePath, source, { encoding: 'utf8', mode: 0o600 });
    const sdkPath = execFileSync(
      '/usr/bin/xcrun',
      ['--sdk', 'macosx', '--show-sdk-path'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 }
    ).trim();
    if (!sdkPath) throw new Error('xcrun 未返回 macOS SDK 路径。');
    execFileSync(
      '/usr/bin/swiftc',
      ['-O', '-target', target, '-sdk', sdkPath, sourcePath, '-o', compiledPath],
      { stdio: ['ignore', 'pipe', 'pipe'], timeout: 180000 }
    );
    fs.copyFileSync(compiledPath, outputPath);
    fs.chmodSync(outputPath, 0o755);
  } catch (error) {
    const stderr = error && error.stderr ? String(error.stderr).trim() : '';
    throw new Error(
      `Swift helper ${name} (${arch}) 编译失败${stderr ? `：${stderr}` : ''}`,
      { cause: error }
    );
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

async function packageSwiftHelpers(context, appContentsDir, options) {
  const opts = options || {};
  const helpers = opts.helpers || SWIFT_HELPERS;
  const compileThin = opts.compileThin || compileThinSwiftHelper;
  const arch = resolveBuilderArch(context && context.arch);
  const expected = expectedArchitectures(arch);
  const destinationDir = path.join(appContentsDir, 'Resources', 'native-helpers');
  fs.mkdirSync(destinationDir, { recursive: true, mode: 0o755 });

  const names = new Set();
  const packagedPaths = [];
  for (const helper of helpers) {
    validateHelperRequest(helper && helper.name, helper && helper.source);
    if (names.has(helper.name)) throw new Error(`Swift helper 名称重复：${helper.name}`);
    names.add(helper.name);

    const destinationPath = path.join(destinationDir, helperFilename(helper.name, helper.source));
    if (arch !== 'universal') {
      const suffix = `${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
      const temporaryPath = `${destinationPath}.${suffix}.tmp`;
      try {
        await compileThin({
          name: helper.name,
          source: helper.source,
          arch,
          outputPath: temporaryPath
        });
        if (!fs.existsSync(temporaryPath) || fs.statSync(temporaryPath).size === 0) {
          throw new Error(`swiftc 没有生成 Swift helper ${helper.name} (${arch})。`);
        }
        fs.chmodSync(temporaryPath, 0o755);
        assertPackagedHelper(temporaryPath, expected, helper.name);
        fs.renameSync(temporaryPath, destinationPath);
      } finally {
        try { fs.unlinkSync(temporaryPath); } catch (_) {}
      }
    }

    assertPackagedHelper(destinationPath, expected, helper.name);
    packagedPaths.push(destinationPath);
  }
  return packagedPaths;
}

module.exports = {
  compileThinSwiftHelper,
  packageSwiftHelpers,
  resolveBuilderArch
};
