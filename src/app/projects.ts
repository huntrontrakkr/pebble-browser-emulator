export interface SourceSnapshot {
  version: 1;
  owner: string;
  repository: string;
  commit: string;
  root: string;
  files: Record<string, Uint8Array>;
  metadata: Record<string, unknown> | null;
  warnings: string[];
}
export interface RepositorySpec {
  owner: string;
  repository: string;
  ref: string;
  root: string;
}
type Fetcher = typeof fetch;
export function parseRepository(value: string, ref = '', root = ''): RepositorySpec {
  let parts: string[];
  if (value.trim().startsWith('https://')) {
    const url = new URL(value.trim());
    if (url.hostname !== 'github.com' || url.username || url.password)
      throw new Error('Enter a public github.com repository URL.');
    parts = url.pathname.split('/').filter(Boolean);
    if (parts.length !== 2)
      throw new Error('Use the repository URL; enter the branch and project folder separately.');
  } else parts = value.trim().split('/');
  if (parts.length !== 2 || !parts.every((p) => /^[A-Za-z0-9_.-]+$/.test(p)))
    throw new Error('Use owner/repository or https://github.com/owner/repository.');
  const cleanRoot = root.trim().replace(/^\.\//, '').replace(/\/$/, '');
  if (
    cleanRoot.startsWith('/') ||
    cleanRoot.split('/').some((p) => p === '..' || p === '.') ||
    cleanRoot.includes('\\')
  )
    throw new Error('Project folder must be a relative path without .. components.');
  if (ref.length > 200) throw new Error('Branch or commit is too long.');
  return {
    owner: parts[0],
    repository: parts[1].replace(/\.git$/, ''),
    ref: ref.trim(),
    root: cleanRoot,
  };
}
export async function githubJson(
  path: string,
  signal?: AbortSignal,
  request: Fetcher = fetch,
): Promise<any> {
  const response = await request(`https://api.github.com${path}`, {
    signal,
    headers: { Accept: 'application/vnd.github+json' },
  });
  if (!response.ok) {
    if (response.status === 403 || response.status === 429) {
      const reset = response.headers.get('x-ratelimit-reset');
      throw new Error(
        `GitHub request limit reached${reset ? `; resets ${new Date(Number(reset) * 1000).toLocaleTimeString()}` : ''}. Try later or import local files.`,
      );
    }
    throw new Error(
      `GitHub returned ${response.status}. Check the public repository, branch, and folder.`,
    );
  }
  return response.json();
}
export async function importRepository(
  spec: RepositorySpec,
  signal?: AbortSignal,
  progress: (text: string) => void = () => {},
  request: Fetcher = fetch,
): Promise<SourceSnapshot> {
  const downloads = new AbortController();
  signal = signal ? AbortSignal.any([signal, downloads.signal]) : downloads.signal;
  const base = `/repos/${encodeURIComponent(spec.owner)}/${encodeURIComponent(spec.repository)}`;
  progress('Resolving commit');
  const ref = spec.ref || (await githubJson(base, signal, request)).default_branch;
  const commitInfo = await githubJson(
    `${base}/commits/${encodeURIComponent(ref)}`,
    signal,
    request,
  );
  const commit = commitInfo.sha;
  if (!/^[a-f0-9]{40}$/.test(commit))
    throw new Error('GitHub returned an invalid commit identifier.');
  const tree = await githubJson(`${base}/git/trees/${commit}?recursive=1`, signal, request);
  if (tree.truncated)
    throw new Error(
      'This repository exceeds the GitHub tree limit. Import a local project folder instead.',
    );
  const prefix = spec.root ? spec.root + '/' : '';
  const entries = (
    tree.tree as { path: string; type: string; mode: string; size?: number }[]
  ).filter((e) => e.path.startsWith(prefix) && e.type !== 'tree');
  if (!entries.length) throw new Error('No files found in that project folder.');
  const selected = entries.filter(
    (e) => !/(^|\/)(node_modules|\.git|build|\.github)\//.test(e.path.slice(prefix.length)),
  );
  if (selected.some((e) => e.type !== 'blob' || e.mode === '120000'))
    throw new Error(
      'This project contains submodules or symbolic links. Import a resolved local folder.',
    );
  if (selected.length > 512)
    throw new Error(
      'The selected folder contains more than 512 source files. Select the app subfolder.',
    );
  if (
    selected.some((e) => (e.size ?? 0) > 8 * 1024 * 1024) ||
    selected.reduce((n, e) => n + (e.size ?? 0), 0) > 32 * 1024 * 1024
  )
    throw new Error('Source import exceeds the 32 MiB project or 8 MiB file limit.');
  const files: Record<string, Uint8Array> = Object.create(null);
  let next = 0,
    completed = 0,
    total = 0;
  try {
    await Promise.all(
      Array.from({ length: Math.min(6, selected.length) }, async () => {
        while (next < selected.length) {
          const entry = selected[next++];
          const path = entry.path.slice(prefix.length);
          if (!safePath(path)) throw new Error('Repository contains an unsafe path.');
          const response = await request(
            `https://raw.githubusercontent.com/${encodeURIComponent(spec.owner)}/${encodeURIComponent(spec.repository)}/${commit}/${entry.path.split('/').map(encodeURIComponent).join('/')}`,
            { signal },
          );
          if (!response.ok) throw new Error(`${path}: download failed (${response.status}).`);
          const data = await readLimited(response, 8 * 1024 * 1024);
          total += data.length;
          if (total > 32 * 1024 * 1024) throw new Error('Project source exceeds 32 MiB.');
          if (
            new TextDecoder()
              .decode(data.subarray(0, 100))
              .startsWith('version https://git-lfs.github.com/spec/v1')
          )
            throw new Error(`${path} is a Git LFS pointer. Import the actual file locally.`);
          files[path] = data;
          progress(`Downloaded ${++completed} of ${selected.length} files`);
        }
      }),
    );
  } catch (error) {
    downloads.abort();
    throw error;
  }
  return describeSnapshot({ ...spec, commit, version: 1, files });
}
export function safePath(path: string): boolean {
  return (
    !!path &&
    !path.startsWith('/') &&
    !path.includes('\\') &&
    !path.includes('\0') &&
    !path.split('/').some((p) => p === '..' || p === '.' || p === '') &&
    !/^[A-Za-z]:/.test(path)
  );
}
export async function readLimited(response: Response, maximum: number): Promise<Uint8Array> {
  if (Number(response.headers.get('content-length')) > maximum)
    throw new Error('Download exceeds size limit.');
  if (!response.body) {
    const b = new Uint8Array(await response.arrayBuffer());
    if (b.length > maximum) throw new Error('Download exceeds size limit.');
    return b;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maximum) throw new Error('Download exceeds size limit.');
      chunks.push(value);
    }
  } catch (e) {
    await reader.cancel();
    throw e;
  } finally {
    reader.releaseLock();
  }
  const all = new Uint8Array(size);
  let offset = 0;
  for (const part of chunks) {
    all.set(part, offset);
    offset += part.length;
  }
  return all;
}
export function describeSnapshot(
  input: Omit<SourceSnapshot, 'metadata' | 'warnings'>,
): SourceSnapshot {
  const manifest = input.files['package.json'] ?? input.files['appinfo.json'];
  let metadata: Record<string, unknown> | null = null;
  const warnings: string[] = [];
  if (manifest) {
    try {
      metadata = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifest));
      if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw new Error();
    } catch {
      throw new Error('Project metadata is not valid JSON object data.');
    }
  } else warnings.push('No package.json or appinfo.json found.');
  if (!Object.keys(input.files).some((p) => /\.c$/.test(p)))
    warnings.push('No C sources found; JavaScript-only watch apps need a separate build profile.');
  if (input.files['wscript'])
    warnings.push('Custom Waf behavior is not executed by the browser builder.');
  return { ...input, metadata, warnings };
}
