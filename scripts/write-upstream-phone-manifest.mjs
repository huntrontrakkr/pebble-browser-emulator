// Makes sure the built application has libpebble3/manifest.json, which Preview reads
// to learn whether this copy includes the experimental upstream phone. A build with
// the phone published (tools/phone-spike/publish.mjs) already has the real manifest;
// every other build gets an explicit "not included". An absent file would answer 404,
// which the browser logs as an error in every visitor's console.
import { access, mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const target = process.argv[2];
if (!target) throw new Error('Usage: write-upstream-phone-manifest.mjs <path>');
try {
  await access(target);
  console.log(`${target} is present: this copy includes the upstream phone.`);
} catch {
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, JSON.stringify({ included: false }, null, 2) + '\n');
  console.log(`Wrote ${target}: this copy does not include the upstream phone.`);
}
