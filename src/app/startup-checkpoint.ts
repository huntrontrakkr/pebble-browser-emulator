import { readLocal, writeLocal } from './local-store.ts';
import { bytesHash } from './resource-cache.ts';
import { readLimited } from './projects.ts';
import { isFirmwareProfile, type FirmwareProfile } from './watch-profiles.ts';
import type { StartupTransportState } from './pebble-transport.ts';

export const STARTUP_SETTINGS_KEY = 'pebble:startup-checkpoints:v1';
export interface StartupIdentity {
  profile: FirmwareProfile;
  core: string;
  micro: string;
  flash: string;
}
export interface StartupCheckpoint {
  version: 1;
  identity: StartupIdentity;
  steps: number;
  transport: StartupTransportState;
  machine: Uint8Array;
}
const MAXIMUM = 40 * 1048576;
const key = (identity: StartupIdentity) => `startup-checkpoint:${identity.profile}`;
export function startupCheckpointsEnabled(): boolean {
  try {
    return localStorage.getItem(STARTUP_SETTINGS_KEY) !== 'disabled';
  } catch {
    return true;
  }
}
export function sameStartupIdentity(a: StartupIdentity, b: StartupIdentity): boolean {
  return (
    !!a &&
    !!b &&
    ['profile', 'core', 'micro', 'flash'].every(
      (k) => a[k as keyof StartupIdentity] === b[k as keyof StartupIdentity],
    )
  );
}
export async function startupIdentity(
  profile: FirmwareProfile,
  core: string,
  micro: Uint8Array,
  flash: Uint8Array,
): Promise<StartupIdentity> {
  const [a, b] = await Promise.all([bytesHash(micro), bytesHash(flash)]);
  return { profile, core, micro: a, flash: b };
}
function validate(value: Omit<StartupCheckpoint, 'machine'>, identity: StartupIdentity) {
  if (
    value.version !== 1 ||
    !isFirmwareProfile(value.identity?.profile) ||
    !sameStartupIdentity(value.identity, identity) ||
    ![identity.core, identity.micro, identity.flash].every((s) => /^[a-f0-9]{64}$/.test(s)) ||
    !Number.isSafeInteger(value.steps) ||
    value.steps < 0 ||
    !value.transport
  )
    throw new Error('Startup checkpoint does not match this firmware and emulator.');
}
export async function encodeStartupCheckpoint(value: StartupCheckpoint): Promise<Uint8Array> {
  validate(value, value.identity);
  const { machine, ...header } = value;
  const metadata = new TextEncoder().encode(JSON.stringify(header));
  if (metadata.length > 65536 || machine.length > MAXIMUM)
    throw new Error('Startup checkpoint exceeds its size limit.');
  const length = new Uint8Array(4);
  new DataView(length.buffer).setUint32(0, metadata.length, true);
  const stream = new Blob([length, metadata, machine.slice().buffer])
    .stream()
    .pipeThrough(new CompressionStream('gzip'));
  return readLimited(new Response(stream), MAXIMUM);
}
export async function decodeStartupCheckpoint(
  bytes: Uint8Array,
  identity: StartupIdentity,
): Promise<StartupCheckpoint> {
  if (bytes.length > MAXIMUM) throw new Error('Startup checkpoint is too large.');
  const stream = new Blob([bytes.slice().buffer])
    .stream()
    .pipeThrough(new DecompressionStream('gzip'));
  const data = await readLimited(new Response(stream), MAXIMUM + 65540);
  if (data.length < 4) throw new Error('Truncated startup checkpoint.');
  const length = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(0, true);
  if (length > 65536 || length + 4 >= data.length)
    throw new Error('Invalid startup checkpoint header.');
  const header = JSON.parse(
    new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(4, 4 + length)),
  );
  validate(header, identity);
  return { ...header, machine: data.slice(4 + length) };
}
export async function saveStartupCheckpoint(value: StartupCheckpoint): Promise<void> {
  const bytes = await encodeStartupCheckpoint(value);
  await writeLocal(key(value.identity), {
    identity: value.identity,
    bytes,
    sha256: await bytesHash(bytes),
  });
}
export async function loadStartupCheckpoint(
  identity: StartupIdentity,
  base: string,
  signal: AbortSignal,
): Promise<{ checkpoint: StartupCheckpoint; source: 'device' | 'published' } | undefined> {
  signal = AbortSignal.any([signal, AbortSignal.timeout(5000)]);
  signal.throwIfAborted();
  const saved = await readLocal<{ identity: StartupIdentity; bytes: Uint8Array; sha256: string }>(
    key(identity),
  ).catch(() => undefined);
  if (saved && sameStartupIdentity(saved.identity, identity)) {
    try {
      if (
        !(saved.bytes instanceof Uint8Array) ||
        saved.bytes.length > MAXIMUM ||
        (await bytesHash(saved.bytes)) !== saved.sha256
      )
        throw new Error('Cached checkpoint checksum mismatch.');
      const checkpoint = await decodeStartupCheckpoint(saved.bytes, identity);
      signal.throwIfAborted();
      return { checkpoint, source: 'device' };
    } catch {
      signal.throwIfAborted();
    }
  }
  const response = await fetch(new URL('index.json', base), { signal, credentials: 'omit' });
  if (response.status === 404) return;
  if (!response.ok) throw new Error('Prepared startup state is unavailable.');
  const manifest = JSON.parse(new TextDecoder().decode(await readLimited(response, 65536)));
  if (
    manifest.version !== 1 ||
    !Array.isArray(manifest.checkpoints) ||
    manifest.checkpoints.length > 32
  )
    throw new Error('Invalid startup catalog.');
  const item = manifest.checkpoints.find((c: any) => sameStartupIdentity(c.identity, identity));
  if (!item) return;
  if (
    !/^[a-f0-9]{64}$/.test(item.sha256) ||
    item.path !== `${identity.profile}.pbcp` ||
    !Number.isSafeInteger(item.bytes) ||
    item.bytes > MAXIMUM ||
    item.bytes <= 0
  )
    throw new Error('Invalid prepared startup entry.');
  const artifact = await fetch(new URL(item.path, base), { signal, credentials: 'omit' });
  if (!artifact.ok) throw new Error('Prepared startup state could not be downloaded.');
  const bytes = await readLimited(artifact, item.bytes);
  if (bytes.length !== item.bytes || (await bytesHash(bytes)) !== item.sha256)
    throw new Error('Prepared startup checksum mismatch.');
  const checkpoint = await decodeStartupCheckpoint(bytes, identity);
  signal.throwIfAborted();
  await writeLocal(key(identity), { identity, bytes, sha256: item.sha256 }).catch(() => {});
  signal.throwIfAborted();
  return { checkpoint, source: 'published' };
}
