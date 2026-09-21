// Production UI + real firmware. The forecast is judged by what the unchanged
// firmware answers, never by reading our own encoder back: BlobDB either
// accepts each record or rejects it, and the reject codes are the firmware's
// own validation of the record version, size and location list. Whether the
// Weather app draws it correctly is checked by eye against the screenshot this
// gate leaves behind, which is evidence rather than a pass condition.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { modelServer } from './model-browser-fixtures.mjs';

const server = await modelServer();
const out = resolve(process.env.PEBBLE_TRACE_DIR ?? 'tmp/weather-browser');
await mkdir(out, { recursive: true });
const WEATHER_DATABASE = 5;
const WATCH_APP_PREFS_DATABASE = 9;

try {
  const browser = await chromium.launch();
  const result = {};
  try {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1100 },
      serviceWorkers: 'block',
    });
    page.setDefaultTimeout(120000);
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.addInitScript(() => {
      window.qa = { blob: [], errors: [] };
      const Original = Worker;
      window.Worker = class extends Original {
        constructor(...args) {
          super(...args);
          this.addEventListener('message', ({ data }) => {
            if (data.type === 'protocol' && data.endpoint === 0xb1db)
              window.qa.blob.push({
                direction: data.direction,
                bytes: Array.from(data.bytes),
              });
            if (data.type === 'error') window.qa.errors.push(String(data.message));
          });
        }
      };
    });

    await page.goto(server.base + '#/example/clock?watch=qemu_emery');
    await page
      .getByText('Ready. Use the watch buttons to interact.', { exact: true })
      .waitFor({ timeout: 300000 });
    await page.waitForTimeout(4000);

    // A first-time visitor configures nothing, so the drawer's sample forecast
    // has to reach the watch on its own. It is deliberately not sent with the
    // rest of the demo data: that early, the weather database refuses a record
    // with BLOB_DB_INVALID_DATABASE_ID and accepts the identical one later, so
    // this also guards the timing.
    const unprompted = await page.evaluate(() => window.qa.blob);
    const published = unprompted.filter((p) => p.direction === 'phone').map((p) => p.bytes[3]);
    assert.ok(published.includes(WEATHER_DATABASE), 'sample forecast published unprompted');
    assert.ok(published.includes(WATCH_APP_PREFS_DATABASE), 'its location listed unprompted');
    for (const reply of unprompted.filter((p) => p.direction === 'watch'))
      assert.equal(reply.bytes[2], 1, `firmware accepted the sample forecast: ${reply.bytes[2]}`);
    assert.deepEqual(
      await page.evaluate(() => window.qa.errors),
      [],
      'publishing the sample forecast raises nothing',
    );
    result.unpromptedDatabases = published.filter((db) =>
      [WEATHER_DATABASE, WATCH_APP_PREFS_DATABASE].includes(db),
    );

    await page.getByRole('button', { name: 'Developer tools' }).click();
    await page.getByRole('button', { name: 'Inputs', exact: true }).click();
    await page.getByLabel('Weather source', { exact: true }).first().selectOption('manual');
    await page.getByLabel('Location name', { exact: true }).fill('Palo Alto');
    await page.getByLabel('Condition wording', { exact: true }).fill('Sunny');
    await page.getByLabel('Weather condition', { exact: true }).selectOption('Sun');
    await page.getByLabel('Now (°)', { exact: true }).fill('68');
    await page.getByLabel('Today high (°)', { exact: true }).fill('70');
    await page.getByLabel('Today low (°)', { exact: true }).fill('52');

    await page.evaluate(() => (window.qa.blob.length = 0));
    await page.getByRole('button', { name: 'Send weather to watch' }).click();
    // Wait on the firmware answering both writes. The status line already says
    // the forecast was stored, from the sample published when the preview came
    // up, so waiting for that text would not wait at all.
    await page.waitForFunction(
      () => window.qa.blob.filter((p) => p.direction === 'watch').length >= 2,
    );

    // The firmware's own answers, not ours: BLOB_DB_SUCCESS is 0x01.
    const blob = await page.evaluate(() => window.qa.blob);
    const sent = blob.filter((p) => p.direction === 'phone');
    const replies = blob.filter((p) => p.direction === 'watch');
    const databases = sent.map((p) => p.bytes[3]);
    assert.ok(databases.includes(WEATHER_DATABASE), 'forecast written to the weather database');
    assert.ok(
      databases.includes(WATCH_APP_PREFS_DATABASE),
      'location list written to the watch app preferences database',
    );
    assert.equal(sent.length, 2, 'exactly the two records the forecast needs');
    assert.equal(replies.length, 2, 'the firmware answered both writes');
    for (const reply of replies)
      assert.equal(reply.bytes[2], 1, `firmware accepted the record: status ${reply.bytes[2]}`);
    assert.deepEqual(await page.evaluate(() => window.qa.errors), []);

    // Withdrawing has to leave nothing behind, or a stale forecast outlives the
    // switch that turned it off.
    await page.evaluate(() => (window.qa.blob.length = 0));
    await page.getByLabel('Weather source', { exact: true }).first().selectOption('off');
    await page.getByRole('button', { name: 'Remove forecast' }).click();
    await page.waitForFunction(
      () => window.qa.blob.filter((p) => p.direction === 'watch').length >= 2,
    );
    const withdrawal = await page.evaluate(() => window.qa.blob);
    const withdrawn = withdrawal.filter((p) => p.direction === 'phone');
    assert.equal(withdrawn.length, 2, 'the list is emptied and the record deleted');
    assert.equal(withdrawn[0].bytes[3], WATCH_APP_PREFS_DATABASE, 'the list goes first');
    assert.equal(withdrawn[0].bytes[7 + withdrawn[0].bytes[4]], 0, 'no locations left listed');
    assert.equal(withdrawn[1].bytes[0], 4, 'the record is deleted, not overwritten');
    assert.equal(withdrawn[1].bytes[3], WEATHER_DATABASE);
    for (const reply of withdrawal.filter((p) => p.direction === 'watch'))
      assert.equal(reply.bytes[2], 1, `firmware accepted the withdrawal: ${reply.bytes[2]}`);
    assert.deepEqual(await page.evaluate(() => window.qa.errors), []);

    // Evidence for a human, not a pass condition: this gate asserts what the
    // firmware answered, and a screenshot of the watch's own Weather app is
    // kept beside the results so the drawn forecast can be checked by eye.
    // Reaching it: Back leaves the running app, Select opens the launcher.
    const press = async (key, settle = 1500) => {
      await page.keyboard.press(key);
      await page.waitForTimeout(settle);
    };
    await page
      .locator('[aria-label^="Watch controls"]')
      .focus()
      .catch(() => {});
    await press('ArrowLeft', 2500);
    await press('ArrowRight', 2500);
    await writeFile(
      resolve(out, 'launcher-after-withdrawal.png'),
      await page.locator('canvas').first().screenshot(),
    );

    result.databases = databases;
    result.statuses = replies.map((r) => r.bytes[2]);
    result.withdrawnFrom = withdrawn.map((p) => p.bytes[3]);
    result.errors = errors;
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
  await writeFile(resolve(out, 'results.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
} finally {
  await server.close();
}
