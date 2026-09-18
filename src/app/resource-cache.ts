import { readLocal, updateLocalIndex } from './local-store.ts';
import { readLimited } from './projects.ts';
import { resourceFetch } from './resource-fetch.ts';

const INDEX = 'public-resources:v1';
const MAX_BYTES = 96 * 1048576;
interface Entry {
  key: string;
  bytes: number;
  used: number;
}
interface Record {
  bytes: Uint8Array;
  sha256: string;
  saved: number;
}
const validIndex = (value: unknown): Entry[] =>
  Array.isArray(value)
    ? value
        .filter(
          (e) =>
            /^public-resource:[a-f0-9]{64}$/.test(e?.key) &&
            Number.isSafeInteger(e.bytes) &&
            e.bytes >= 0 &&
            e.bytes <= MAX_BYTES,
        )
        .slice(-48)
    : [];
let writes: Promise<unknown> = Promise.resolve();
export async function bytesHash(bytes: Uint8Array): Promise<string> {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.slice().buffer)),
    (b) => b.toString(16).padStart(2, '0'),
  ).join('');
}
/** Bounded device-local public asset cache; it contains no phone settings or credentials. */
export async function cachedResource(
  url: string,
  options: {
    maximum: number;
    signal: AbortSignal;
    sha256?: string;
    ttlMs?: number;
    request?: typeof fetch;
    cache?: boolean;
  },
): Promise<{ bytes: Uint8Array; sha256: string; cached: boolean }> {
  const { signal, maximum, sha256, ttlMs = Infinity, request = resourceFetch } = options;
  if (sha256 && !/^[a-f0-9]{64}$/.test(sha256)) throw new Error('Invalid SHA-256.');
  signal.throwIfAborted();
  const key = 'public-resource:' + (await bytesHash(new TextEncoder().encode(url)));
  const saved =
    options.cache === false ? undefined : await readLocal<Record>(key).catch(() => undefined);
  const valid =
    saved &&
    saved.bytes instanceof Uint8Array &&
    saved.bytes.length <= maximum &&
    saved.sha256 === (await bytesHash(saved.bytes)) &&
    (!sha256 || sha256 === saved.sha256);
  signal.throwIfAborted();
  if (valid && Date.now() - saved.saved < ttlMs) return { ...saved, cached: true };
  let bytes: Uint8Array;
  try {
    const response = await request(url, { signal, credentials: 'omit' });
    if (!response.ok) throw new Error(`Download failed (${response.status}).`);
    bytes = await readLimited(response, maximum);
  } catch (error) {
    signal.throwIfAborted();
    if (valid) return { ...saved, cached: true };
    throw error;
  }
  const actual = await bytesHash(bytes);
  if (sha256 && sha256 !== actual) throw new Error('Downloaded resource checksum does not match.');
  signal.throwIfAborted();
  if (options.cache !== false && bytes.length <= MAX_BYTES) {
    const copy = bytes.slice();
    writes = writes
      .catch(() => {})
      .then(async () => {
        signal.throwIfAborted();
        await updateLocalIndex<Entry[]>(INDEX, (previous, store) => {
          const index = validIndex(previous).filter((e) => e.key !== key);
          index.push({ key, bytes: copy.length, used: Date.now() });
          while (index.length > 48 || index.reduce((n, e) => n + e.bytes, 0) > MAX_BYTES)
            store.delete(index.shift()!.key);
          store.put({ bytes: copy, sha256: actual, saved: Date.now() }, key);
          return index;
        });
      });
    await writes.catch(() => {});
  }
  signal.throwIfAborted();
  return { bytes, sha256: actual, cached: false };
}
export async function clearResourceCache(): Promise<void> {
  writes = writes
    .catch(() => {})
    .then(async () => {
      await updateLocalIndex<Entry[]>(INDEX, (previous, store) => {
        for (const entry of validIndex(previous)) store.delete(entry.key);
        return [];
      });
    });
  await writes;
}
