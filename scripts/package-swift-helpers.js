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

const PREBUILT_HELPER_DIR_ENV = 'KK_MAC_NATIVE_HELPER_SOURCE_DIR';

function resolveBuilderArch(value) {
  const arch = BUILDER_ARCHES.get(value);
  if (!arch) throw new Error(`不支持的 macOS Swift helper 构建架构：${String(value)}`);
  return arch;
}

function expectedArchitectures(arch) {
  return arch === 'universal' ? ['x64', 'arm64'] : [arch];
}

function resolvePrebuiltHelperDir(options) {
  const opts = options || {};
  const configured = Object.prototype.hasOwnProperty.call(opts, 'prebuiltHelperDir')
    ? opts.prebuiltHelperDir
    : process.env[PREBUILT_HELPER_DIR_ENV];
  if (configured === undefined || configured === null || configured === '') return null;
  if (typeof configured !== 'string' || /[\0\r\n]/.test(configured) || !path.isAbsolute(configured)) {
    throw new Error(`${PREBUILT_HELPER_DIR_ENV} 必须是无控制字符的绝对目录路径。`);
  }

  let stat;
  try {
    stat = fs.statSync(configured);
  } catch (error) {
    throw new Error(`预编译 Swift helper 目录不可访问：${configured}`, { cause: error });
  }
  if (!stat.isDirectory()) {
    throw new Error(`预编译 Swift helper 路径不是目录：${configured}`);
  }
  return fs.realpathSync(configured);
}

function copyPrebuiltSwiftHelper({ helper, prebuiltHelperDir, destinationPath, expected }) {
  const filename = helperFilename(helper.name, helper.source);
  const sourcePath = path.join(prebuiltHelperDir, filename);
  let sourceMetadata;
  try {
    sourceMetadata = fs.lstatSync(sourcePath);
  } catch (error) {
    throw new Error(`预编译 Swift helper 不可访问：${sourcePath}`, { cause: error });
  }
  if (sourceMetadata.isSymbolicLink()) {
    throw new Error(`预编译 Swift helper 不得是符号链接：${sourcePath}`);
  }
  assertPackagedHelper(sourcePath, expected, helper.name, {
    allowAdditionalArchitectures: true
  });

  const suffix = `${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  const temporaryPath = `${destinationPath}.${suffix}.tmp`;
  try {
    fs.copyFileSync(sourcePath, temporaryPath, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(temporaryPath, 0o755);
    assertPackagedHelper(temporaryPath, expected, helper.name, {
      allowAdditionalArchitectures: true
    });
    fs.renameSync(temporaryPath, destinationPath);
  } finally {
    try { fs.unlinkSync(temporaryPath); } catch (_) {}
  }
}

async function compileThinSwiftHelper({ name, source, language, arch, outputPath }) {
  const target = TARGET_TRIPLES[arch];
  const compilerLanguage = language === undefined ? 'swift' : language;
  if (compilerLanguage !== 'swift' && compilerLanguage !== 'c') {
    throw new Error(`native helper ${name} 的编译语言无效：${String(compilerLanguage)}`);
  }
  if (!target) throw new Error(`native helper ${name} 无法为 ${arch} 编译。`);

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kunkun-swift-build-'));
  const sourcePath = path.join(workDir, `${name}.${compilerLanguage === 'c' ? 'c' : 'swift'}`);
  const compiledPath = path.join(workDir, name);
  try {
    fs.writeFileSync(sourcePath, source, { encoding: 'utf8', mode: 0o600 });
    const sdkPath = execFileSync(
      '/usr/bin/xcrun',
      ['--sdk', 'macosx', '--show-sdk-path'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 }
    ).trim();
    if (!sdkPath) throw new Error('xcrun 未返回 macOS SDK 路径。');
    const command = compilerLanguage === 'c' ? '/usr/bin/clang' : '/usr/bin/swiftc';
    const args = compilerLanguage === 'c'
      ? [
          '-O2', '-target', target, '-isysroot', sdkPath,
          '-framework', 'ApplicationServices',
          '-framework', 'CoreFoundation',
          sourcePath, '-o', compiledPath
        ]
      : ['-O', '-target', target, '-sdk', sdkPath, sourcePath, '-o', compiledPath];
    execFileSync(command, args, { stdio: ['ignore', 'pipe', 'pipe'], timeout: 180000 });
    fs.copyFileSync(compiledPath, outputPath);
    fs.chmodSync(outputPath, 0o755);
  } catch (error) {
    const stderr = error && error.stderr ? String(error.stderr).trim() : '';
    throw new Error(
      `${compilerLanguage === 'c' ? 'C' : 'Swift'} helper ${name} (${arch}) 编译失败${stderr ? `：${stderr}` : ''}`,
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
  const prebuiltHelperDir = resolvePrebuiltHelperDir(opts);
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
    let usedPrebuilt = false;
    const prebuiltPath = prebuiltHelperDir
      ? path.join(prebuiltHelperDir, helperFilename(helper.name, helper.source))
      : null;
    if (prebuiltPath && fs.existsSync(prebuiltPath)) {
      copyPrebuiltSwiftHelper({ helper, prebuiltHelperDir, destinationPath, expected });
      usedPrebuilt = true;
    } else if (arch !== 'universal') {
      const suffix = `${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
      const temporaryPath = `${destinationPath}.${suffix}.tmp`;
      try {
        await compileThin({
          name: helper.name,
          source: helper.source,
          language: helper.language,
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

    assertPackagedHelper(destinationPath, expected, helper.name, {
      allowAdditionalArchitectures: usedPrebuilt
    });
    packagedPaths.push(destinationPath);
  }
  return packagedPaths;
}

module.exports = {
  PREBUILT_HELPER_DIR_ENV,
  compileThinSwiftHelper,
  packageSwiftHelpers,
  resolvePrebuiltHelperDir,
  resolveBuilderArch
};
