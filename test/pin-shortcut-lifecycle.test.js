const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { EventEmitter } = require('node:events');

const RECOVERY_SHORTCUT = 'CommandOrControl+Alt+P';

function loadMainLifecycleFactory() {
  const mainPath = require.resolve('../src/main/main');
  const fakeApp = new EventEmitter();
  fakeApp.requestSingleInstanceLock = () => false;
  fakeApp.quit = () => {};

  const fakeElectron = {
    app: fakeApp,
    globalShortcut: { register: () => true, unregister: () => {} },
    protocol: { registerSchemesAsPrivileged: () => {} },
  };
  const fakeWindows = {
    onPinRemoved: () => () => {},
    pinSnapshots: () => [],
  };

  const originalLoad = Module._load;
  Module._load = function mockMainDependencies(request, parent, isMain) {
    if (request === 'electron') return fakeElectron;
    if (parent && parent.filename === mainPath && request.startsWith('./')) {
      if ([
        './capture-source-matcher',
        './capture-coordinator',
        './pin-workspace-store',
        './timed-capture-scheduler',
        './launch-actions',
        './launch-action-runner',
      ].includes(request)) {
        return originalLoad.call(this, request, parent, isMain);
      }
      if (request === './record-action-monitor') {
        return {
          createRecordActionMonitor: () => ({ stop() {}, stopAll() {} }),
          createRecordActionOwnerRegistry: () => ({ watch: () => () => {}, release() {} }),
        };
      }
      return request === './windows' ? fakeWindows : {};
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[mainPath];
    return require(mainPath).createPassthroughShortcutLifecycle;
  } finally {
    delete require.cache[mainPath];
    Module._load = originalLoad;
  }
}

function loadWindowsWithFakeElectron() {
  let nextWebContentsId = 1;

  class FakeBrowserWindow extends EventEmitter {
    constructor() {
      super();
      this.destroyed = false;
      this.webContents = new EventEmitter();
      this.webContents.id = nextWebContentsId++;
      this.webContents.send = () => {};
    }

    isDestroyed() { return this.destroyed; }
    setAlwaysOnTop() {}
    loadFile() {}
    close() { this.destroy(); }
    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      this.webContents.emit('destroyed');
      this.emit('closed');
    }
  }

  FakeBrowserWindow.getAllWindows = () => [];

  const originalLoad = Module._load;
  Module._load = function mockElectron(request, parent, isMain) {
    if (request === 'electron') return { BrowserWindow: FakeBrowserWindow, screen: {} };
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    const modulePath = require.resolve('../src/main/windows');
    delete require.cache[modulePath];
    return require(modulePath);
  } finally {
    Module._load = originalLoad;
  }
}

function createShortcutRegistry() {
  const callbacks = new Map();
  const registerCalls = [];
  const unregisterCalls = [];
  return {
    callbacks,
    registerCalls,
    unregisterCalls,
    register(accelerator, callback) {
      registerCalls.push(accelerator);
      if (callbacks.has(accelerator)) return false;
      callbacks.set(accelerator, callback);
      return true;
    },
    unregister(accelerator) {
      unregisterCalls.push(accelerator);
      callbacks.delete(accelerator);
    },
    unregisterAll() {
      callbacks.clear();
    },
  };
}

test('active passthrough recovery shortcut is restored immediately after unregisterAll', () => {
  const createLifecycle = loadMainLifecycleFactory();
  assert.equal(typeof createLifecycle, 'function', 'main must export the dependency-injected lifecycle helper');

  const shortcuts = createShortcutRegistry();
  let restored = 0;
  const lifecycle = createLifecycle({
    registerShortcut: shortcuts.register.bind(shortcuts),
    unregisterShortcut: shortcuts.unregister.bind(shortcuts),
    restoreAllPins: () => { restored += 1; },
  });

  lifecycle.setPinPassthrough(41, true);
  assert.equal(shortcuts.callbacks.has(RECOVERY_SHORTCUT), true);

  // Mirrors registerShortcuts(): Electron forgets every accelerator, while the old
  // implementation's boolean incorrectly remained true.
  shortcuts.unregisterAll();
  lifecycle.onGlobalShortcutsReset();

  assert.equal(shortcuts.callbacks.has(RECOVERY_SHORTCUT), true, 'recovery must be re-registered after CONFIG_SET');
  assert.equal(shortcuts.registerCalls.length, 2, 'stale in-memory registration state must be reset');
  assert.equal(
    shortcuts.register(RECOVERY_SHORTCUT, () => {}),
    false,
    'the active recovery shortcut must retain priority over a conflicting configured shortcut',
  );

  shortcuts.callbacks.get(RECOVERY_SHORTCUT)();
  assert.equal(restored, 1);
  assert.equal(shortcuts.callbacks.has(RECOVERY_SHORTCUT), false);
});

test('pin close and destroy notify removal exactly once so passthrough tracking can be cleared', () => {
  const windows = loadWindowsWithFakeElectron();
  assert.equal(typeof windows.onPinRemoved, 'function', 'windows must expose a pin-removal lifecycle subscription');

  const removed = [];
  const unsubscribe = windows.onPinRemoved((id) => removed.push(id));
  const normallyClosed = windows.createPin({
    text: 'normal close',
    bounds: { x: 10, y: 20, width: 200, height: 100 },
  });
  const explicitlyDestroyed = windows.createPin({
    text: 'bulk destroy',
    bounds: { x: 30, y: 40, width: 200, height: 100 },
  });

  normallyClosed.close();
  windows.pinAllDestroy();

  assert.deepEqual(removed, [normallyClosed.webContents.id, explicitlyDestroyed.webContents.id]);
  assert.equal(windows.pinCount(), 0);
  unsubscribe();
});

test('closing the final passthrough pin releases the recovery accelerator', () => {
  const createLifecycle = loadMainLifecycleFactory();
  const windows = loadWindowsWithFakeElectron();
  assert.equal(typeof createLifecycle, 'function');
  assert.equal(typeof windows.onPinRemoved, 'function');

  const shortcuts = createShortcutRegistry();
  const lifecycle = createLifecycle({
    registerShortcut: shortcuts.register.bind(shortcuts),
    unregisterShortcut: shortcuts.unregister.bind(shortcuts),
    restoreAllPins: () => {},
  });
  const unsubscribe = windows.onPinRemoved((id) => lifecycle.removePin(id));
  const pin = windows.createPin({
    text: 'passthrough',
    bounds: { x: 10, y: 20, width: 200, height: 100 },
  });

  lifecycle.setPinPassthrough(pin.webContents.id, true);
  assert.equal(shortcuts.callbacks.has(RECOVERY_SHORTCUT), true);
  pin.destroy();

  assert.equal(shortcuts.callbacks.has(RECOVERY_SHORTCUT), false, 'closed pins must not leave a conflicting global shortcut behind');
  assert.deepEqual(shortcuts.unregisterCalls, [RECOVERY_SHORTCUT]);
  unsubscribe();
});
