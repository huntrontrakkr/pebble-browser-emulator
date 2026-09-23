// Opens the built application (with public/libpebble3 published into it) in Chromium and
// checks that Preview's Phone tab found the upstream phone and names its build.
// Usage: node preview-check.mjs <built site, e.g. dist/client>
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { serve } from './serve.mjs';

const { url, close } = await serve(resolve(process.argv[2]));
const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
});
const page = await browser.newPage();
page.on('pageerror', (error) => console.log(`[pageerror] ${error.message}`));
await page.goto(url);
// The developer tools load when first opened; the upstream phone is on their Phone tab.
await page.getByRole('button', { name: 'Developer tools' }).click();
await page.locator('nav.tabs button', { hasText: 'Phone' }).click();
const section = page.locator('section.upstream-phone');
let result;
try {
  await section.waitFor({ state: 'attached', timeout: 60000 });
  await page.waitForFunction(
    () => {
      const status = document.querySelector('section.upstream-phone [role=status]');
      return status && status.textContent.trim() !== 'Checking this build…';
    },
    null,
    { timeout: 30000 },
  );
  result = {
    status: (await section.locator('[role=status]').textContent()).trim(),
    build: (await section.locator('dd').first().textContent()).trim(),
  };
} catch (error) {
  result = { error: error.message };
}
console.log('PREVIEW', JSON.stringify(result));
await browser.close();
close();
process.exit(
  result.status === 'Not connected' && /coredevices\/mobileapp/.test(result.build) ? 0 : 1,
);
