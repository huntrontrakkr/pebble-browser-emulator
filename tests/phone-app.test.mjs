import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import {
  configurationPage,
  navigationResult,
  validStorage,
  CONFIGURATION_LIMIT,
} from '../phone-app/browser/configuration-page.mjs';

test('companion port preserves pinned upstream source and navigation function bodies', async () => {
  const provenance = JSON.parse(await readFile('phone-app/upstream.json', 'utf8'));
  for (const [file, hash] of Object.entries(provenance.files))
    assert.equal(
      createHash('sha256')
        .update(await readFile('phone-app/upstream/' + file))
        .digest('hex'),
      hash,
    );
  const original = await readFile(
    'phone-app/upstream/pebble/src/commonMain/kotlin/coredevices/pebble/ui/WatchappSettingsScreen.kt',
    'utf8',
  );
  const port = await readFile('phone-app/src/wasmJsMain/kotlin/SettingsNavigation.kt', 'utf8');
  const normalizer = original.match(/internal fun normalizeWatchappSettingsUrl[\s\S]*?\n}/)[0];
  assert.ok(port.includes(normalizer));
  const interceptor = original
    .slice(original.indexOf('private class SettingsRequestInterceptor'))
    .trim()
    .replace('private class', 'internal class');
  assert.ok(port.includes(interceptor));
});

test('data configuration preserves HTML and close suffixes, including base64 and Unicode', () => {
  const html = '<button onclick="location.href=\'pebblejs://close#%2525%20雪\'">Save</button>';
  for (const url of [
    'data:text/html,' + encodeURIComponent(html),
    'data:text/html;charset=utf-8;base64,' + Buffer.from(html).toString('base64'),
  ]) {
    const result = configurationPage(url, 'https://example.test/return?session=x&tail=', 'x', {
      value: '</script><script>bad()',
    });
    assert.equal(result.external, false);
    assert.ok(result.html.includes('about:srcdoc#pebblejs://close#%2525%20雪'));
    assert.ok(!result.html.includes('https://example.test/return'));
    assert.ok(!result.html.includes('value":"</script>'));
  }
});
test('local close fragments return unchanged without network access or decoding twice', () => {
  const page = configurationPage('data:text/html,Settings', 'https://preview.test/return', 'nonce');
  const handlers = {},
    messages = [],
    window = {};
  const location = { href: 'about:srcdoc' };
  vm.runInNewContext(page.html.match(/<script>([\s\S]*?)<\/script>/)[1], {
    window,
    location,
    parent: { postMessage: (data) => messages.push(data) },
    addEventListener: (name, handler) => {
      handlers[name] = handler;
    },
  });
  for (const suffix of [
    '#%7B%22value%22%3A%22%2525%20%2B%20%E9%9B%AA%22%7D',
    '/?hello%20world',
    '/hello%2Bworld',
    '',
    '#%zz',
  ]) {
    location.href = 'about:srcdoc#pebblejs://close' + suffix;
    handlers.hashchange();
    assert.deepEqual(JSON.parse(JSON.stringify(messages.at(-1))), {
      kind: 'pebble-config-navigation',
      session: 'nonce',
      url: 'pebblejs://close' + suffix,
    });
  }
  const count = messages.length;
  for (const url of ['about:srcdoc#section', 'https://preview.test/#pebblejs://close#forged']) {
    location.href = url;
    handlers.hashchange();
  }
  assert.equal(messages.length, count);
});
test('remote page uses official return_to without replacing its existing parameters or fragment', () => {
  const result = configurationPage(
    'https://example.test/settings?theme=dark#form',
    'https://preview.test/return?session=x&tail=',
    'x',
  );
  const url = new URL(result.url);
  assert.equal(result.external, true);
  assert.equal(url.searchParams.get('theme'), 'dark');
  assert.equal(url.hash, '#form');
  assert.equal(url.searchParams.get('return_to'), 'https://preview.test/return?session=x&tail=#');
});
test('embedded page retains standards mode and bootstrap precedes application code', () => {
  const html =
    '<!doctype html><html><head><script>app()</script></head><body>Settings</body></html>';
  const page = configurationPage(
    'data:text/html,' + encodeURIComponent(html),
    'https://preview.test/return',
    'x',
  );
  assert.ok(page.html.startsWith('<!doctype html><html><head><script>'));
  assert.ok(page.html.indexOf('embeddedBridge') < page.html.indexOf('app()'));
});
test('browser adapter rejects unsupported protocols, oversized values and unrelated returns', () => {
  for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/plain,hi'])
    assert.throws(() => configurationPage(url, 'https://example.test/', 'x'));
  assert.throws(() =>
    configurationPage('data:text/html,' + 'x'.repeat(CONFIGURATION_LIMIT), '', 'x'),
  );
  assert.equal(
    navigationResult(
      { kind: 'pebble-config-navigation', session: 'old', url: 'pebblejs://close#x' },
      'new',
    ),
    null,
  );
  assert.throws(() =>
    navigationResult(
      { kind: 'pebble-config-navigation', session: 'x', url: 'https://attacker.test/' },
      'x',
    ),
  );
  assert.equal(validStorage({ safe: 'string' }), true);
  assert.equal(validStorage({ nested: {} }), false);
  assert.equal(validStorage({ huge: 'x'.repeat(1048576) }), false);
});

test('callback preserves all native return delimiters while keeping settings out of the HTTP request', async () => {
  const source = await readFile('phone-app/browser/return.mjs', 'utf8');
  const session = '00112233-4455-6677-8899-aabbccddeeff';
  for (const suffix of ['#private%2525', '/?private%20value', '/private%2Bvalue', '']) {
    const location = new URL(
      'https://preview.test/phone-app/return.html?session=' + session + '#' + suffix,
    );
    const messages = [];
    vm.runInNewContext(source, {
      URL,
      location,
      window: {},
      parent: { postMessage: (data) => messages.push(data) },
      document: { querySelector: () => ({}) },
    });
    assert.equal(messages[0].url, 'pebblejs://close' + suffix);
    assert.equal(location.search, '?session=' + session);
  }
});
