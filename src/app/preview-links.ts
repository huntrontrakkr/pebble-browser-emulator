import {
  githubJson,
  importRepository,
  parseRepository,
  readLimited,
  safePath,
  type RepositorySpec,
  type SourceSnapshot,
} from './projects.ts';
import { isFirmwareProfile, FIRMWARE_PROFILES, type FirmwareProfile } from './watch-profiles.ts';

export type PreviewTarget =
  | { kind: 'example'; profile: FirmwareProfile }
  | { kind: 'github'; profile: FirmwareProfile; repository: RepositorySpec; pbw?: string };

/** Hash routes work on any static host, including when installed in a subdirectory. */
export function parsePreviewLink(hash: string): PreviewTarget | null {
  if (!hash || hash === '#/' || hash === '#') return null;
  if (hash.length > 2048) throw new Error('Preview link is too long.');
  const [path, query = ''] = hash.replace(/^#/, '').split('?');
  const params = new URLSearchParams(query);
  for (const key of params.keys()) {
    if (!['watch', 'ref', 'path', 'pbw'].includes(key) || params.getAll(key).length !== 1)
      throw new Error('Unknown or repeated preview link option: ' + key);
  }
  const profile = params.get('watch') ?? 'qemu_emery';
  if (!isFirmwareProfile(profile)) throw new Error('Unsupported preview watch.');
  if (path === '/example/clock') return { kind: 'example', profile };
  const match = path.match(/^\/github\/([^/]+)\/([^/]+)$/);
  if (!match) throw new Error('Unrecognized preview link. Use an example or GitHub preview link.');
  const repository = parseRepository(
    `${decodeURIComponent(match[1])}/${decodeURIComponent(match[2])}`,
    params.get('ref') ?? '',
    params.get('path') ?? '',
  );
  const pbw = params.get('pbw') ?? undefined;
  if (pbw && (!safePath(pbw) || !pbw.endsWith('.pbw')))
    throw new Error('PBW must be a relative .pbw path in the project folder.');
  return { kind: 'github', profile, repository, ...(pbw ? { pbw } : {}) };
}

export function previewLink(base: string, target: PreviewTarget): string {
  const url = new URL(base);
  url.search = '';
  const params = new URLSearchParams();
  if (target.profile !== 'qemu_emery') params.set('watch', target.profile);
  if (target.kind === 'github') {
    if (target.repository.ref) params.set('ref', target.repository.ref);
    if (target.repository.root) params.set('path', target.repository.root);
    if (target.pbw) params.set('pbw', target.pbw);
  }
  url.hash =
    (target.kind === 'example'
      ? '/example/clock'
      : `/github/${encodeURIComponent(target.repository.owner)}/${encodeURIComponent(target.repository.repository)}`) +
    (params.size ? '?' + params.toString() : '');
  // Apply the same validation to generated and incoming links.
  parsePreviewLink(url.hash);
  return url.href;
}

export interface PreviewPackage {
  bytes: Uint8Array;
  name: string;
}
export type RepositoryPreview =
  | { kind: 'package'; package: PreviewPackage; target: PreviewTarget }
  | { kind: 'source'; source: SourceSnapshot; target: PreviewTarget };

export async function repositoryPreview(
  target: Extract<PreviewTarget, { kind: 'github' }>,
  signal: AbortSignal,
  progress: (text: string) => void,
  request: typeof fetch = fetch,
): Promise<RepositoryPreview> {
  signal.throwIfAborted();
  const spec = target.repository;
  const base = `/repos/${encodeURIComponent(spec.owner)}/${encodeURIComponent(spec.repository)}`;
  progress('Finding project…');
  const ref = spec.ref || (await githubJson(base, signal, request)).default_branch;
  const commit = (await githubJson(`${base}/commits/${encodeURIComponent(ref)}`, signal, request))
    .sha;
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('GitHub returned an invalid commit.');
  const pinned = { ...target, repository: { ...spec, ref: commit } };
  const raw = (path: string) =>
    `https://raw.githubusercontent.com/${encodeURIComponent(spec.owner)}/${encodeURIComponent(spec.repository)}/${commit}/${[spec.root, path].filter(Boolean).join('/').split('/').map(encodeURIComponent).join('/')}`;
  let path = target.pbw,
    expectedHash: string | undefined;
  if (!path) {
    const response = await request(raw('pebble-preview.json'), { signal, credentials: 'omit' });
    if (response.ok) {
      const manifest = JSON.parse(new TextDecoder().decode(await readLimited(response, 16384)));
      if (manifest.version !== 1) throw new Error('Unsupported pebble-preview.json version.');
      const item = manifest.packages?.[FIRMWARE_PROFILES[target.profile].platform];
      if (!item)
        throw new Error(
          'This project has no preview package for the selected watch. Choose another watch or build it in Developer tools.',
        );
      path = item.path;
      expectedHash = item.sha256;
      if (typeof expectedHash !== 'string' || !/^[a-f0-9]{64}$/.test(expectedHash))
        throw new Error('Preview manifest needs a SHA-256 for its package.');
    } else if (response.status !== 404)
      throw new Error(`Preview manifest download failed (${response.status}).`);
  }
  if (path) {
    if (typeof path !== 'string' || !safePath(path) || !path.endsWith('.pbw'))
      throw new Error('Preview package must be a relative .pbw path inside the project folder.');
    progress('Downloading watchface…');
    const response = await request(raw(path), { signal, credentials: 'omit' });
    if (!response.ok) throw new Error(`Watchface download failed (${response.status}).`);
    const bytes = await readLimited(response, 8 * 1048576);
    if (expectedHash) {
      const hash = Array.from(
        new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.slice().buffer)),
        (b) => b.toString(16).padStart(2, '0'),
      ).join('');
      if (hash !== expectedHash) throw new Error('Preview package checksum did not match.');
    }
    signal.throwIfAborted();
    return { kind: 'package', package: { bytes, name: path.split('/').pop()! }, target: pinned };
  }
  progress('Importing source for a browser build…');
  const source = await importRepository(pinned.repository, signal, progress, request);
  return { kind: 'source', source, target: pinned };
}
