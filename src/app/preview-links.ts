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
import { storeApp, storePackageUrl } from './store-catalog.ts';
import { cachedResource } from './resource-cache.ts';
import { resourceFetch } from './resource-fetch.ts';

export type PreviewTarget =
  | { kind: 'example'; profile: FirmwareProfile }
  | {
      kind: 'github';
      profile: FirmwareProfile;
      repository: RepositorySpec;
      pbw?: string;
      release?: string;
      asset?: string;
      sha256?: string;
    }
  | {
      kind: 'store';
      profile: FirmwareProfile;
      appId: string;
      pbw?: string;
      version?: string;
      sha256?: string;
      title?: string;
    };

/** Hash routes work on any static host, including when installed in a subdirectory. */
export function parsePreviewLink(hash: string): PreviewTarget | null {
  if (!hash || hash === '#/' || hash === '#') return null;
  if (hash.length > 2048) throw new Error('Preview link is too long.');
  const [path, query = ''] = hash.replace(/^#/, '').split('?');
  const params = new URLSearchParams(query);
  for (const key of params.keys()) {
    if (
      !['watch', 'ref', 'path', 'pbw', 'sha256', 'version', 'release', 'asset', 'title'].includes(
        key,
      ) ||
      params.getAll(key).length !== 1
    )
      throw new Error('Unknown or repeated preview link option: ' + key);
  }
  const profile = params.get('watch') ?? 'qemu_emery';
  if (!isFirmwareProfile(profile)) throw new Error('Unsupported preview watch.');
  if (path === '/example/clock') {
    if ([...params.keys()].some((k) => k !== 'watch'))
      throw new Error('Unexpected example option.');
    return { kind: 'example', profile };
  }
  const store = path.match(/^\/store\/([a-f0-9]{24})$/);
  if (store) {
    if ([...params.keys()].some((k) => !['watch', 'pbw', 'version', 'sha256', 'title'].includes(k)))
      throw new Error('Unexpected store option.');
    const title = params.get('title') ?? undefined;
    if (
      title !== undefined &&
      (!title.trim() || title.length > 200 || /[\x00-\x1f\x7f]/.test(title))
    )
      throw new Error('Invalid store title.');
    const pbw = params.get('pbw'),
      version = params.get('version'),
      sha256 = params.get('sha256');
    if (pbw || version || sha256) {
      if (!pbw || !version || version.length > 100 || !sha256 || !/^[a-f0-9]{64}$/.test(sha256))
        throw new Error('A pinned store link needs its package URL, version and SHA-256.');
      return {
        kind: 'store',
        profile,
        appId: store[1],
        pbw: storePackageUrl(pbw, store[1]),
        version,
        sha256,
        ...(title ? { title } : {}),
      };
    }
    return { kind: 'store', profile, appId: store[1] };
  }
  const match = path.match(/^\/github\/([^/]+)\/([^/]+)$/);
  if (!match)
    throw new Error('Unrecognized preview link. Use an example, store or GitHub preview link.');
  if (params.has('version') || params.has('title')) throw new Error('Unexpected GitHub option.');
  const repository = parseRepository(
    `${decodeURIComponent(match[1])}/${decodeURIComponent(match[2])}`,
    params.get('ref') ?? '',
    params.get('path') ?? '',
  );
  const pbw = params.get('pbw') ?? undefined;
  if (pbw && (!safePath(pbw) || !pbw.endsWith('.pbw')))
    throw new Error('PBW must be a relative .pbw path in the project folder.');
  const release = params.get('release') ?? undefined,
    asset = params.get('asset') ?? undefined,
    sha256 = params.get('sha256') ?? undefined;
  if (
    (release || asset) &&
    (!release ||
      !asset ||
      pbw ||
      !/^[^\s\x00-\x1f]{1,200}$/.test(release) ||
      !/^[^/\\\x00-\x1f]{1,200}\.pbw$/.test(asset))
  )
    throw new Error('Select a release tag and a PBW attachment filename.');
  if (sha256 && !/^[a-f0-9]{64}$/.test(sha256)) throw new Error('Invalid package SHA-256.');
  return {
    kind: 'github',
    profile,
    repository,
    ...(pbw ? { pbw } : {}),
    ...(release ? { release, asset } : {}),
    ...(sha256 ? { sha256 } : {}),
  };
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
    if (target.release) params.set('release', target.release);
    if (target.asset) params.set('asset', target.asset);
    if (target.sha256) params.set('sha256', target.sha256);
  }
  if (target.kind === 'store') {
    if (target.pbw) params.set('pbw', target.pbw);
    if (target.version) params.set('version', target.version);
    if (target.sha256) params.set('sha256', target.sha256);
    if (target.title) params.set('title', target.title);
  }
  url.hash =
    (target.kind === 'example'
      ? '/example/clock'
      : target.kind === 'store'
        ? `/store/${target.appId}`
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
  request: typeof fetch = resourceFetch,
): Promise<RepositoryPreview> {
  signal.throwIfAborted();
  const spec = target.repository;
  const base = `/repos/${encodeURIComponent(spec.owner)}/${encodeURIComponent(spec.repository)}`;
  progress('Finding project…');
  if (target.release && target.asset) {
    const expectedUrl = `https://github.com/${spec.owner}/${spec.repository}/releases/download/${encodeURIComponent(target.release)}/${encodeURIComponent(target.asset)}`;
    let hash = target.sha256;
    if (!hash) {
      const release = await githubJson(
        `${base}/releases/tags/${encodeURIComponent(target.release)}`,
        signal,
        request,
      );
      const asset = release.assets?.find((a: any) => a.name === target.asset);
      if (
        !asset ||
        typeof asset.browser_download_url !== 'string' ||
        !Number.isSafeInteger(asset.size) ||
        asset.size < 0 ||
        asset.size > 8 * 1048576
      )
        throw new Error('This release has no matching PBW attachment within the 8 MiB limit.');
      if (new URL(asset.browser_download_url).href !== expectedUrl)
        throw new Error('Unexpected release asset URL.');
      hash =
        typeof asset.digest === 'string' && asset.digest.startsWith('sha256:')
          ? asset.digest.slice(7)
          : undefined;
    }
    progress('Downloading release package…');
    const downloaded = await cachedResource(expectedUrl, {
      signal,
      maximum: 8 * 1048576,
      sha256: hash,
      request,
      ttlMs: hash ? Infinity : 0,
    });
    return {
      kind: 'package',
      package: { bytes: downloaded.bytes, name: target.asset },
      target: { ...target, sha256: downloaded.sha256 },
    };
  }
  const ref = spec.ref || (await githubJson(base, signal, request)).default_branch;
  const commit = (await githubJson(`${base}/commits/${encodeURIComponent(ref)}`, signal, request))
    .sha;
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('GitHub returned an invalid commit.');
  const pinned = { ...target, repository: { ...spec, ref: commit } };
  const raw = (path: string) =>
    `https://raw.githubusercontent.com/${encodeURIComponent(spec.owner)}/${encodeURIComponent(spec.repository)}/${commit}/${[spec.root, path].filter(Boolean).join('/').split('/').map(encodeURIComponent).join('/')}`;
  let path = target.pbw,
    expectedHash: string | undefined = target.sha256;
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

export async function storePreview(
  target: Extract<PreviewTarget, { kind: 'store' }>,
  signal: AbortSignal,
  progress: (text: string) => void,
  request?: typeof fetch,
): Promise<{ package: PreviewPackage; target: PreviewTarget; title: string }> {
  let url = target.pbw,
    version = target.version,
    title = target.title ?? `Store app ${target.appId}`;
  if (!url) {
    progress('Finding watchface…');
    const app = await storeApp(target.appId, target.profile, signal, request);
    if (!app.platforms.includes(FIRMWARE_PROFILES[target.profile].platform))
      throw new Error('This watchface has no package for the selected watch.');
    url = app.packageUrl;
    version = app.version;
    title = app.title;
  }
  progress('Downloading watchface…');
  const downloaded = await cachedResource(storePackageUrl(url, target.appId), {
    maximum: 8 * 1048576,
    signal,
    sha256: target.sha256,
    request,
  });
  return {
    package: { bytes: downloaded.bytes, name: `${title}.pbw` },
    target: { ...target, pbw: url, version, sha256: downloaded.sha256, title },
    title,
  };
}
