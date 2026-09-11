import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadCatalogue, listModels, parseCompatibleModels } from '../src/providers/registry.ts';
import { routeModel, validateRoutes } from '../src/routing/router.ts';
import { loadEnv } from '../src/env.ts';

test('OpenRouter-only installation routes every surface only to its configured provider', () => {
  loadCatalogue({ openrouter: 'vendor/model:free|balanced|128000|0|0', enabledProviders: ['openrouter'] });
  assert.equal(listModels().length, 1);
  for (const surface of ['chat', 'voice', 'code', 'task']) assert.equal(routeModel(surface).model, 'vendor/model:free');
  assert.equal(listModels()[0].pricing.inputPerMTok, 0);
});

test('legacy colon format migrates without corrupting upstream ids', () => {
  const [model] = parseCompatibleModels('model-a:fast:128000:1:4', 'openai');
  assert.deepEqual({ id: model.id, tier: model.tier, context: model.contextWindow, pricing: model.pricing }, {
    id: 'model-a', tier: 'fast', context: 128000, pricing: { inputPerMTok: 1, outputPerMTok: 4 },
  });
  assert.equal(parseCompatibleModels('vendor/model:free', 'openrouter')[0].id, 'vendor/model:free');
  assert.equal(parseCompatibleModels('vendor/model:free:fast:64000', 'openrouter')[0].id, 'vendor/model:free');
});

test('invalid catalogues fail before serving traffic', () => {
  for (const value of ['model|slow', 'model|fast|-1', 'model|fast|1.5', 'model|fast|NaN', 'model|fast|100|1|NaN', 'model|fast|100|-1|2', 'model|fast|100|1', 'model|fast|100|1|2|extra']) {
    assert.throws(() => parseCompatibleModels(value, 'openai'), undefined, value);
  }
  assert.throws(() => loadCatalogue({ enabledProviders: ['openai'] }), /no models/);
  assert.throws(() => loadCatalogue({ openai: 'same', openrouter: 'same', enabledProviders: ['openai', 'openrouter'] }), /Duplicate/);
});

test('disabled providers are absent and routing overrides validate', () => {
  loadCatalogue({ openai: 'disabled', compatible: [{ id: 'local', models: 'coding|frontier' }], enabledProviders: ['local'] });
  assert.deepEqual(listModels().map((model) => model.id), ['coding']);
  const previous = process.env.AIRA_ROUTE_CODE;
  process.env.AIRA_ROUTE_CODE = 'disabled';
  try { assert.throws(validateRoutes, /unavailable model/); } finally {
    if (previous === undefined) delete process.env.AIRA_ROUTE_CODE;
    else process.env.AIRA_ROUTE_CODE = previous;
  }
  validateRoutes();
});

test('production env fails closed on misspelled auth switch', () => {
  const previous = process.env.AIRA_REQUIRE_AUTH;
  process.env.AIRA_REQUIRE_AUTH = 'FALSEE';
  try { assert.throws(loadEnv, /Invalid boolean/); } finally {
    if (previous === undefined) delete process.env.AIRA_REQUIRE_AUTH;
    else process.env.AIRA_REQUIRE_AUTH = previous;
  }
});
