// Discover and optionally exercise official emulator releases. No visitor projects run here.
// Unreviewed candidate binaries and checkpoints stay in tmp and are never deployment inputs.
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fetchFirmwareReleases, fetchFirmwareRelease } from '../src/app/firmware-catalog.ts';
import { DEFAULT_FIRMWARE } from '../src/app/preview-firmware.ts';
import { readLimited } from '../src/app/projects.ts';
const directory = resolve('tmp/firmware-releases');
await mkdir(directory, { recursive: true });
await rm(join(directory, 'validation.json'), { force: true });
const profiles = ['qemu_emery', 'qemu_flint', 'qemu_gabbro'];
const requested = process.env.PEBBLE_FIRMWARE_TAG?.trim();
if (requested && !/^v\d+\.\d+\.\d+(?:[-.][a-zA-Z0-9.-]+)?$/.test(requested))
  throw new Error('Invalid firmware tag.');
const releases = [];
if (requested)
  releases.push(
    await fetchFirmwareRelease(requested, 'coredevices/PebbleOS', (url, init) =>
      fetch(url, { ...init, signal: AbortSignal.timeout(30000) }),
    ),
  );
else
  for (let page = 1; page <= 10; page++) {
    const items = await fetchFirmwareReleases(page, AbortSignal.timeout(30000));
    releases.push(...items);
    if (items.length < 30) break;
    if (page === 10)
      throw new Error(
        'Release catalog exceeds this checker’s 300-release bound; select an exact tag.',
      );
  }
const candidates = releases
  .filter(
    (r) =>
      !r.prerelease &&
      /^v\d+\.\d+\.\d+$/.test(r.tag) &&
      profiles.every((p) =>
        ['qemu-code', 'qemu-flash'].every(
          (k) =>
            r.assets.filter(
              (a) =>
                a.board === p &&
                a.kind === k &&
                a.name.startsWith(p + '_') &&
                a.name.endsWith('.bin'),
            ).length === 1,
        ),
      ),
  )
  .sort((a, b) => b.tag.localeCompare(a.tag, undefined, { numeric: true }));
const candidate = requested ? candidates.find((r) => r.tag === requested) : candidates[0];
if (!candidate) throw new Error('No matching complete emulator release was found.');
const catalog = {
  version: 1,
  checkedAt: new Date().toISOString(),
  bundledDefault: DEFAULT_FIRMWARE,
  selectedRelease: candidate.tag,
  ...(!requested
    ? { latestAvailable: candidate.tag, updateAvailable: candidate.tag !== DEFAULT_FIRMWARE }
    : {}),
  candidates: candidates.map((r) => ({
    tag: r.tag,
    published: r.published,
    url: r.url,
    assets: r.assets
      .filter((a) => profiles.includes(a.board) && a.name.startsWith(a.board + '_'))
      .map((a) => ({
        name: a.name,
        bytes: a.bytes,
        sha256: a.sha256,
        url: a.url,
        board: a.board,
        kind: a.kind,
      })),
  })),
};
await writeFile(join(directory, 'catalog.json'), JSON.stringify(catalog, null, 2) + '\n');
console.log(
  `Bundled default: ${DEFAULT_FIRMWARE}; ${requested ? 'selected' : 'latest complete stable'} emulator release: ${candidate.tag}`,
);
if (process.argv.includes('--validate')) {
  const versionDirectory = join(directory, candidate.tag);
  await mkdir(versionDirectory, { recursive: true });
  const manifest = {
    version: candidate.tag,
    release: candidate.url,
    distributionApproved: false,
    profiles: {},
  };
  for (const profile of profiles) {
    manifest.profiles[profile] = {};
    for (const [role, kind] of [
      ['micro', 'qemu-code'],
      ['spi', 'qemu-flash'],
    ]) {
      const asset = candidate.assets.find(
        (a) =>
          a.board === profile &&
          a.kind === kind &&
          a.name.startsWith(profile + '_') &&
          a.name.endsWith('.bin'),
      );
      const expected = `${profile}_${candidate.tag}_${role === 'micro' ? 'micro' : 'spi'}_flash.bin`;
      if (
        asset.name !== expected ||
        !/^[a-f0-9]{64}$/.test(asset.sha256 ?? '') ||
        asset.bytes > 32 * 1048576
      )
        throw new Error('Candidate needs exact filenames, sizes and official SHA-256 digests.');
      const expectedUrl = `https://github.com/coredevices/PebbleOS/releases/download/${encodeURIComponent(candidate.tag)}/${expected}`;
      if (asset.url !== expectedUrl) throw new Error('Unexpected candidate download host.');
      const response = await fetch(asset.url, { signal: AbortSignal.timeout(60000) });
      if (!response.ok) throw new Error(`Firmware download returned ${response.status}`);
      const bytes = await readLimited(response, 32 * 1048576);
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      if (bytes.length !== asset.bytes || sha256 !== asset.sha256)
        throw new Error('Candidate checksum mismatch.');
      await writeFile(join(versionDirectory, expected), bytes);
      manifest.profiles[profile][role] = {
        path: expected,
        bytes: bytes.length,
        sha256,
        source: asset.url,
      };
    }
  }
  const manifestPath = join(versionDirectory, 'manifest.json');
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  await new Promise((resolveTask, reject) => {
    const child = spawn(process.execPath, ['scripts/build-startup-checkpoints.mjs'], {
      stdio: 'inherit',
      env: {
        ...process.env,
        PEBBLE_FIRMWARE_MANIFEST: manifestPath,
        PEBBLE_CHECKPOINT_OUTPUT: join(versionDirectory, 'checkpoints'),
      },
    });
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0 ? resolveTask() : reject(new Error('Candidate startup validation failed.')),
    );
  });
  const preparation = JSON.parse(
    await readFile('tmp/startup-checkpoints/preparation.json', 'utf8'),
  );
  const result = {
    release: candidate.tag,
    coreSha256: preparation.coreSha256,
    startupContinuation: 'passed',
    comparisons: preparation.measurements,
    defaultPromotion: 'requires reviewed provenance and independent reference evidence',
    published: false,
  };
  await writeFile(join(directory, 'validation.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(
    'Candidate boot, state restore, input continuation, UART and frame comparisons passed. Candidate artifacts remain outside the website.',
  );
}
