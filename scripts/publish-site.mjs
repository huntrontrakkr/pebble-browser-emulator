// Prepares the built page for a custom domain.
//
// Two things break when a copy moves off the default address. GitHub Pages
// serves a custom domain only when the published artifact carries a CNAME file,
// and the link-preview tags are absolute URLs -- unfurlers do not resolve
// <base href> -- so they keep pointing at the old address and unfurl the wrong
// site with a broken image.
//
// With no domain configured this does nothing, so the default deployment is
// unchanged.
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const directory = process.argv[2] ?? 'dist/client';
const domain = (process.env.SITE_DOMAIN ?? '').trim().toLowerCase();

/** The address the checked-in tags are written for. */
export const DEFAULT_BASE = 'https://huntrontrakkr.github.io/pebble-browser-emulator/';

/** A bare hostname: no scheme, port, path or trailing dot. */
export function validDomain(value) {
  return (
    /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/.test(value) && value.length <= 253
  );
}

export async function publishSite(directory, domain) {
  if (!domain) return 'No SITE_DOMAIN; publishing at the default address.';
  if (!validDomain(domain))
    throw new Error(
      `SITE_DOMAIN must be a bare hostname such as pebble.example.com, not "${domain}".`,
    );

  // Pages reads this file from the artifact to know which domain it serves.
  await writeFile(join(directory, 'CNAME'), `${domain}\n`);

  const page = join(directory, 'index.html');
  const html = await readFile(page, 'utf8');
  const base = `https://${domain}/`;
  const rewritten = html.split(DEFAULT_BASE).length - 1;
  const updated = html.replaceAll(DEFAULT_BASE, base);
  if (updated.includes(DEFAULT_BASE)) throw new Error('The default address survived the rewrite.');
  await writeFile(page, updated);
  return `Publishing at ${base}: wrote CNAME and rewrote ${rewritten} absolute URLs.`;
}

// Only when run as a command. The tests import the helpers above.
if (import.meta.main) console.log(await publishSite(directory, domain));
