const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  helperFilename,
  inspectMachOArchitectures
} = require('../src/main/swift-helper-contract');
const {
  createSwiftBinaryProvider
} = require('../src/main/swift-binary-cache');
const {
  packageSwiftHelpers,
  resolveBuilderArch
} = require('../scripts/package-swift-helpers');
const { AX_PROBE_SOURCE } = require('../src/main/swift-helper-sources');

const CPU_TYPES = {
  x64: 0x01000007,
  arm64: 0x0100000c
};

function tempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function thinMachO(arch) {
  const binary = Buffer.alloc(32);
  binary.writeUInt32LE(0xfeedfacf, 0);
  binary.writeUInt32LE(CPU_TYPES[arch], 4);
  return binary;
}

function universalMachO(arches) {
  const binary = Buffer.alloc(8 + arches.length * 20);
  binary.writeUInt32BE(0xcafebabe, 0);
  binary.writeUInt32BE(arches.length, 4);
  arches.forEach((arch, index) => {
    binary.writeUInt32BE(CPU_TYPES[arch], 8 + index * 20);
  });
  return binary;
}

function writeExecutable(filePath, contents) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents, { mode: 0o700 });
}

test('AX helper validates the Core Foundation type before converting to AXValue', () => {
  assert.doesNotMatch(AX_PROBE_SOURCE, /\bas\?\s+AXValue\b/);

  const checkedConversions = AX_PROBE_SOURCE.match(
    /let raw = v,\s*CFGetTypeID\(raw\) == AXValueGetTypeID\(\) else \{ return \.zero \}\s*let ax = unsafeBitCast\(raw, to: AXValue\.self\)/g
  );
  assert.equal(checkedConversions && checkedConversions.length, 2);
});

test('Mach-O inspection recognizes thin arm64/x64 and universal helpers', (t) => {
  const dir = tempDir(t, 'kunkun-macho-contract-');
  const arm64Path = path.join(dir, 'arm64-helper');
  const x64Path = path.join(dir, 'x64-helper');
  const universalPath = path.join(dir, 'universal-helper');
  writeExecutable(arm64Path, thinMachO('arm64'));
  writeExecutable(x64Path, thinMachO('x64'));
  writeExecutable(universalPath, universalMachO(['x64', 'arm64']));

  assert.deepEqual(inspectMachOArchitectures(arm64Path), ['arm64']);
  assert.deepEqual(inspectMachOArchitectures(x64Path), ['x64']);
  assert.deepEqual(inspectMachOArchitectures(universalPath), ['x64', 'arm64']);
});

test('packaged Swift provider only returns a source-bound, matching app resource', async (t) => {
  const resourcesDir = tempDir(t, 'kunkun-packaged-swift-');
  const source = 'print("packaged")';
  const binaryPath = path.join(resourcesDir, 'native-helpers', helperFilename('axprobe', source));
  writeExecutable(binaryPath, thinMachO('arm64'));

  let developmentCompileCalls = 0;
  const provider = createSwiftBinaryProvider({
    isPackaged: () => true,
    resourcesPath: () => resourcesDir,
    runtimeArch: () => 'arm64',
    developmentCache: {
      ensureBinary: async () => {
        developmentCompileCalls += 1;
        throw new Error('packaged mode must not compile');
      }
    }
  });

  assert.equal(await provider.ensureBinary({ name: 'axprobe', source }), binaryPath);
  assert.equal(developmentCompileCalls, 0);
});

test('packaged Swift provider accepts a universal helper containing the runtime slice', async (t) => {
  const resourcesDir = tempDir(t, 'kunkun-universal-runtime-swift-');
  const source = 'print("universal-runtime")';
  const binaryPath = path.join(resourcesDir, 'native-helpers', helperFilename('axprobe', source));
  writeExecutable(binaryPath, universalMachO(['x64', 'arm64']));

  const provider = createSwiftBinaryProvider({
    isPackaged: () => true,
    resourcesPath: () => resourcesDir,
    runtimeArch: () => 'arm64',
    developmentCache: {
      ensureBinary: async () => {
        throw new Error('packaged mode must not compile');
      }
    }
  });

  assert.equal(await provider.ensureBinary({ name: 'axprobe', source }), binaryPath);
});

test('packaged Swift provider fails closed for missing or wrong-architecture helpers', async (t) => {
  const resourcesDir = tempDir(t, 'kunkun-invalid-packaged-swift-');
  const source = 'print("expected")';
  const binaryPath = path.join(resourcesDir, 'native-helpers', helperFilename('vision-boxes', source));
  writeExecutable(binaryPath, thinMachO('x64'));

  let developmentCompileCalls = 0;
  const provider = createSwiftBinaryProvider({
    isPackaged: () => true,
    resourcesPath: () => resourcesDir,
    runtimeArch: () => 'arm64',
    developmentCache: {
      ensureBinary: async () => {
        developmentCompileCalls += 1;
      }
    }
  });

  await assert.rejects(
    provider.ensureBinary({ name: 'vision-boxes', source }),
    /架构.*arm64/
  );
  await assert.rejects(
    provider.ensureBinary({ name: 'missing-helper', source }),
    /包内缺少/
  );
  assert.equal(developmentCompileCalls, 0);
});

test('development Swift provider retains the content-addressed compiler cache', async () => {
  let seen;
  const provider = createSwiftBinaryProvider({
    isPackaged: () => false,
    resourcesPath: () => {
      throw new Error('development mode must not inspect app resources');
    },
    runtimeArch: () => 'arm64',
    developmentCache: {
      ensureBinary: async (request) => {
        seen = request;
        return '/tmp/dev-helper';
      }
    }
  });

  assert.equal(
    await provider.ensureBinary({ name: 'axprobe', source: 'print("dev")' }),
    '/tmp/dev-helper'
  );
  assert.deepEqual(seen, { name: 'axprobe', source: 'print("dev")' });
});

