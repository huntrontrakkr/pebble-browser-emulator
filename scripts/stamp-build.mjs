// Stamps the built page with the commit it was built from.
//
// The stamp goes into index.html rather than a file fetched at runtime, so it
// travels with the bundle it describes. A separately fetched stamp could be
// served from a different deployment than the running code and claim a commit
// that is not the one executing.
//
// A build from a tree with uncommitted changes says so. The commit alone would
// name code that is not what was built, which is exactly the kind of claim this
// project does not make.
import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

const page = process.argv[2] ?? 'dist/client/index.html';

function git(args) {
  try {
    return execFileSync('git', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

// GITHUB_SHA is the commit the workflow checked out, which is what a published
// copy was built from. A local build asks git. Neither is an error: a source
// archive with no git and no workflow simply carries no stamp.
const commit = (process.env.GITHUB_SHA ?? '').trim() || git(['rev-parse', 'HEAD']);
const dirty = process.env.GITHUB_SHA ? '' : git(['status', '--porcelain']);
const repository =
  (process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY
    ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}`
    : '') || 'https://github.com/huntrontrakkr/pebble-browser-emulator';

if (!/^[0-9a-f]{40}$/.test(commit)) {
  console.log('No commit available; the page is published without a build stamp.');
  process.exit(0);
}

const html = await readFile(page, 'utf8');
const meta = [
  `<meta name="build-commit" content="${commit}" />`,
  `<meta name="build-repository" content="${repository}" />`,
  `<meta name="build-time" content="${new Date().toISOString()}" />`,
  dirty ? `<meta name="build-modified" content="true" />` : '',
]
  .filter(Boolean)
  .join('\n    ');

if (html.includes('name="build-commit"'))
  throw new Error('This page already carries a build stamp.');
const anchor = '</head>';
if (!html.includes(anchor)) throw new Error(`No </head> in ${page}.`);
await writeFile(page, html.replace(anchor, `  ${meta}\n  ${anchor}`));
console.log(
  `Stamped ${page} with ${commit.slice(0, 7)}${dirty ? ' (tree had uncommitted changes)' : ''}`,
);
