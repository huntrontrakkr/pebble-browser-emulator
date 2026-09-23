// Store apps that use the network, through the libpebble3 phone in Chromium.
//
// Input is a corpus from `npm run compatibility:corpus` (the store's Most Loved
// collections, with package hashes). Apps qualify when their PebbleKit JS names
// XMLHttpRequest or WebSocket and the package has an emery binary. Each runs in a
// fresh page (survey.mjs): released qemu_emery firmware, the phone with the network on
// (CORS) and the built-in phone's default location, install, then a minute of watching.
// Nothing is answered for the app: requests go to the real services, and a service
// the browser may not read fails as the app would see it.
//
// Usage: node store-survey.mjs <browser build (bundle.mjs output)> <corpus dir> [count] [out.json]
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { unzipSync, strFromU8 } from 'fflate';
import { chromium } from 'playwright';
import { serve } from './serve.mjs';

const [build, corpus] = process.argv.slice(2, 4).map((p) => resolve(p));
const count = Number(process.argv[4] ?? 12);
const out = resolve(process.argv[5] ?? 'store-survey.json');
const seconds = Number(process.env.SURVEY_SECONDS ?? 60);
const parallel = Number(process.env.SURVEY_PARALLEL ?? 1);
const manifest = JSON.parse(await readFile(join(corpus, 'manifest.json'), 'utf8'));

const candidates = [];
const skipped = { noPackage: 0, noJs: 0, noNetwork: 0, noEmery: 0, unreadable: 0 };
for (const entry of manifest.entries) {
  if (!entry.acquisition?.path) {
    skipped.noPackage++;
    continue;
  }
  let files;
  try {
    files = unzipSync(new Uint8Array(await readFile(join(corpus, entry.acquisition.path))));
  } catch {
    skipped.unreadable++;
    continue;
  }
  const js = files['pebble-js-app.js'];
  if (!js) {
    skipped.noJs++;
    continue;
  }
  const source = strFromU8(js);
  const uses = ['XMLHttpRequest', 'WebSocket'].filter((name) => source.includes(name));
  if (!uses.length) {
    skipped.noNetwork++;
    continue;
  }
  if (!Object.keys(files).some((name) => name.startsWith('emery/'))) {
    skipped.noEmery++;
    continue;
  }
  const info = JSON.parse(strFromU8(files['appinfo.json']));
  candidates.push({ ...entry, uuid: info.uuid, uses, geolocation: source.includes('geolocation') });
}
// Most loved first, alternating watchfaces and apps.
const byCategory = Object.groupBy(candidates, (c) => c.category);
const chosen = [];
for (let i = 0; chosen.length < count && i < candidates.length; i++)
  for (const list of Object.values(byCategory))
    if (list[i] && chosen.length < count) chosen.push(list[i]);
console.log(
  `corpus ${manifest.entries.length}; network apps with emery ${candidates.length}; running ${chosen.length}; skipped ${JSON.stringify(skipped)}`,
);

const { url, close } = await serve(build, (request, response) => {
  const path = new URL(request.url, 'http://x').pathname;
  const match = /^\/packages\/([a-f0-9]{24})\.pbw$/.exec(path);
  if (!match) return false;
  readFile(join(corpus, 'packages', `${match[1]}.pbw`)).then(
    (body) => response.writeHead(200, { 'content-type': 'application/octet-stream' }).end(body),
    () => response.writeHead(404).end(),
  );
  return true;
});
const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
});

const results = [];
async function survey(app, relay) {
  const page = await browser.newPage();
  const messages = { sent: 0, acked: 0, nacked: 0 };
  const exceptions = [];
  page.on('console', (m) => {
    const text = m.text();
    if (/sending .*AppMessagePush/.test(text)) messages.sent++;
    else if (/inbound .*AppMessageACK/.test(text)) messages.acked++;
    else if (/inbound .*AppMessageNACK/.test(text)) messages.nacked++;
    else if (/JS Exception/.test(text)) exceptions.push(text.slice(0, 300));
  });
  page.on('pageerror', (error) => exceptions.push(`page: ${error.message}`.slice(0, 300)));
  const relayQuery = relay
    ? `&relay=${encodeURIComponent(relay.endpoint)}&relayKey=${encodeURIComponent(relay.key)}`
    : '';
  const target = `${url}survey.html?pbw=/packages/${app.id}.pbw&uuid=${app.uuid}&seconds=${seconds}${relayQuery}`;
  let result;
  try {
    await page.goto(target);
    await page.waitForFunction(() => window.__result, null, { timeout: (seconds + 300) * 1000 });
    result = await page.evaluate(() => window.__result);
  } catch (error) {
    result = {
      ok: false,
      error: `no result: ${error.message.split('\n')[0]}`,
      pkjs: [],
      network: [],
    };
  }
  await page.close();
  const record = {
    title: app.title,
    id: app.id,
    category: app.category,
    rank: app.rank,
    hearts: app.hearts,
    version: app.version,
    sha256: app.acquisition.sha256,
    uses: app.uses,
    geolocation: app.geolocation,
    running: !!result.running,
    error: result.error,
    requests: result.network.filter((n) => n.kind === 'request'),
    sockets: result.network.filter((n) => n.kind === 'socket'),
    messages,
    exceptions: exceptions.slice(0, 5),
    pkjs: result.pkjs.slice(0, 30),
  };
  return record;
}
// A few pages at once; each is its own firmware, phone and QuickJS.
async function surveyAll(apps, relay) {
  const queue = [...apps];
  const records = [];
  await Promise.all(
    Array.from({ length: parallel }, async () => {
      while (queue.length) records.push(await survey(queue.shift(), relay));
    }),
  );
  return records.sort((a, b) => a.category.localeCompare(b.category) || a.rank - b.rank);
}
results.push(...(await surveyAll(chosen)));

