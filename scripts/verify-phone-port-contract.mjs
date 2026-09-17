// Tests the actual compiled upstream Kotlin behavior and an unmodified Clay 1.0.4 page.
import { chromium } from 'playwright';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { getQuickJS } from 'quickjs-emscripten';
import { VirtualPhone } from '../src/app/virtual-phone.ts';
import { bundlePhone } from '../public/compiler/pkjs-bundler.mjs';
import { loadLockedPackages } from '../public/compiler/locked-packages.mjs';
const base = process.env.PEBBLE_BROWSER_URL ?? 'http://127.0.0.1:4201/';
const out = resolve(process.env.PEBBLE_TRACE_DIR ?? 'tmp/phone-port-contract');
await mkdir(out, { recursive: true });
const browser = await chromium.launch();
const records = [];
let vm, esbuild;
try {
  const page = await browser.newPage();
  page.on('pageerror', (error) => console.error('Kotlin harness:', String(error)));
  page.on('response', (response) => {
    if (response.status() >= 400) console.error(response.status(), response.url());
  });
  page.setDefaultTimeout(30000);
  await page.route('**/phone-port-harness.html', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><style>html,body,#phone-screen{width:100%;height:100%;margin:0}</style><div id="phone-screen"></div><script>
    window.events=[];window.phonePort={bind(open,navigate){window.compiledPort={open,navigate}},showPage(url){events.push({type:'open',url})},close(response){events.push({type:'close',response})},resize(){},error(message){events.push({type:'error',message})}};
    </script><script src="phone-app/pebble-phone.js"></script>`,
    }),
  );
  await page.goto(base + 'phone-port-harness.html');
  await page.waitForFunction(() => window.compiledPort);
  for (const [url, expected] of [
    [
      'https://cdn.rawgit.com/groyoh/minimalin/ffd0da5fb45f0722dee6e59eb4b05fa63ca82136/config/index.html',
      'https://raw.githack.com/groyoh/minimalin/ffd0da5fb45f0722dee6e59eb4b05fa63ca82136/config/index.html',
    ],
    [
      'https://example.com/config/index.html?foo=bar',
      'https://example.com/config/index.html?foo=bar',
    ],
  ]) {
    const actual = await page.evaluate((url) => {
      window.events = [];
      compiledPort.open(url, 'Test');
      return window.events[0].url;
    }, url);
    assert.equal(actual, expected);
    records.push({ kind: 'upstream-normalization', url, actual });
  }
  for (const [url, expected] of [
    ['pebblejs://close#%7B%22value%22%3A%22%2525%20%2B%20%E9%9B%AA%22%7D', '{"value":"%25 + 雪"}'],
    ['pebblejs://close/?hello%20world', 'hello world'],
    ['pebblejs://close/hello%2Bworld', 'hello+world'],
    ['pebblejs://close#', null],
    ['pebblejs://close', null],
    ['pebblejs://close/?', null],
  ]) {
    await page.evaluate((url) => {
      window.events = [];
      compiledPort.navigate(url);
    }, url);
    await page.waitForFunction(() => events.length > 0);
    const actual = await page.evaluate(() => events[0]);
    assert.deepEqual(actual, { type: 'close', response: expected });
    records.push({ kind: 'upstream-return', url, actual });
  }
  await page.evaluate(() => {
    events = [];
    compiledPort.navigate('pebblejs://close#%zz');
  });
  assert.equal(await page.evaluate(() => events[0].type), 'error');
  records.push({ kind: 'malformed-return', error: true });
  await page.close();

  if (!process.env.PEBBLE_CLAY_ARCHIVE)
    throw new Error('Set PEBBLE_CLAY_ARCHIVE to the pinned pebble-clay-1.0.4.tgz archive.');
  const archive = await readFile(process.env.PEBBLE_CLAY_ARCHIVE);
  const tarball = 'https://registry.npmjs.org/pebble-clay/-/pebble-clay-1.0.4.tgz';
  const entries = {
    'package.json': { dependencies: { 'pebble-clay': '1.0.4' } },
    'package-lock.json': {
      lockfileVersion: 3,
      packages: {
        '': { dependencies: { 'pebble-clay': '1.0.4' } },
        'node_modules/pebble-clay': {
          version: '1.0.4',
          resolved: tarball,
          integrity:
            'sha512-/rXxmltdW8JyohDzXINdea+d2wnFJVNFiTXfuZsKpySURZSCFMMucX9sZPZvbHnEA4xFINM4iicyhBbvY4ALfw==',
        },
      },
    },
    'src/pkjs/index.js': `var Clay=require('pebble-clay');new Clay([{type:'input',messageKey:'NAME',defaultValue:'Ada',label:'Name'},{type:'submit',defaultValue:'Save'}]);`,
  };
  const sourceFiles = Object.fromEntries(
    Object.entries(entries).map(([name, v]) => [
      name,
      new TextEncoder().encode(typeof v === 'string' ? v : JSON.stringify(v)),
    ]),
  );
  const expanded = await loadLockedPackages({
    sourceFiles,
    request: async (url) => {
      assert.equal(url, tarball);
      return new Response(archive);
    },
  });
  globalThis.self = globalThis;
  esbuild = await import('../node_modules/esbuild-wasm/esm/browser.js');
  await esbuild.initialize({
    wasmModule: await WebAssembly.compile(await readFile('node_modules/esbuild-wasm/esbuild.wasm')),
    worker: false,
  });
  const source = await bundlePhone({
    sourceFiles: expanded,
    esbuild,
    messageKeys: { NAME: 10000 },
  });
  vm = new VirtualPhone(await getQuickJS(), {
    appId: '00112233-4455-6677-8899-aabbccddeeff',
    messageKeys: { NAME: 10000 },
  });
  vm.setConnected(true);
  vm.start(source);
  vm.drainEvents();
  vm.showConfiguration();
  const configuration = vm.drainEvents().find((e) => e.type === 'configuration');
  assert.ok(configuration);
  const clay = await browser.newPage({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
  });
  clay.setDefaultTimeout(30000);
  const errors = [];
  clay.on('pageerror', (e) => errors.push(String(e)));
  await clay.route('**/phone-port-harness.html', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><style>html,body,iframe{margin:0;width:100%;height:100%;border:0}</style><iframe id="phone"></iframe><script>
    window.results=[];const session=crypto.randomUUID();const frame=document.getElementById('phone');
    addEventListener('message',e=>{if(e.source!==frame.contentWindow||e.origin!==location.origin||e.data.session!==session)return;
    if(e.data.type==='phone-app-ready')frame.contentWindow.postMessage({type:'configure',session,appId:'clay-test',title:'Clay',url:window.configurationUrl},location.origin);
    if(e.data.type==='configuration-result')window.results.push(e.data.response);});frame.src='phone-app/index.html?session='+session;
    </script>`,
    }),
  );
  await clay.addInitScript((url) => (window.configurationUrl = url), configuration.url);
  await clay.goto(base + 'phone-port-harness.html');
  const form = clay.frameLocator('#phone').frameLocator('#configuration-page');
  await form.getByLabel('Name', { exact: true }).fill('Lin + 雪');
  await form.getByRole('button', { name: 'Save', exact: true }).click();
  await clay.waitForFunction(() => results.length === 1);
  const response = await clay.evaluate(() => results[0]);
  assert.equal(vm.closeConfiguration(response, configuration.requestId), true);
  const events = vm.drainEvents(),
    message = events.find((e) => e.type === 'outbound');
  assert.deepEqual(message.payload, { 10000: 'Lin + 雪' });
  assert.equal(vm.getStorage()['clay-settings'], '{"NAME":"Lin + 雪"}');
  assert.deepEqual(errors, []);
  records.push({
    kind: 'actual-clay-1.0.4',
    returned: response,
    outbound: message.payload,
    storage: vm.getStorage()['clay-settings'],
    scope:
      'Actual Clay HTML -> compiled upstream handler -> actual Clay PKJS -> pending AppMessage. Firmware ACK is verified separately with native Clock.',
  });
  await clay.close();
  for (const blocked of [false, true]) {
    const remote = await browser.newPage();
    remote.on('console', (m) => {
      if (m.type() === 'error') console.error('Remote fixture:', m.text());
    });
    remote.on('pageerror', (e) => console.error('Remote fixture:', String(e)));
    remote.on('requestfailed', (r) => console.error('Remote request:', r.url(), r.failure()));
    remote.setDefaultTimeout(20000);
    // Serve the built static module at HTTPS test origins. Chromium correctly blocks
    // external sandbox pages navigating to loopback; do not disable that protection.
    const remoteBase = 'https://preview.pebble.test/';
    const remoteUrl = 'https://config.pebble.test/settings';
    await remote.context().route(remoteBase + 'phone-app/**', async (route) => {
      const path = new URL(route.request().url()).pathname.slice(1);
      const type = path.endsWith('.wasm')
        ? 'application/wasm'
        : path.endsWith('.html')
          ? 'text/html; charset=utf-8'
          : 'text/javascript';
      await route.fulfill({
        contentType: type,
        body: await readFile(resolve('dist/client', path)),
      });
    });
    await remote.context().route(new URL(remoteUrl).origin + '/**', (route) =>
      route.fulfill({
        contentType: 'text/html; charset=utf-8',
        headers: blocked ? { 'x-frame-options': 'DENY' } : {},
        body: `<!doctype html><meta name="viewport" content="width=device-width"><button onclick="location.href=new window.URL(location.href).searchParams.get('return_to')+encodeURIComponent('Remote + 雪')">Save remote</button>`,
      }),
    );
    await remote.route('**/phone-port-harness.html', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><style>html,body,iframe{margin:0;width:100%;height:100%;border:0}</style><iframe id="phone"></iframe><script>
      window.results=[];const session=crypto.randomUUID();const frame=document.getElementById('phone');
      addEventListener('message',e=>{if(e.source!==frame.contentWindow||e.origin!==location.origin||e.data.session!==session)return;
      if(e.data.type==='phone-app-ready')frame.contentWindow.postMessage({type:'configure',session,appId:'remote-test',title:'Remote',url:'${remoteUrl}'},location.origin);
      if(e.data.type==='configuration-result')window.results.push(e.data.response);});frame.src='phone-app/index.html?session='+session;</script>`,
      }),
    );
    await remote.goto(remoteBase + 'phone-port-harness.html');
    const host = remote.frameLocator('#phone');
    if (blocked) {
      const popup = remote.waitForEvent('popup');
      await host.getByRole('button', { name: 'Open in new tab' }).click();
      const tab = await popup;
      await tab.getByRole('button', { name: 'Save remote' }).click();
      await tab
        .getByText('Settings returned. You can return to the watch preview.', { exact: true })
        .waitFor();
      await tab.close();
    } else
      await host
        .frameLocator('#configuration-page')
        .getByRole('button', { name: 'Save remote' })
        .click();
    await remote
      .waitForFunction(() => results.length === 1)
      .catch(async (error) => {
        console.error(
          'Remote frames',
          remote.frames().map((f) => f.url()),
        );
        throw error;
      });
    assert.equal(await remote.evaluate(() => results[0]), 'Remote + 雪');
    records.push({
      kind: blocked ? 'remote-blocked-frame-new-tab' : 'remote-embedded-return_to',
      response: 'Remote + 雪',
      scope:
        'Browser-served HTTP page fixture, including real X-Frame-Options enforcement and static callback. No production external site availability claim.',
    });
    await remote.close();
  }
  console.log('Compiled Kotlin return cases and actual Clay form passed.');
  await writeFile(
    resolve(out, 'phone-port-contract.json'),
    JSON.stringify(
      { date: new Date().toISOString(), browser: browser.version(), records },
      null,
      2,
    ) + '\n',
  );
} finally {
  vm?.dispose();
  esbuild?.stop();
  await browser.close();
}
