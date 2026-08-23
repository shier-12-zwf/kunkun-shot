const test = require('node:test');
const assert = require('node:assert/strict');

const { streamChat, fetchModels } = require('../src/main/deepseek');

test('streaming chat rejects insecure remote provider URLs before fetch', async () => {
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    throw new Error('fetch must not run');
  };
  try {
    const events = [];
    await streamChat({
      baseUrl: 'http://api.example.com/v1',
      apiKey: 'not-a-real-key',
      model: 'test',
      messages: [{ role: 'user', content: 'test' }],
    }, (event) => events.push(event));
    assert.equal(calls, 0);
    assert.match(events[0].error, /HTTPS/);
  } finally {
    global.fetch = originalFetch;
  }
});

test('model catalog rejects provider URLs containing credentials before fetch', async () => {
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    throw new Error('fetch must not run');
  };
  try {
    await assert.rejects(
      fetchModels({ baseUrl: 'https://user:password@example.com/v1', apiKey: 'not-a-real-key' }),
      /凭据/
    );
    assert.equal(calls, 0);
  } finally {
    global.fetch = originalFetch;
  }
});

function hangingResponse(status, onController) {
  return new Response(new ReadableStream({
    start(controller) {
      onController(controller);
    },
  }), { status });
}

test('error response bodies remain covered by the chat idle timeout', async () => {
  const originalFetch = global.fetch;
  let bodyController;
  global.fetch = async () => hangingResponse(500, (controller) => { bodyController = controller; });
  const events = [];
  const pending = streamChat({
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'not-a-real-key',
    model: 'test',
    messages: [{ role: 'user', content: 'test' }],
    idleTimeoutMs: 20,
  }, (event) => events.push(event));
  try {
    const result = await Promise.race([
      pending.then(() => 'settled'),
      new Promise((resolve) => setTimeout(() => resolve('timed-out-in-test'), 120)),
    ]);
    assert.equal(result, 'settled');
    assert.match(events.at(-1).error, /超时/);
  } finally {
    try { bodyController.error(new Error('test cleanup')); } catch (_) {}
    await pending;
    global.fetch = originalFetch;
  }
});

test('model list body reads remain covered by the request timeout', async () => {
  const originalFetch = global.fetch;
  let bodyController;
  global.fetch = async () => hangingResponse(200, (controller) => { bodyController = controller; });
  const pending = fetchModels({
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'not-a-real-key',
    timeoutMs: 20,
  });
  try {
    const result = await Promise.race([
      pending.then(() => 'settled', (err) => err),
      new Promise((resolve) => setTimeout(() => resolve('timed-out-in-test'), 120)),
    ]);
    assert.notEqual(result, 'timed-out-in-test');
    assert.match(result.message, /超时/);
  } finally {
    try { bodyController.error(new Error('test cleanup')); } catch (_) {}
    await pending.catch(() => {});
    global.fetch = originalFetch;
  }
});

test('streaming responses have a hard aggregate byte limit', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(4 * 1024 * 1024 + 1));
      controller.close();
    },
  }), { status: 200 });
  try {
    const events = [];
    await streamChat({
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'not-a-real-key',
      model: 'test',
      messages: [{ role: 'user', content: 'test' }],
    }, (event) => events.push(event));
    assert.match(events.at(-1).error, /过大/);
    assert.equal(events.some((event) => event.done), false);
  } finally {
    global.fetch = originalFetch;
  }
});
