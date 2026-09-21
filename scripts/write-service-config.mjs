// Writes the deployment's service-config.json beside the built application.
//
// A published copy uses this to point visitors at its own relay without anyone
// configuring one. The file is deliberately absent from the repository and from
// any build that does not set both variables, because the static application
// has to keep working with no service at all.
//
// The relay key here reaches every visitor's browser. That is by design: it
// authorizes the relay and is rotated by publishing a new file. It is not a
// password, and nothing else may be put in this file.
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const target = process.argv[2];
if (!target) throw new Error('Usage: write-service-config.mjs <path>');

const endpoint = (process.env.ENDPOINT ?? '').trim();
const relayKey = (process.env.RELAY_KEY ?? '').trim();
if (!endpoint || !relayKey)
  throw new Error('Both ENDPOINT and RELAY_KEY are required to write a service config.');

// The same rules the application applies when it reads the file back, checked
// here so a malformed value fails the build rather than being silently ignored
// by every visitor.
const url = new URL(endpoint);
const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
if (url.protocol !== 'https:' && !(local && url.protocol === 'http:'))
  throw new Error('The service endpoint must be HTTPS, or HTTP on localhost.');
if (url.username || url.password || url.search || url.hash)
  throw new Error('The service endpoint carries credentials or a query it must not have.');
if (relayKey.length < 16 || relayKey.length > 256)
  throw new Error('The relay key must be 16 to 256 characters.');

await mkdir(dirname(target), { recursive: true });
await writeFile(
  target,
  JSON.stringify({ endpoint: url.href.replace(/\/$/, ''), relayKey }, null, 2) + '\n',
);
console.log(`Published copy will use the relay at ${url.origin}`);
