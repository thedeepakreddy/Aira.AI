import test from 'node:test';
import assert from 'node:assert/strict';
import { routeIntent } from '../src/routing/orchestrator.ts';
import { browseTools, BROWSE_TOOL } from '../src/tools/browse.ts';

/** The rule chat applies: instruct only what the caller can actually do. */
function equipped(capability, canBrowse) {
  const offered = browseTools(canBrowse);
  return capability.tools.every(name => offered.some(tool => tool.name === name));
}

test('a caller with no browser is not told to search the web', async () => {
  // The failure this prevents: told to search and cite with no tool, a model
  // announces a search it did not perform and invents the citations.
  const capability = await routeIntent('what is the latest news about AI regulation');
  assert.equal(capability.intent, 'search');
  assert.ok(capability.system.includes('Consult the web'));
  assert.equal(equipped(capability, false), false, 'the instruction must be withheld');
});

test('a caller with a browser is told to search', async () => {
  const capability = await routeIntent('what is the price of bitcoin right now');
  assert.equal(equipped(capability, true), true);
  assert.deepEqual(browseTools(true).map(t => t.name), ['browse_web']);
});

test('an ordinary question is unaffected either way', async () => {
  const capability = await routeIntent('explain closures in javascript');
  assert.equal(capability.tools.length, 0);
  assert.equal(capability.system, '');
  assert.equal(equipped(capability, false), true, 'nothing to withhold');
  assert.equal(equipped(capability, true), true);
});

test('the coding profile needs no tool, so it survives without a browser', async () => {
  // It only changes how the model answers, not what it can reach.
  const capability = await routeIntent('why does this throw a null pointer exception');
  assert.equal(capability.intent, 'code');
  assert.equal(capability.tools.length, 0);
  assert.equal(equipped(capability, false), true);
});

test('the tool tells the model to give an instruction, not a query', () => {
  // A search query comes back as a list of links; an instruction comes back as
  // an answer, which is what the model asked for.
  assert.match(BROWSE_TOOL.description, /instruction, not a search query/);
});
