const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const workflow = fs.readFileSync(
  path.join(__dirname, '..', '.github', 'workflows', 'ci.yml'),
  'utf8'
);

test('CI uses supported Node and runs unit plus Electron interaction checks', () => {
  assert.match(workflow, /uses:\s*actions\/checkout@v7\.0\.1/);
  assert.match(workflow, /uses:\s*actions\/setup-node@v7\.0\.0/);
  assert.match(workflow, /node-version:\s*22/);
  assert.match(workflow, /run:\s*npm run test:all/);
  assert.match(workflow, /run:\s*npm run dist:mac:ci/);
  assert.match(workflow, /run:\s*npm run test:packaged/);
  assert.doesNotMatch(workflow, /run:\s*npm test(?:\s|$)/);

  const packageIndex = workflow.indexOf('run: npm run dist:mac:ci');
  const packagedSmokeIndex = workflow.indexOf('run: npm run test:packaged');
  assert.ok(packageIndex >= 0 && packagedSmokeIndex > packageIndex);
});

test('CI retains source-bound native helpers only after packaging succeeds', () => {
  assert.match(workflow, /uses:\s*actions\/upload-artifact@v7\.0\.1/);
  assert.match(workflow, /name:\s*native-helpers-\$\{\{ github\.sha \}\}/);
  assert.match(workflow, /path:\s*dist\/ci-package\/mac\*\/困困截图工具\.app\/Contents\/Resources\/native-helpers\//);
  assert.match(workflow, /if-no-files-found:\s*error/);
  assert.match(workflow, /retention-days:\s*7/);

  const packageIndex = workflow.indexOf('run: npm run dist:mac:ci');
  const uploadIndex = workflow.indexOf('uses: actions/upload-artifact@v7.0.1');
  assert.ok(packageIndex >= 0 && uploadIndex > packageIndex);
});
