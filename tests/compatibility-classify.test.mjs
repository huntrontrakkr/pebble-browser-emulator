import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  classifyPhoneFailure,
  summariseFailureClasses,
} from '../scripts/compatibility/classify.mjs';

test('each failure class is recognised from its message', () => {
  const cases = [
    ['TypeError: Failed to fetch', 'network-refused'],
    ['Browser CORS/network request failed: TypeError', 'network-refused'],
    ['Error: Synchronous XMLHttpRequest is not supported.', 'network-unsupported'],
    ['SyntaxError: Unexpected end of JSON input', 'configuration-empty-response'],
    [
      'TypeError: Configuration requires HTTP(S) or an HTML data URL.',
      'configuration-unsupported-url',
    ],
    ['TypeError: AppMessage requires a dictionary.', 'appmessage-rejected'],
    ['TypeError: not a function', 'missing-api'],
    ["TypeError: cannot read property 'length' of null", 'script-error'],
    ['Error: InternalError: interrupted', 'budget-exceeded'],
  ];
  for (const [message, expected] of cases)
    assert.equal(classifyPhoneFailure([message]).failureClass, expected, message);
});

test('a network refusal outranks an earlier incidental error', () => {
  // Only one class means hosting a relay would help; it must not be masked.
  const result = classifyPhoneFailure([
    "TypeError: cannot read property 'x' of undefined",
    'TypeError: Failed to fetch',
  ]);
  assert.equal(result.failureClass, 'network-refused');
});

test('an absent or unknown message is reported, not guessed', () => {
  assert.equal(classifyPhoneFailure([]).failureClass, 'no-message');
  assert.equal(classifyPhoneFailure(['something entirely new']).failureClass, 'unclassified');
});

test('the classifier covers every companion failure in the sealed census', () => {
  // The committed evidence is the real input this exists to explain.
  const report = JSON.parse(
    readFileSync('docs/compatibility/2026-09-18-legacy/original-report.json', 'utf8'),
  );
  const failures = report.results.filter((c) => c.outcome === 'companion-error-observed');
  assert.equal(failures.length, 114, 'the sealed census records 114 companion failures');

  const classified = failures.map((c) =>
    classifyPhoneFailure([
      ...(c.diagnostics.phoneErrors ?? []),
      ...(c.diagnostics.phoneLimits ?? []),
    ]),
  );
  const unexplained = classified.filter((c) =>
    ['unclassified', 'no-message'].includes(c.failureClass),
  );
  assert.deepEqual(unexplained, [], 'every recorded failure must fall into a known class');

  const summary = Object.fromEntries(
    summariseFailureClasses(classified).map((e) => [e.failureClass, e.cases]),
  );
  // The census is sealed, so these counts are fixed evidence: a change here
  // means the classifier changed its mind about already-captured runs.
  // Counted in priority order, so a run that parsed the empty cancellation
  // string and then sent a bad AppMessage is attributed to the parse that
  // caused it rather than to the symptom that followed.
  assert.deepEqual(summary, {
    'configuration-empty-response': 89,
    'missing-api': 11,
    'appmessage-rejected': 7,
    'configuration-unsupported-url': 3,
    'network-unsupported': 2,
    'script-error': 2,
  });
  assert.equal(summary['network-refused'], undefined, 'no sealed failure was a browser refusal');
});
