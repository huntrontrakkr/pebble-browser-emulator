/** Portable evidence contracts. A successful emulator run is not physical validation. */
export type EvidenceTarget = 'internal-consistency' | 'native-qemu' | 'physical-watch';
export type EvidenceStatus = 'verified' | 'modeled' | 'unverified' | 'unsupported';
export interface FidelityIdentity {
  board: string;
  revision: string;
  firmwareVersion: string;
  firmware: Record<string, string>;
  appSha256: string;
  scenarioSha256: string;
  seed: number;
  initialState: string;
}
export interface FidelityObservation {
  checkpoint: string;
  virtualUs: number | null;
  values: Record<string, string | number | boolean | null>;
}
export interface FidelityRun {
  format: 'pebble-fidelity-run';
  version: 1;
  identity: FidelityIdentity;
  implementation: { name: string; version: string; sha256: string };
  referenceTarget: EvidenceTarget;
  captureMethod: string;
  outcome: 'passed' | 'failed' | 'not-run';
  reason?: string;
  complete: boolean;
  droppedEvents: number;
  observations: FidelityObservation[];
}
const sha = /^[0-9a-f]{64}$/;
function requireValue(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(message);
}
function object(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096;
}
/** Canonical identity ordering, independent of object insertion order. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (object(value))
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map((key) => JSON.stringify(key) + ':' + canonicalJson(value[key]))
        .join(',') +
      '}'
    );
  requireValue(
    value === null ||
      typeof value === 'string' ||
      typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isFinite(value)),
    'Unsupported canonical JSON value.',
  );
  return JSON.stringify(value);
}
export function validateFidelityRun(value: unknown): FidelityRun {
  requireValue(
    object(value) && value['format'] === 'pebble-fidelity-run' && value['version'] === 1,
    'Unsupported evidence format.',
  );
  const id = value['identity'];
  requireValue(object(id), 'Missing run identity.');
  for (const key of ['board', 'revision', 'firmwareVersion', 'initialState'])
    requireValue(nonempty(id[key]), 'Missing identity ' + key + '.');
  for (const key of ['appSha256', 'scenarioSha256'])
    requireValue(
      typeof id[key] === 'string' && sha.test(id[key]),
      'Invalid identity hash: ' + key + '.',
    );
  requireValue(
    Number.isInteger(id['seed']) && id['seed'] >= 0 && id['seed'] <= 0xffffffff,
    'Invalid scenario seed.',
  );
  requireValue(
    object(id['firmware']) &&
      Object.keys(id['firmware']).length > 0 &&
      Object.keys(id['firmware']).length <= 16,
    'Missing firmware identity.',
  );
  for (const [role, hash] of Object.entries(id['firmware']))
    requireValue(
      nonempty(role) && typeof hash === 'string' && sha.test(hash),
      'Invalid firmware asset hash.',
    );
  const impl = value['implementation'];
  requireValue(
    object(impl) &&
      nonempty(impl['name']) &&
      nonempty(impl['version']) &&
      typeof impl['sha256'] === 'string' &&
      sha.test(impl['sha256']),
    'Missing implementation identity.',
  );
  requireValue(
    ['internal-consistency', 'native-qemu', 'physical-watch'].includes(value['referenceTarget']),
    'Invalid reference target.',
  );
  requireValue(nonempty(value['captureMethod']), 'Missing capture method.');
  requireValue(['passed', 'failed', 'not-run'].includes(value['outcome']), 'Invalid run outcome.');
  requireValue(
    typeof value['complete'] === 'boolean' &&
      Number.isSafeInteger(value['droppedEvents']) &&
      value['droppedEvents'] >= 0,
    'Invalid capture completeness.',
  );
  requireValue(
    Array.isArray(value['observations']) && value['observations'].length <= 100000,
    'Invalid observations.',
  );
  if (value['outcome'] !== 'passed')
    requireValue(nonempty(value['reason']), 'Incomplete/failed runs require a reason.');
  if (value['outcome'] === 'passed')
    requireValue(
      value['complete'] && value['droppedEvents'] === 0 && value['observations'].length > 0,
      'A partial or empty capture cannot pass.',
    );
  if (value['outcome'] === 'not-run')
    requireValue(
      value['observations'].length === 0 && !value['complete'],
      'An unexecuted run cannot contain results.',
    );
  const names = new Set<string>();
  let lastUs = -Infinity;
  for (const entry of value['observations']) {
    requireValue(
      object(entry) && nonempty(entry['checkpoint']) && !names.has(entry['checkpoint']),
      'Checkpoint names must be unique.',
    );
    names.add(entry['checkpoint']);
    requireValue(
      entry['virtualUs'] === null ||
        (Number.isFinite(entry['virtualUs']) &&
          entry['virtualUs'] >= 0 &&
          entry['virtualUs'] >= lastUs),
      'Invalid/nonmonotonic virtual time.',
    );
    if (entry['virtualUs'] !== null) lastUs = entry['virtualUs'];
    requireValue(
      object(entry['values']) &&
        Object.keys(entry['values']).length > 0 &&
        Object.keys(entry['values']).length <= 1024,
      'Invalid checkpoint values.',
    );
    for (const v of Object.values(entry['values']))
      requireValue(
        v === null ||
          typeof v === 'boolean' ||
          typeof v === 'string' ||
          (typeof v === 'number' && Number.isFinite(v)),
        'Checkpoint values must be finite scalars.',
      );
  }
  return value as unknown as FidelityRun;
}

export type FidelityComparison =
  | { outcome: 'not-comparable'; reason: string }
  | {
      outcome: 'mismatch';
      checkpoint: string;
      field: string;
      reference: unknown;
      candidate: unknown;
    }
  | {
      outcome: 'match';
      checkpoints: number;
      referenceTarget: EvidenceTarget;
      timingCompared: boolean;
    };

/** Digital checkpoint comparison. Timing is opt-in and tolerance must be supplied. */
export function compareFidelityRuns(
  referenceValue: unknown,
  candidateValue: unknown,
  timingToleranceUs?: number,
): FidelityComparison {
  const reference = validateFidelityRun(referenceValue),
    candidate = validateFidelityRun(candidateValue);
  if (timingToleranceUs !== undefined)
    requireValue(
      Number.isFinite(timingToleranceUs) && timingToleranceUs >= 0,
      'Invalid timing tolerance.',
    );
  if (canonicalJson(reference.identity) !== canonicalJson(candidate.identity))
    return {
      outcome: 'not-comparable',
      reason: 'Board, revision, firmware, app, initial state, seed or scenario identity differs.',
    };
  for (const run of [reference, candidate])
    if (run.outcome !== 'passed' || !run.complete || run.droppedEvents)
      return {
        outcome: 'not-comparable',
        reason: run.reason ?? 'Run did not complete without capture loss.',
      };
  if (
    timingToleranceUs !== undefined &&
    [...reference.observations, ...candidate.observations].some((o) => o.virtualUs === null)
  )
    return {
      outcome: 'not-comparable',
      reason: 'A reference has no virtual timestamp; wall time is not guest time.',
    };
  for (let i = 0; i < Math.max(reference.observations.length, candidate.observations.length); i++) {
    const a = reference.observations[i],
      b = candidate.observations[i];
    const checkpoint = a?.checkpoint ?? b.checkpoint;
    if (!a || !b || a.checkpoint !== b.checkpoint)
      return {
        outcome: 'mismatch',
        checkpoint,
        field: 'checkpoint',
        reference: a?.checkpoint ?? null,
        candidate: b?.checkpoint ?? null,
      };
    const keys = [...new Set([...Object.keys(a.values), ...Object.keys(b.values)])].sort();
    for (const field of keys)
      if (
        !Object.hasOwn(a.values, field) ||
        !Object.hasOwn(b.values, field) ||
        a.values[field] !== b.values[field]
      )
        return {
          outcome: 'mismatch',
          checkpoint,
          field,
          reference: a.values[field] ?? null,
          candidate: b.values[field] ?? null,
        };
    if (
      timingToleranceUs !== undefined &&
      Math.abs(a.virtualUs! - b.virtualUs!) > timingToleranceUs
    )
      return {
        outcome: 'mismatch',
        checkpoint,
        field: 'virtualUs',
        reference: a.virtualUs,
        candidate: b.virtualUs,
      };
  }
  return {
    outcome: 'match',
    checkpoints: reference.observations.length,
    referenceTarget: reference.referenceTarget,
    timingCompared: timingToleranceUs !== undefined,
  };
}

/** Decode a bounded observation ring. MMIO records have no sampled CPU cycle count. */
export function decodeCoreTrace(bytes: Uint8Array, version: number) {
  requireValue(
    version === 1 && bytes.byteLength % 40 === 0 && bytes.byteLength <= 32768 * 40,
    'Unsupported core trace.',
  );
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const result = [];
  for (let offset = 0; offset < bytes.byteLength; offset += 40) {
    const word = (n: number) => data.getUint32(offset + n * 4, true);
    const wide = (n: number) => {
      const v = word(n) + word(n + 1) * 4294967296;
      requireValue(Number.isSafeInteger(v), 'Trace timestamp exceeds JSON integer precision.');
      return v;
    };
    const kind = word(0);
    requireValue(kind >= 1 && kind <= 4, 'Unknown trace event.');
    result.push({
      kind: ['read', 'write', 'exception', 'step'][kind - 1],
      ticks: wide(1),
      pc: word(3),
      address: word(4),
      value: word(5),
      width: word(6),
      irqMask: kind >= 3 ? word(7) : null,
      estimatedCpuCycles: kind >= 3 ? wide(8) : null,
    });
  }
  return result;
}
