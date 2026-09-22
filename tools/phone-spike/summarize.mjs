// Condenses a Gradle log from the spike into what blocks a browser build:
// dependencies with no browser variant, and compile errors grouped by package
// and by kind. Printed to the job log so it can be read without artifacts.
import { readFile } from 'node:fs/promises';

const log = await readFile(process.argv[2], 'utf8');
const lines = log.split('\n');

const unresolved = new Set();
for (const [i, line] of lines.entries())
  if (/Could not resolve |No matching variant of |Could not find /.test(line))
    unresolved.add(line.trim() + (lines[i + 1]?.includes('Required by') ? '' : ''));

const errors = lines
  .filter((l) => /^e: /.test(l))
  .map((l) => {
    const m = l.match(/^e: file:\/\/.*?\/libpebble3\/src\/([^:]+):(\d+):\d+ (.*)$/);
    return m ? { file: m[1], line: +m[2], message: m[3] } : { file: '?', line: 0, message: l };
  });
const count = (key) => {
  const map = new Map();
  for (const e of errors) map.set(key(e), (map.get(key(e)) ?? 0) + 1);
  return [...map].sort((a, b) => b[1] - a[1]);
};

console.log(`== Unresolved dependencies (${unresolved.size})`);
for (const u of unresolved) console.log('  ' + u);
console.log(`\n== Compile errors: ${errors.length}`);
console.log('\n-- by package');
for (const [k, n] of count((e) => e.file.split('/').slice(0, -1).slice(-2).join('/')).slice(0, 40))
  console.log(`  ${String(n).padStart(4)}  ${k}`);
console.log('\n-- by kind');
for (const [k, n] of count((e) =>
  e.message
    .replace(/'[^']*'/g, "'…'")
    .replace(/\d+/g, 'N')
    .slice(0, 90),
).slice(0, 25))
  console.log(`  ${String(n).padStart(4)}  ${k}`);
console.log('\n-- most-missing names');
for (const [k, n] of count((e) => e.message.match(/Unresolved reference '([^']+)'/)?.[1] ?? '')
  .filter(([k]) => k)
  .slice(0, 40))
  console.log(`  ${String(n).padStart(4)}  ${k}`);
console.log('\n-- first 80 errors');
for (const e of errors.slice(0, 80)) console.log(`  ${e.file}:${e.line} ${e.message}`);
if (!errors.length && !unresolved.size) {
  console.log('\n-- no errors found; log tail');
  console.log(lines.slice(-80).join('\n'));
}
