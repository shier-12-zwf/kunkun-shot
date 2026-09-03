'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const SMOKE_PREFIX = 'kkshot-smoke-';
// 单次冒烟会真实冷启动一次离线 OCR。产品层允许 OCR worker 最多启动/识别
// 60 秒，因此父进程必须留出更长的退出预算，才能观察到产品自己的明确
// 成功或失败状态，而不是由测试框架提前 SIGKILL。
// 还要覆盖其余独立窗口探针与正式退出清理的最坏预算，避免某个前置
// 检查失败时，父进程在自检收集完整诊断之前先退出。
const TIMEOUT_MS = 120_000;
const EXPECTED_CHECKS = [
  'kkthumb',
  'popover',
  'main-capture',
  'main-settings',
  'ai',
  'overlay',
  'pin',
  'formula',
  'recorder',
  'longshot',
  'translate-popup',
];

function parseSmokeResult(output) {
  const lines = output
    .split(/\r?\n/)
    .filter((value) => value.startsWith('KK_SMOKE_RESULT '));
  assert.equal(lines.length, 1, `KK_SMOKE_RESULT 应且只应输出一次，实际 ${lines.length} 次。\n${output}`);
  return JSON.parse(lines[0].slice('KK_SMOKE_RESULT '.length));
}

function resolveLaunchTarget() {
  const configured = process.env.KK_SMOKE_EXECUTABLE;
  if (!configured) {
    return { executable: require('electron'), args: ['.'] };
  }
  if (!path.isAbsolute(configured)) {
    throw new Error('KK_SMOKE_EXECUTABLE 必须是绝对路径。');
  }
  let stat;
  try {
    // 不跟随符号链接：候选必须自身就是普通可执行文件，避免验证对象与实际目标不一致。
    stat = fs.lstatSync(configured);
  } catch (error) {
    throw new Error(`KK_SMOKE_EXECUTABLE 无法访问：${configured}（${error.message}）`);
  }
  if (!stat.isFile()) {
    throw new Error(`KK_SMOKE_EXECUTABLE 必须指向普通文件：${configured}`);
  }
  try {
    fs.accessSync(configured, fs.constants.X_OK);
  } catch (error) {
    throw new Error(`KK_SMOKE_EXECUTABLE 不可执行：${configured}（${error.message}）`);
  }
  // 打包后的 .app/Contents/MacOS/<name> 已自带应用资源，不再传源码目录参数。
  return { executable: configured, args: [] };
}

function runElectron(envPatch) {
  return new Promise((resolve, reject) => {
    const launch = resolveLaunchTarget();
    const env = { ...process.env, KK_SMOKE: '1', ...envPatch };
    delete env.ELECTRON_RUN_AS_NODE;

    const child = spawn(launch.executable, launch.args, {
      cwd: ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let settled = false;
    let timedOutError = null;
    let timer = null;
    let killFallbackTimer = null;
    child.stdout.on('data', (chunk) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk) => { output += chunk.toString(); });

    const settle = (handler, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (killFallbackTimer) clearTimeout(killFallbackTimer);
      handler(value);
    };

    child.once('error', (error) => settle(reject, error));

    timer = setTimeout(() => {
      timedOutError = new Error(`Electron 冒烟测试 ${TIMEOUT_MS}ms 未退出。\n${output}`);
      if (!child.kill('SIGKILL')) {
        settle(reject, timedOutError);
        return;
      }
      // 正常情况下 SIGKILL 会立即产生 close；兜底避免异常平台永远不结算。
      killFallbackTimer = setTimeout(() => settle(reject, timedOutError), 2_000);
    }, TIMEOUT_MS);

    child.once('close', (code, signal) => {
      if (timedOutError) {
        settle(reject, timedOutError);
        return;
      }
      settle(resolve, { code, signal, output });
    });
  });
}

async function verifyExecutableOverrideRouting() {
  if (process.platform === 'win32' || !fs.existsSync('/usr/bin/false')) return;
  const previous = process.env.KK_SMOKE_EXECUTABLE;
  process.env.KK_SMOKE_EXECUTABLE = '/usr/bin/false';
  try {
    const child = await runElectron({});
    assert.equal(child.signal, null, '候选可执行文件不应被信号终止。');
    assert.equal(child.code, 1, 'KK_SMOKE_EXECUTABLE 必须实际启动指定候选。');
  } finally {
    if (previous === undefined) delete process.env.KK_SMOKE_EXECUTABLE;
    else process.env.KK_SMOKE_EXECUTABLE = previous;
  }
  console.log('SMOKE_EXECUTABLE_OVERRIDE ok');
}

async function runCase({ name, injectProblem, expectedOk }) {
  // 由父进程持有测试目录的生命周期：即使 Electron 超时后被 SIGKILL，finally 仍能清理。
  const smokeUserData = fs.mkdtempSync(path.join(os.tmpdir(), SMOKE_PREFIX));
  try {
    const child = await runElectron({
      KK_TEST_USER_DATA_DIR: smokeUserData,
      KK_SMOKE_INJECT_PROBLEM: injectProblem ? '1' : '',
    });
    const result = parseSmokeResult(child.output);

    assert.equal(child.signal, null, `${name}不应被信号终止。\n${child.output}`);
    assert.equal(result.ok, expectedOk, `${name}的结果状态错误。\n${child.output}`);
    assert.equal(child.code, expectedOk ? 0 : 1, `${name}的进程退出码错误。\n${child.output}`);
    assert.deepEqual(
      [...(result.checks || [])].sort(),
      [...EXPECTED_CHECKS].sort(),
      `${name}没有完成全部窗口/协议检查。\n${child.output}`
    );
    assert.doesNotMatch(child.output, /Error occurred in handler/, `${name}不应出现 IPC 处理器错误。`);

    if (injectProblem) {
      assert.deepEqual(
        result.problems,
        ['[injected] smoke failure'],
        `${name}除预期注入问题外不应有其它自检问题。\n${child.output}`
      );
    } else {
      assert.deepEqual(result.problems, [], `${name}不应有自检问题。\n${child.output}`);
    }

    console.log(`SMOKE_CASE ${name} ok=${result.ok} exit=${child.code}`);
  } finally {
    // smokeUserData 来自本函数的 mkdtemp，目标明确且始终位于系统临时目录。
    fs.rmSync(smokeUserData, { recursive: true, force: true });
    assert.equal(fs.existsSync(smokeUserData), false, `${name}遗留了父进程持有的临时用户目录。`);
  }
}

(async () => {
  await verifyExecutableOverrideRouting();
  await runCase({ name: 'normal', injectProblem: false, expectedOk: true });
  await runCase({ name: 'injected-failure', injectProblem: true, expectedOk: false });
  console.log('ELECTRON_SMOKE ok');
})().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
