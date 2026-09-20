// Runs the whole verification suite against one built application.
//
// Gates used to be listed by hand in the workflow, so a gate that nobody
// remembered to add simply never ran: nineteen of twenty-five were in that
// state, and regressions they would have caught reached releases. This
// discovers every scripts/verify-*.mjs instead, so adding a gate is enough to
// make it run, and a gate that cannot run says so rather than passing quietly.
import { readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, join, extname } from 'node:path';
import { argv, env, exit } from 'node:process';

const ROOT = resolve('dist/client');
const PORT = Number(env.PEBBLE_VERIFY_PORT ?? 4201);
const TIMEOUT_MS = Number(env.PEBBLE_VERIFY_TIMEOUT_MS ?? 600000);

/**
 * Gates needing locally supplied material. Each key was taken from the gate's
 * own refusal message, so the suite reports "not run, needs X" instead of
 * failing in a way that looks like a defect in the application.
 */
const REQUIREMENTS = {
  'verify-app-reference': ['PEBBLE_FIRMWARE_DIR', 'PEBBLE_APP_PBW'],
  'verify-audio-reference': ['PEBBLE_QEMU'],
  'verify-browser-workflow': [
    'PEBBLE_FIRMWARE_DIR',
    'PEBBLE_SENSOR_PBW',
    'PEBBLE_SENSOR_REFERENCE',
  ],
  'verify-fidelity-run': ['PEBBLE_FIRMWARE_DIR'],
  'verify-linux-arm-build': ['PEBBLE_LINUX_IMAGE', 'PEBBLE_LINUX_APKS'],
  'verify-linux-browser': ['PEBBLE_LINUX_IMAGE'],
  'verify-sensor-reference': ['PEBBLE_FIRMWARE_DIR', 'PEBBLE_SENSOR_PBW'],
  'verify-store-watchface-browser': ['PEBBLE_STORE_PBW'],
};
/** Gates driven by command-line arguments, so they are run deliberately. */
const MANUAL = new Set([
  'verify-browser-builds',
  'verify-demo-firmware',
  'verify-sifli-browser',
  'verify-sifli-execution',
]);
/** Gates that are not part of the application suite. */
const EXCLUDED = new Set(['verify-all', 'verify-hosted-site', 'verify-reference']);

const mime = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.wasm': 'application/wasm',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.pbw': 'application/octet-stream',
  '.gz': 'application/gzip',
};

/** One static server for every gate that expects the application already served. */
async function serve() {
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, `http://127.0.0.1:${PORT}`);
      let path = resolve(
        ROOT,
        decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html',
      );
      if (!path.startsWith(ROOT)) throw new Error('outside root');
      if ((await stat(path).catch(() => null))?.isDirectory()) path = join(path, 'index.html');
      const bytes = await readFile(path);
      response.writeHead(200, {
        'Content-Type': mime[extname(path)] ?? 'application/octet-stream',
        'Cache-Control': 'no-store',
      });
      response.end(bytes);
    } catch {
      response.writeHead(404);
      response.end('Not found');
    }
  });
  await new Promise((done, fail) => {
    server.once('error', fail);
    server.listen(PORT, '127.0.0.1', done);
  });
  return server;
}

function run(script) {
  return new Promise((done) => {
    const started = Date.now();
    const child = spawn(process.execPath, [...process.execArgv, script], {
      env: { PEBBLE_BROWSERS: env.PEBBLE_BROWSERS ?? 'chromium', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (c) => (output += c));
    child.stderr.on('data', (c) => (output += c));
    const timer = setTimeout(() => child.kill('SIGKILL'), TIMEOUT_MS);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      done({
        code: code ?? 1,
        signal,
        ms: Date.now() - started,
        output: output.slice(-4000),
      });
    });
  });
}

const only = argv.slice(2).filter((a) => !a.startsWith('-'));
const names = (await readdir('scripts'))
  .filter((f) => f.startsWith('verify-') && f.endsWith('.mjs'))
  .map((f) => f.slice(0, -4))
  .filter((n) => !EXCLUDED.has(n))
  .filter((n) => !only.length || only.includes(n))
  .sort();

const server = await serve();
console.log(`Serving ${ROOT} on http://127.0.0.1:${PORT} for ${names.length} gates\n`);

const results = [];
for (const name of names) {
  if (MANUAL.has(name) && !only.length) {
    results.push({ name, state: 'skipped', detail: 'run deliberately with arguments', ms: 0 });
    console.log(`SKIP  ${name} — run deliberately with arguments`);
    continue;
  }
  const missing = (REQUIREMENTS[name] ?? []).filter((key) => !env[key]);
  if (missing.length) {
    results.push({ name, state: 'skipped', detail: `needs ${missing.join(', ')}`, ms: 0 });
    console.log(`SKIP  ${name} — needs ${missing.join(', ')}`);
    continue;
  }
  const { code, signal, ms, output } = await run(join('scripts', `${name}.mjs`));
  const state = code === 0 ? 'passed' : signal ? 'timed out' : 'failed';
  results.push({ name, state, ms, detail: code === 0 ? '' : firstProblem(output) });
  console.log(
    `${state === 'passed' ? 'PASS' : 'FAIL'}  ${name}  ${(ms / 1000).toFixed(1)}s` +
      (state === 'passed' ? '' : `\n      ${firstProblem(output)}`),
  );
}

/** The first line that looks like the reason, so a summary is readable. */
function firstProblem(output) {
  const line = output
    .split('\n')
    .map((l) => l.trim())
    .find((l) => /^(Error|AssertionError|TypeError|\w*Error:)|Timeout|exceeded|expected/i.test(l));
  return (line ?? output.split('\n').filter(Boolean).at(-1) ?? 'no output').slice(0, 200);
}

server.close();
const failed = results.filter((r) => r.state !== 'passed' && r.state !== 'skipped');
const passed = results.filter((r) => r.state === 'passed');
const skipped = results.filter((r) => r.state === 'skipped');
console.log(
  `\n${passed.length} passed, ${failed.length} failed, ${skipped.length} skipped` +
    ` of ${results.length} gates`,
);
for (const r of failed) console.log(`  failed: ${r.name} — ${r.detail}`);
exit(failed.length ? 1 : 0);
