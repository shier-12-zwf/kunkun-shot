'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const DEFAULT_OUTPUT_DIR = path.join(ROOT, 'dist', 'ci-package');
const PRODUCT_NAME = require('../package.json').productName;

function findPackagedExecutable(outputDir = DEFAULT_OUTPUT_DIR) {
  const resolvedOutput = path.resolve(outputDir);
  let platformDirectories;
  try {
    platformDirectories = fs.readdirSync(resolvedOutput, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^mac(?:-(?:arm64|universal))?$/.test(entry.name))
      .map((entry) => path.join(resolvedOutput, entry.name));
  } catch (error) {
    throw new Error(`打包输出目录不可访问：${resolvedOutput}`, { cause: error });
  }

  const candidates = platformDirectories
    .map((directory) => path.join(
      directory,
      `${PRODUCT_NAME}.app`,
      'Contents',
      'MacOS',
      PRODUCT_NAME
    ))
    .filter((candidate) => {
      try {
        const metadata = fs.lstatSync(candidate);
        return metadata.isFile() && !metadata.isSymbolicLink() && (metadata.mode & 0o111) !== 0;
      } catch (_) {
        return false;
      }
    });

  if (candidates.length !== 1) {
    throw new Error(
      `必须且只能找到一个可执行的打包应用，实际找到 ${candidates.length} 个：${candidates.join(', ') || '无'}`
    );
  }

  const outputRealPath = fs.realpathSync(resolvedOutput);
  const executableRealPath = fs.realpathSync(candidates[0]);
  if (!executableRealPath.startsWith(`${outputRealPath}${path.sep}`)) {
    throw new Error(`打包应用可执行文件越出输出目录：${executableRealPath}`);
  }
  return executableRealPath;
}

function run() {
  const executable = findPackagedExecutable(process.env.KK_PACKAGED_OUTPUT_DIR || DEFAULT_OUTPUT_DIR);
  console.log(`PACKAGED_SMOKE_EXECUTABLE ${executable}`);
  const result = spawnSync(process.execPath, [path.join(__dirname, 'test-electron-smoke.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      KK_SMOKE_EXECUTABLE: executable,
    },
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.signal) throw new Error(`打包产物冒烟测试被信号 ${result.signal} 终止。`);
  if (result.status !== 0) process.exitCode = result.status || 1;
}

if (require.main === module) {
  try {
    run();
  } catch (error) {
    console.error(error && error.stack ? error.stack : error);
    process.exitCode = 1;
  }
}

module.exports = { findPackagedExecutable };