// Why requests failed, asked from here, where CORS does not apply: does the host answer,
// with what status, and does it allow a page on another origin to read the answer? One
// plain GET per distinct target, without the app's query string.
const failed = [
  ...new Set(results.flatMap((r) => r.requests.filter((q) => q.error).map((q) => q.target))),
];
const hosts = {};
for (const target of failed) {
  try {
    const response = await fetch(target, {
      headers: { Origin: 'https://example.invalid' },
      redirect: 'manual',
      signal: AbortSignal.timeout(15000),
    });
    await response.body?.cancel();
    hosts[target] = {
      status: response.status,
      allowOrigin: response.headers.get('access-control-allow-origin'),
    };
  } catch (error) {
    hosts[target] = { unreachable: String(error.cause?.code ?? error.cause ?? error) };
  }
}
const verdict = (target) => {
  const host = hosts[target];
  if (!host) return '';
  if (host.unreachable) return ` [server side: unreachable, ${host.unreachable}]`;
  return ` [server side: ${host.status}, allow-origin ${host.allowOrigin ?? 'none'}]`;
};

for (const record of results) {
  const answered = record.requests.filter((r) => typeof r.status === 'number').length;
  console.log(
    `${record.category} #${record.rank} ${record.title}: ${record.running ? 'running' : 'NOT running'}, ` +
      `${record.requests.length} requests (${answered} answered), ${record.sockets.length} socket events, ` +
      `AppMessages ${record.messages.sent} sent / ${record.messages.acked} acked / ${record.messages.nacked} nacked` +
      (record.error ? `, error: ${record.error}` : ''),
  );
  for (const request of record.requests)
    console.log(
      `    ${request.synchronous ? 'sync ' : ''}${request.method} ${request.target} → ${request.error ?? request.status}` +
        (request.error ? verdict(request.target) : ''),
    );
  for (const socket of record.sockets)
    console.log(
      `    socket ${socket.method} ${socket.target} → ${socket.error ?? socket.status ?? socket.closeCode}`,
    );
  for (const line of record.pkjs.slice(0, 6)) console.log(`    | ${line.slice(0, 160)}`);
  for (const line of record.exceptions.slice(0, 2)) console.log(`    ! ${line.slice(0, 200)}`);
}

// Second pass: apps whose failed hosts answer from here but do not let another origin
// read the answer (CORS), again with the optional relay (services/resources,
// /v1/app-fetch) started for the run with a fresh key, for this page's origin only.
// The relay takes plain HTTPS GET and HEAD without a body, as in the application.
const refusesCors = (target) =>
  hosts[target] && !hosts[target].unreachable && hosts[target].allowOrigin === null;
const relayApps = chosen.filter((app) =>
  results.find((r) => r.id === app.id)?.requests.some((q) => q.error && refusesCors(q.target)),
);
const relayResults = [];
if (relayApps.length && process.env.SURVEY_RELAY !== '0') {
  const { spawn } = await import('node:child_process');
  const { randomBytes } = await import('node:crypto');
  const relayPort = 4318 + Math.floor(Math.random() * 1000);
  const relay = { endpoint: `http://127.0.0.1:${relayPort}`, key: randomBytes(24).toString('hex') };
  const service = spawn(process.execPath, ['services/resources/server.mjs'], {
    env: {
      ...process.env,
      RESOURCE_PORT: String(relayPort),
      RESOURCE_RELAY_KEY: relay.key,
      RESOURCE_ALLOWED_ORIGINS: new URL(url).origin,
      RESOURCE_CACHE_DIR: 'tmp/phone-spike/relay-cache',
    },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  try {
    for (let tries = 0; ; tries++) {
      try {
        const status = await (await fetch(`${relay.endpoint}/v1/status`)).json();
        if (!status.capabilities?.includes('app-relay')) throw new Error('relay not enabled');
        break;
      } catch (error) {
        if (tries > 50) throw error;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
    relayResults.push(...(await surveyAll(relayApps, relay)));
  } finally {
    service.kill();
  }
  console.log(`\nWith the relay (${relayApps.length} apps whose hosts refuse CORS):`);
  for (const record of relayResults) {
    const before = results.find((r) => r.id === record.id);
    const answered = (r) => r.requests.filter((q) => typeof q.status === 'number').length;
    console.log(
      `${record.category} #${record.rank} ${record.title}: ${record.running ? 'running' : 'NOT running'}, ` +
        `${answered(record)}/${record.requests.length} answered (was ${answered(before)}/${before.requests.length}), ` +
        `AppMessages ${record.messages.sent} sent / ${record.messages.acked} acked (was ${before.messages.sent} / ${before.messages.acked})`,
    );
    for (const request of record.requests)
      console.log(
        `    ${request.method} ${request.target} → ${request.error ?? request.status}${request.relayed ? ' (relayed)' : ''}`,
      );
    for (const line of record.pkjs.slice(0, 4)) console.log(`    | ${line.slice(0, 160)}`);
  }
}
await browser.close();
close();
await writeFile(
  out,
  JSON.stringify(
    {
      format: 'libpebble3-store-survey',
      createdAt: new Date().toISOString(),
      corpusCreatedAt: manifest.createdAt,
      firmware: 'qemu_emery v4.37.0',
      network: 'CORS (no relay)',
      location: { latitude: 37.7749, longitude: -122.4194, accuracy: 10 },
      observedSeconds: seconds,
      skipped,
      candidates: candidates.length,
      results,
      failedTargets: hosts,
      relay: {
        endpoint: 'services/resources /v1/app-fetch, started for the run (GET and HEAD over HTTPS)',
        results: relayResults,
      },
    },
    null,
    2,
  ),
);
console.log('SURVEY', out);
