import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * The rule the panel now follows, stated independently of React.
 *
 * A saved result only exists for an agent that answered, so restoring results
 * directly onto the board showed exactly those agents — which is how an
 * untouched board came up displaying a lone Research card.
 */
function roster(fleet, saved) {
  return fleet.map(agent => {
    const was = saved?.results.find(r => r.id === agent.id);
    return was
      ? { id: agent.id, phase: was.error ? 'error' : 'done', text: was.text }
      : { id: agent.id, phase: 'idle', text: '' };
  });
}

const FLEET = ['lead', 'research', 'plan', 'write', 'review', 'analyse'].map(id => ({ id }));
const SAVED = { at: 1, sent: true, results: [{ id: 'research', name: 'Research', text: 'found it', error: '' }] };

test('with no fleet connected there is no board at all', () => {
  assert.deepEqual(roster([], SAVED), [], 'nothing shows before the user connects');
});

test('connecting shows the whole fleet, not just whoever answered last time', () => {
  const board = roster(FLEET, SAVED);
  assert.equal(board.length, 6);
  assert.equal(board.filter(a => a.phase === 'done').length, 1);
  assert.equal(board.filter(a => a.phase === 'idle').length, 5);
});

test('restored output lands on the agent that produced it', () => {
  const board = roster(FLEET, SAVED);
  assert.equal(board.find(a => a.id === 'research').text, 'found it');
  assert.equal(board.find(a => a.id === 'lead').text, '');
});

test('a saved agent no longer in the fleet is dropped, not resurrected', () => {
  const stale = { at: 1, sent: true, results: [{ id: 'retired', name: 'Retired', text: 'old', error: '' }] };
  const board = roster(FLEET, stale);
  assert.equal(board.length, 6);
  assert.ok(!board.some(a => a.id === 'retired'));
});

test('an errored result comes back as an error, not as done', () => {
  const failed = { at: 1, sent: true, results: [{ id: 'plan', name: 'Plan', text: '', error: 'timed out' }] };
  assert.equal(roster(FLEET, failed).find(a => a.id === 'plan').phase, 'error');
});
