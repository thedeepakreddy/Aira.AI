/**
 * Waiting for a gateway that is starting — and, more importantly, not waiting
 * when nothing is.
 *
 * The desktop shell starts the gateway at launch, so a connection failure there
 * is often "not up yet" rather than "not there", and the requests that fail
 * during that window should wait it out. The danger in that is the other side:
 * a browser has no shell to start anything, so the same code must decide
 * instantly rather than making every genuine network failure sit through a
 * thirty second poll before it is allowed to be an error.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { waitForGateway, gatewayStatus } from '../src/lib/gateway-ready.ts';

// Node is not Tauri: `isDesktop` is false here, which is exactly the browser
// case these assertions are about.

test('in a browser there is no shell to ask', async () => {
  assert.equal(await gatewayStatus(), null);
});

test('a browser does not wait for a gateway nobody is starting', async () => {
  const started = Date.now();
  const { ready } = await waitForGateway();
  const elapsed = Date.now() - started;

  assert.equal(ready, false);
  // The real bound is 30s of polling. Anything near it means a web user's
  // failed request hangs instead of failing.
  assert.ok(elapsed < 250, `waiting must be instant off the desktop, took ${elapsed}ms`);
});

test('nothing it returns pretends to be an error message', async () => {
  // An empty note lets the caller keep its own wording; a made-up one would
  // replace "check your connection" with something about a shell that is not
  // there.
  const { note } = await waitForGateway();
  assert.equal(note, '');
});