for (const [builderArch, expectedArch] of [[1, 'x64'], [3, 'arm64']]) {
  test(`afterPack compiler packages every ${expectedArch} Swift helper`, async (t) => {
    const appContentsDir = tempDir(t, `kunkun-${expectedArch}-app-`);
    const helpers = [
      { name: 'axprobe', source: 'print("ax")' },
      { name: 'vision-boxes', source: 'print("vision")' }
    ];
    const calls = [];

    const packagedPaths = await packageSwiftHelpers(
      { arch: builderArch },
      appContentsDir,
      {
        helpers,
        compileThin: async ({ name, source, arch, outputPath }) => {
          calls.push({ name, source, arch });
          writeExecutable(outputPath, thinMachO(arch));
        }
      }
    );

    assert.equal(resolveBuilderArch(builderArch), expectedArch);
    assert.deepEqual(calls, helpers.map((helper) => ({ ...helper, arch: expectedArch })));
    assert.deepEqual(
      packagedPaths,
      helpers.map((helper) => path.join(
        appContentsDir,
        'Resources',
        'native-helpers',
        helperFilename(helper.name, helper.source)
      ))
    );
    for (const packagedPath of packagedPaths) {
      assert.deepEqual(inspectMachOArchitectures(packagedPath), [expectedArch]);
      assert.notEqual(fs.statSync(packagedPath).mode & 0o111, 0);
    }
  });
}

test('afterPack can reuse source-bound verified helpers when the local Swift toolchain is unavailable', async (t) => {
  const appContentsDir = tempDir(t, 'kunkun-prebuilt-helper-app-');
  const prebuiltHelperDir = tempDir(t, 'kunkun-prebuilt-helper-source-');
  const helpers = [
    { name: 'axprobe', source: 'print("reuse-ax")' },
    { name: 'vision-boxes', source: 'print("reuse-vision")' }
  ];
  for (const helper of helpers) {
    writeExecutable(
      path.join(prebuiltHelperDir, helperFilename(helper.name, helper.source)),
      thinMachO('arm64')
    );
  }

  let compileCalls = 0;
  const packagedPaths = await packageSwiftHelpers(
    { arch: 3 },
    appContentsDir,
    {
      helpers,
      prebuiltHelperDir,
      compileThin: async () => { compileCalls += 1; }
    }
  );

  assert.equal(compileCalls, 0);
  assert.equal(packagedPaths.length, helpers.length);
  for (const packagedPath of packagedPaths) {
    assert.deepEqual(inspectMachOArchitectures(packagedPath), ['arm64']);
    assert.notEqual(fs.statSync(packagedPath).mode & 0o111, 0);
  }
});

test('afterPack refuses a symlink masquerading as a verified prebuilt helper', async (t) => {
  const appContentsDir = tempDir(t, 'kunkun-prebuilt-symlink-app-');
  const prebuiltHelperDir = tempDir(t, 'kunkun-prebuilt-symlink-source-');
  const externalDir = tempDir(t, 'kunkun-prebuilt-symlink-target-');
  const helper = { name: 'axprobe', source: 'print("no-symlink")' };
  const targetPath = path.join(externalDir, 'arm64-helper');
  writeExecutable(targetPath, thinMachO('arm64'));
  fs.symlinkSync(
    targetPath,
    path.join(prebuiltHelperDir, helperFilename(helper.name, helper.source))
  );

  await assert.rejects(
    packageSwiftHelpers(
      { arch: 3 },
      appContentsDir,
      { helpers: [helper], prebuiltHelperDir }
    ),
    /符号链接/
  );
});

test('universal afterPack verifies the lipo-merged helpers without recompiling', async (t) => {
  const appContentsDir = tempDir(t, 'kunkun-universal-app-');
  const helpers = [{ name: 'axprobe', source: 'print("both")' }];
  const binaryPath = path.join(
    appContentsDir,
    'Resources',
    'native-helpers',
    helperFilename(helpers[0].name, helpers[0].source)
  );
  writeExecutable(binaryPath, universalMachO(['x64', 'arm64']));

  let compileCalls = 0;
  const packagedPaths = await packageSwiftHelpers(
    { arch: 4 },
    appContentsDir,
    {
      helpers,
      compileThin: async () => {
        compileCalls += 1;
      }
    }
  );

  assert.deepEqual(packagedPaths, [binaryPath]);
  assert.equal(compileCalls, 0);
  assert.deepEqual(inspectMachOArchitectures(binaryPath), ['x64', 'arm64']);
});

test('afterPack compiler fails when swiftc output is missing or has the wrong architecture', async (t) => {
  const missingContentsDir = tempDir(t, 'kunkun-missing-helper-output-');
  const wrongContentsDir = tempDir(t, 'kunkun-wrong-helper-output-');
  const helpers = [{ name: 'axprobe', source: 'print("broken")' }];

  await assert.rejects(
    packageSwiftHelpers(
      { arch: 3 },
      missingContentsDir,
      { helpers, compileThin: async () => {} }
    ),
    /没有生成.*axprobe/
  );

  await assert.rejects(
    packageSwiftHelpers(
      { arch: 3 },
      wrongContentsDir,
      {
        helpers,
        compileThin: async ({ outputPath }) => writeExecutable(outputPath, thinMachO('x64'))
      }
    ),
    /架构.*arm64/
  );
});
