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
