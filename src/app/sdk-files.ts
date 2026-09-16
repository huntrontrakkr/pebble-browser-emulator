/** Keep only the SDK inputs used by the browser build profiles. */
export function compilerSdkFiles(files: Record<string, Uint8Array>): Record<string, Uint8Array> {
  const selected: Record<string, Uint8Array> = Object.create(null);
  for (const [path, bytes] of Object.entries(files)) {
    const name = path.replace(/^sdk-core\//, '');
    if (
      name === 'manifest.json' ||
      /^pebble\/(aplite|basalt|chalk|diorite|emery|flint|gabbro)\/(include\/|lib\/libpebble\.a$)/.test(
        name,
      ) ||
      name === 'pebble/common/pebble_app.ld.template' ||
      name === 'pebble/common/include/_pkjs_shared_additions.js'
    )
      selected[name] = bytes;
  }
  return selected;
}
