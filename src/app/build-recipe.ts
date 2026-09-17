import { parseDocument } from 'yaml';
import { safePath } from './projects.ts';

/** Commands are passed to a shell inside the Linux VM, never evaluated by the host. */
export interface BuildRecipe {
  version: 1;
  backend: 'linux-wasi';
  workdir: string;
  commands: string[];
  outputs: string[];
  env: Record<string, string>;
  imageSha256?: string;
  timeoutSeconds: number;
}
export function parseBuildRecipe(source: string): BuildRecipe {
  if (source.length > 65536) throw new Error('Build recipe exceeds 64 KiB.');
  const doc = parseDocument(source, { uniqueKeys: true, customTags: [] });
  if (doc.errors.length || doc.warnings.length)
    throw new Error(
      'Invalid build recipe: ' + [...doc.errors, ...doc.warnings].map((e) => e.message).join('; '),
    );
  const v = doc.toJS({ maxAliasCount: 20 });
  if (!v || typeof v !== 'object' || Array.isArray(v))
    throw new Error('Build recipe must be a mapping.');
  const keys = [
    'version',
    'backend',
    'workdir',
    'commands',
    'outputs',
    'env',
    'imageSha256',
    'timeoutSeconds',
  ];
  for (const key of Object.keys(v))
    if (!keys.includes(key)) throw new Error('Unknown build recipe field: ' + key);
  if (v.version !== 1 || v.backend !== 'linux-wasi')
    throw new Error('Expected version: 1 and backend: linux-wasi.');
  const workdir = v.workdir ?? '.';
  if (typeof workdir !== 'string' || (workdir !== '.' && !safePath(workdir)))
    throw new Error('workdir must be a relative project directory.');
  if (
    !Array.isArray(v.commands) ||
    !v.commands.length ||
    v.commands.length > 64 ||
    v.commands.some(
      (c: unknown) => typeof c !== 'string' || !c.trim() || c.length > 8192 || c.includes('\0'),
    )
  )
    throw new Error('Expected 1–64 shell commands, up to 8192 characters each.');
  if (
    !Array.isArray(v.outputs) ||
    !v.outputs.length ||
    v.outputs.length > 32 ||
    v.outputs.some((p: unknown) => typeof p !== 'string' || !safePath(p) || /[*?\[\]]/.test(p))
  )
    throw new Error('Outputs must be 1–32 exact relative file paths.');
  const env: Record<string, string> = Object.create(null);
  if (new Set(v.outputs).size !== v.outputs.length) throw new Error('Output paths must be unique.');
  if (v.env !== undefined && (!v.env || typeof v.env !== 'object' || Array.isArray(v.env)))
    throw new Error('env must be a mapping.');
  for (const [key, value] of Object.entries(v.env ?? {})) {
    if (
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ||
      typeof value !== 'string' ||
      value.length > 8192 ||
      value.includes('\0')
    )
      throw new Error('Invalid environment variable: ' + key);
    env[key] = value;
  }
  if (Object.keys(env).length > 64) throw new Error('Too many environment variables.');
  if (v.imageSha256 !== undefined && !/^[a-f0-9]{64}$/.test(v.imageSha256))
    throw new Error('imageSha256 must be a lowercase SHA-256 digest.');
  const timeoutSeconds = v.timeoutSeconds ?? 600;
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 3600)
    throw new Error('timeoutSeconds must be between 1 and 3600.');
  return {
    version: 1,
    backend: 'linux-wasi',
    workdir,
    commands: [...v.commands],
    outputs: [...v.outputs],
    env,
    timeoutSeconds,
    ...(v.imageSha256 ? { imageSha256: v.imageSha256 } : {}),
  };
}
export const shellQuote = (value: string): string => "'" + value.replaceAll("'", "'\\''") + "'";
export function recipeScript(recipe: BuildRecipe, platform: string): string {
  return [
    'set -eu',
    'cd ' + shellQuote('/work' + (recipe.workdir === '.' ? '' : '/' + recipe.workdir)),
    'export PEBBLE_PLATFORM=' + shellQuote(platform),
    ...Object.entries(recipe.env).map(([key, value]) => `export ${key}=${shellQuote(value)}`),
    ...recipe.commands,
    '',
  ].join('\n');
}
