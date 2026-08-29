'use strict';

function safeMessage(error) {
  return error && error.message ? String(error.message) : String(error || 'unknown error');
}

function registrationFailure(key, accelerator, reason) {
  return {
    key: key || 'unknown',
    accelerator: accelerator || '',
    reason: reason || 'unavailable',
  };
}

function installShortcutBindings(adapter, bindings) {
  const failed = [];
  try {
    adapter.reset();
  } catch (error) {
    failed.push(registrationFailure('reset', '', safeMessage(error)));
    return { ok: false, failed };
  }

  try {
    if (adapter.restoreReserved() === false) {
      failed.push(registrationFailure('reserved', '', 'unavailable'));
      return { ok: false, failed };
    }
  } catch (error) {
    failed.push(registrationFailure('reserved', '', safeMessage(error)));
    return { ok: false, failed };
  }

  for (const binding of bindings || []) {
    if (!binding || !binding.accelerator) continue;
    const key = typeof binding.key === 'string' && binding.key ? binding.key : 'unknown';
    const accelerator = String(binding.accelerator);
    if (typeof binding.callback !== 'function') {
      failed.push(registrationFailure(key, accelerator, 'invalid-callback'));
      break;
    }
    try {
      if (adapter.register(accelerator, binding.callback) !== true) {
        failed.push(registrationFailure(key, accelerator, 'unavailable'));
        break;
      }
    } catch (error) {
      failed.push(registrationFailure(key, accelerator, safeMessage(error)));
      break;
    }
  }
  return failed.length ? { ok: false, failed } : { ok: true, failed: [] };
}

function shortcutError(failed) {
  const first = failed && failed[0] ? failed[0] : registrationFailure('unknown', '', 'unavailable');
  const target = first.accelerator ? `「${first.accelerator}」` : '保留快捷键';
  return {
    code: 'SHORTCUT_REGISTRATION_FAILED',
    message: `${target} 注册失败，可能已被系统或其他应用占用。已恢复之前的快捷键。`,
    failed: failed || [],
  };
}

// Electron 的 globalShortcut 没有“预检查且原子替换”接口。因此使用两阶段补偿：
// 先尝试完整安装新集合；任一 register() 返回 false/抛错时，立即清空半成品并重建旧集合。
function replaceShortcutBindings(adapter, nextBindings, previousBindings) {
  if (!adapter || typeof adapter.reset !== 'function' || typeof adapter.restoreReserved !== 'function' || typeof adapter.register !== 'function') {
    throw new TypeError('快捷键注册器依赖无效。');
  }
  const attempt = installShortcutBindings(adapter, nextBindings);
  if (attempt.ok) return { ok: true };

  const rollback = installShortcutBindings(adapter, previousBindings || []);
  return {
    ok: false,
    error: shortcutError(attempt.failed),
    rollback,
  };
}

function ownsShortcutPatch(patch) {
  return !!(
    patch &&
    typeof patch === 'object' &&
    patch.shortcuts &&
    typeof patch.shortcuts === 'object' &&
    !Array.isArray(patch.shortcuts) &&
    Object.keys(patch.shortcuts).length
  );
}

// 配置文件与 Electron 内存中的真实绑定必须一起成功。注册失败时用旧 shortcuts
// 再写一次原子配置，并返回 renderer 可安全展示的结构化错误。
function applyConfigPatchTransaction({
  patch,
  getConfig,
  setConfig,
  getPublicConfig,
  applyShortcuts,
}) {
  if ([getConfig, setConfig, getPublicConfig, applyShortcuts].some((fn) => typeof fn !== 'function')) {
    throw new TypeError('配置事务依赖无效。');
  }
  const previousConfig = getConfig() || {};
  const previousShortcuts = { ...((previousConfig && previousConfig.shortcuts) || {}) };
  const merged = setConfig(patch);
  if (!ownsShortcutPatch(patch)) return merged;

  const currentConfig = getConfig() || {};
  let registration;
  try {
    registration = applyShortcuts(
      { ...((currentConfig && currentConfig.shortcuts) || {}) },
      previousShortcuts,
    );
  } catch (error) {
    registration = {
      ok: false,
      error: {
        code: 'SHORTCUT_REGISTRATION_FAILED',
        message: `快捷键注册失败：${safeMessage(error)}`,
        failed: [],
      },
      rollback: { ok: false, failed: [] },
    };
  }
  if (registration && registration.ok) return merged;

  let configRollbackError = null;
  try {
    setConfig({ shortcuts: previousShortcuts });
  } catch (error) {
    configRollbackError = safeMessage(error);
  }
  const baseError = registration && registration.error
    ? registration.error
    : shortcutError([]);
  const rollbackOk = !configRollbackError && !!(registration && registration.rollback && registration.rollback.ok);
  return {
    ok: false,
    error: {
      ...baseError,
      code: rollbackOk ? baseError.code : 'SHORTCUT_ROLLBACK_FAILED',
      message: rollbackOk
        ? baseError.message
        : `${baseError.message} 回滚未完整成功，请重启应用后重试。`,
      rollback: {
        shortcuts: !!(registration && registration.rollback && registration.rollback.ok),
        config: !configRollbackError,
      },
    },
    config: getPublicConfig(),
  };
}

module.exports = {
  installShortcutBindings,
  replaceShortcutBindings,
  applyConfigPatchTransaction,
};
