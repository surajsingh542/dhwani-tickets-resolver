import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TicketResolver } from '../src/resolver.js';
import { buildSystemAppend } from '../src/claudeSession.js';

const verify = (cfg, opts) => TicketResolver.prototype.verifyPrompt.call({ cfg: { testCommand: '', testCommands: {}, ...cfg } }, { id: 'TASK-1' }, opts);

test('system prompt keeps the whole suite out of the fixing turn', () => {
  const p = buildSystemAppend({ baseBranch: 'development', ticketsRoot: '/t', reposDescription: '' });
  assert.match(p, /run ONLY the test modules that cover what you change/);
  assert.match(p, /Do NOT run the whole app suite .* while fixing, and not as a "baseline"/s);
  assert.match(p, /--module m --test test_name/);
});

test('serial self-review runs the whole suite once, last', () => {
  const p = verify({}, { fullSuite: true });
  assert.match(p, /as the very last\s+step, run the whole test suite of each app you changed ONCE/);
  assert.match(p, /do not run it a second time/);
  assert.doesNotMatch(p, /re-run them now/);
});

test('parallel / pre-existing self-review runs affected modules only', () => {
  for (const p of [verify({}, { fullSuite: false }), verify({})]) {
    assert.match(p, /re-run only the test modules that cover this change/);
    assert.match(p, /Do not run the whole app suite\./);
    assert.doesNotMatch(p, /ONCE/);
  }
});

test('with an orchestrator test gate, the self-review leaves the suite to the gate', () => {
  for (const cfg of [{ testCommand: 'npm test' }, { testCommands: { app: 'bench run-tests' } }]) {
    const p = verify(cfg, { fullSuite: true });
    assert.match(p, /the orchestrator runs it right after this step/);
    assert.doesNotMatch(p, /ONCE/);
  }
});
