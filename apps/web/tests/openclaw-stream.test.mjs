import { test } from 'node:test';
import assert from 'node:assert/strict';
import { streamTask } from '../src/lib/openclaw.ts';

const request = { port: 1234, token: 'test-only', agent: 'openclaw/main', message: 'Hello' };

test('agent delta subscription is installed before dispatch and cleaned after completion', async () => {
  const order = [];
  const output = [];
  let callback;
  await streamTask({
    listen: async (name, handler) => {
      assert.match(name, /^openclaw:\/\/delta\//);
      await Promise.resolve(); callback = handler; order.push('listening');
      return () => order.push('unsubscribed');
    },
    invoke: async (command, args) => {
      assert.equal(command, 'openclaw_stream');
      assert.equal(args.agent, request.agent);
      order.push('invoked'); callback({ payload: 'First delta' });
    },
  }, request, text => output.push(text));
  assert.deepEqual(order, ['listening', 'invoked', 'unsubscribed']);
  assert.deepEqual(output, ['First delta']);
});

test('native errors reject the run and cannot be masked by a done event', async () => {
  let unsubscribed = false;
  await assert.rejects(streamTask({
    listen: async () => () => { unsubscribed = true; },
    invoke: async () => { throw new Error('Provider unavailable'); },
  }, request, () => {}), /Provider unavailable/);
  assert.equal(unsubscribed, true);
});

test('aborting a run invokes native cancellation with the same run id', async () => {
  const controller = new AbortController();
  const calls = [];
  let finish;
  let unsubscribed = false;
  const streaming = new Promise(resolve => { finish = resolve; });
  const pending = streamTask({
    listen: async () => () => { unsubscribed = true; },
    invoke: async (command, args) => {
      calls.push({ command, run: args.run });
      if (command === 'openclaw_stream') { queueMicrotask(() => controller.abort()); return streaming; }
    },
  }, request, () => {}, controller.signal);
  await assert.rejects(pending, error => error.name === 'AbortError');
  assert.deepEqual(calls.map(call => call.command), ['openclaw_stream', 'openclaw_cancel']);
  assert.equal(calls[0].run, calls[1].run);
  assert.equal(unsubscribed, true);
  finish();
});

test('abort while installing listeners never starts native work', async () => {
  const controller = new AbortController();
  let invoked = false;
  let unsubscribed = false;
  await assert.rejects(streamTask({
    listen: async () => { controller.abort(); return () => { unsubscribed = true; }; },
    invoke: async () => { invoked = true; },
  }, request, () => {}, controller.signal), error => error.name === 'AbortError');
  assert.equal(invoked, false);
  assert.equal(unsubscribed, true);
});

test('failed native cancellation is surfaced so the UI cannot claim success', async () => {
  const controller = new AbortController();
  let finish;
  const streaming = new Promise(resolve => { finish = resolve; });
  await assert.rejects(streamTask({
    listen: async () => () => {},
    invoke: async command => {
      if (command === 'openclaw_stream') { queueMicrotask(() => controller.abort()); return streaming; }
      throw new Error('Runtime unavailable');
    },
  }, request, () => {}, controller.signal), /Could not confirm task cancellation/);
  finish();
});
