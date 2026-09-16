/** Keep only the SDK inputs used by the verified browser build profile. */
export function compilerSdkFiles(files: Record<string, Uint8Array>): Record<string, Uint8Array> {
  const selected: Record<string, Uint8Array> = Object.create(null);
  for (const [path, bytes] of Object.entries(files)) {
    const name = path.replace(/^sdk-core\//, '');
    if (
      name === 'manifest.json' ||
      name === 'pebble/emery/lib/libpebble.a' ||
      name.startsWith('pebble/emery/include/') ||
      name === 'pebble/common/pebble_app.ld.template' ||
      name === 'pebble/common/include/_pkjs_shared_additions.js'
    )
      selected[name] = bytes;
  }
  return selected;
}
