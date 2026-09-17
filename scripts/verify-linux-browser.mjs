// Optional real browser Linux/Wasm gate. The image must provide Python 3.
import { chromium } from 'playwright';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
if (!process.env.PEBBLE_LINUX_IMAGE)
  throw new Error('Set PEBBLE_LINUX_IMAGE to a local WASI Linux image.');
const out = resolve(process.env.PEBBLE_TRACE_DIR ?? 'tmp/linux-browser');
const base = process.env.PEBBLE_BROWSER_URL ?? 'http://127.0.0.1:4201/';
const source = resolve(out, 'source');
await mkdir(source, { recursive: true });
const recipe =
  'version: 1\nbackend: linux-wasi\ncommands: ["python3 generate.py"]\noutputs: [generated.c]\ntimeoutSeconds: 180\n';
const expected = 'int answer(void) { return 42; }\n';
await writeFile(resolve(source, '.pebble-browser.yml'), recipe);
await writeFile(
  resolve(source, 'generate.py'),
  'import pathlib\npathlib.Path("generated.c").write_text(' + JSON.stringify(expected) + ')\n',
);
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({
  viewport: { width: 1440, height: 1000 },
  acceptDownloads: true,
});
const errors = [],
  requests = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('request', (r) => requests.push(r.url()));
page.setDefaultTimeout(180000);
try {
  await page.goto(base);
  await page.getByText('Core ready', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Projects', exact: true }).click();
  await page.getByLabel('Open project folder', { exact: true }).setInputFiles(source);
  await page.getByText('Linux compatibility build', { exact: true }).click();
  const panel = page.locator('linux-build-panel');
  await page.getByText('Project build recipe loaded.', { exact: true }).waitFor();
  assert.equal(await panel.locator('textarea').inputValue(), recipe);
  await page
    .getByLabel('Open container2wasm WASI image', { exact: true })
    .setInputFiles(resolve(process.env.PEBBLE_LINUX_IMAGE));
  await page.getByText('Linux image loaded.', { exact: true }).waitFor();
  console.log('Large image loaded and saved.');
  // The reference image is larger than Chromium's serialized-record limit. Verify that
  // Blob-backed persistence survives a real reload before starting the Worker.
  await page.reload();
  await page.getByText('Core ready', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Projects', exact: true }).click();
  await page.getByText('Linux compatibility build', { exact: true }).click();
  await page.getByRole('button', { name: 'Build in Linux', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Build in Linux', exact: true }).click();
  console.log('Build started after reloading the page.');
  await panel.getByRole('button', { name: 'Cancel Linux build', exact: true }).waitFor();
  await panel
    .getByRole('button', { name: 'Cancel Linux build', exact: true })
    .waitFor({ state: 'hidden' });
  assert.match(
    await panel.locator('.status-message').innerText(),
    /Linux build complete · 1 artifacts/,
  );
  const download = page.waitForEvent('download');
  await panel.getByRole('button', { name: 'Save artifact', exact: true }).click();
  await (await download).saveAs(resolve(out, 'generated.c'));
  assert.equal(await readFile(resolve(out, 'generated.c'), 'utf8'), expected);
  const recordDownload = page.waitForEvent('download');
  await panel.getByRole('button', { name: 'Save build record', exact: true }).click();
  await (await recordDownload).saveAs(resolve(out, 'build-record.json'));
  // A fresh second build is canceled through the actual UI, including a pending Wasm compile.
  await page.getByRole('button', { name: 'Build in Linux', exact: true }).click();
  await panel.getByRole('button', { name: 'Cancel Linux build', exact: true }).click();
  await panel.getByText('Linux build canceled.', { exact: true }).waitFor();
  assert.deepEqual(errors, []);
  const externalRequests = [
    ...new Set(requests.filter((u) => new URL(u).origin !== new URL(base).origin)),
  ];
  assert.deepEqual(externalRequests, []);
  await writeFile(
    resolve(out, 'browser.json'),
    JSON.stringify(
      {
        date: new Date().toISOString(),
        browser: 'chromium',
        version: browser.version(),
        passed: true,
        errors,
        externalRequests,
        artifactSha256: createHash('sha256').update(expected).digest('hex'),
        checks: [
          'local folder import',
          'project YAML loaded',
          'large Linux image persisted across reload',
          'actual Linux Python execution',
          'artifact and build record download',
          'cancel through UI',
        ],
        limitations: [
          'Python generation only; complete SDK/Waf/PBW and other browser build engines remain separate gates.',
        ],
      },
      null,
      2,
    ) + '\n',
  );
  console.log('Browser Linux build and cancellation passed.');
} catch (error) {
  await writeFile(
    resolve(out, 'failed.txt'),
    await page
      .locator('body')
      .innerText()
      .catch(() => 'Page unavailable'),
  );
  throw error;
} finally {
  await browser.close();
}
