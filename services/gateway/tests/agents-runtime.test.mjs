import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DENIED_TOOLS, FLEET, hostedTools, choose, buildConfig } from '../src/runtimes/agents.ts';

const RUST = new URL('../../../apps/desktop/src-tauri/src/openclaw.rs', import.meta.url);

test('the denylist matches the desktop’s, exactly', () => {
  // Two copies of a security boundary is the thing that drifts. This reads the
  // Rust source so a change to one fails until it is made to both.
  const src = readFileSync(RUST, 'utf8');
  const block = /pub const DENIED_TOOLS: &\[&str\] = &\[([\s\S]*?)\];/.exec(src);
  assert.ok(block, 'could not find DENIED_TOOLS in openclaw.rs');
  const rust = [...block[1].matchAll(/"([a-z_]+)"/g)].map(m => m[1]);
  assert.deepEqual([...DENIED_TOOLS].sort(), rust.sort());
});

test('the fleet matches the desktop’s roles and tiers', () => {
  const src = readFileSync(RUST, 'utf8');
  const ids = [...src.matchAll(/^\s+id: "([a-z]+)",\n\s+name:/gm)].map(m => m[1]);
  assert.deepEqual(FLEET.map(m => m.id), ids, 'roles drifted between the two definitions');
});

test('a hosted Research agent has no browser', () => {
  // On a laptop it drives the user's own Chrome, which they can see. Giving a
  // hosted agent a headless browser on a shared machine is a different question.
  const research = FLEET.find(m => m.id === 'research');
  assert.ok(research.tools.includes('web_search'), 'it can still reach the web');
  assert.ok(!hostedTools(research).includes('browser'));
});

test('no member is granted anything on the denylist', () => {
  for (const member of FLEET) {
    for (const tool of hostedTools(member)) {
      assert.ok(!DENIED_TOOLS.includes(tool), `${member.id} asks for denied tool ${tool}`);
    }
  }
});

test('delegation belongs to the lead alone', () => {
  for (const member of FLEET) {
    const delegates = member.tools.includes('sessions_send');
    assert.equal(delegates, member.id === 'lead', `${member.id} has the wrong delegation rights`);
  }
});

test('cron is off for a hosted fleet', () => {
  // It is reaped when idle, so a stored schedule is a promise the server would
  // quietly fail to keep.
  const config = buildConfig({ gatewayUrl: 'https://x', token: 't', model: 'm', catalogue: [], port: 1, workspace: '/tmp/w' });
  assert.equal(config.cron.enabled, false);
  assert.equal(config.plugins.entries.bonjour.enabled, false);
});

test('the whole fleet is configured, each in its own workspace', () => {
  const config = buildConfig({ gatewayUrl: 'https://x', token: 't', model: 'm', catalogue: [], port: 1, workspace: '/tmp/w' });
  const entries = config.agents.entries;
  assert.equal(Object.keys(entries).length, 6);
  assert.match(entries.research.workspace, /\/tmp\/w\/research$/);
  assert.equal(config.agents.defaults.systemAgent.agentId, 'lead');
});

test('tier picks a model, and local is preferred only when asked', () => {
  const catalogue = [
    { id: 'claude-sonnet-5', tier: 'balanced', provider: 'anthropic' },
    { id: 'llama3.1:8b', tier: 'balanced', provider: 'ollama' },
  ];
  assert.equal(choose(catalogue, 'balanced', false, 'routed'), 'claude-sonnet-5');
  assert.equal(choose(catalogue, 'balanced', true, 'routed'), 'llama3.1:8b');
  assert.equal(choose(catalogue, 'frontier', true, 'routed'), 'routed', 'never invents a model');
});

test('the token is a placeholder in the file, never the token itself', () => {
  const config = buildConfig({ gatewayUrl: 'https://x', token: 'secret-value', model: 'm', catalogue: [], port: 1, workspace: '/tmp/w' });
  const text = JSON.stringify(config);
  assert.ok(!text.includes('secret-value'), 'a session token must not be written to disk');
  assert.match(config.models.providers.aira.apiKey, /\$\{AIRA_TOKEN\}/);
});
