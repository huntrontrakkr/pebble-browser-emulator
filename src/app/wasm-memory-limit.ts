/** Add a memory ceiling to a build VM module, preserving its code and data sections.
 * This never touches watch firmware. The original and bounded module have separate hashes. */
export function boundBuildMemory(bytes: Uint8Array, maximumPages = 24576): Uint8Array {
  if (!Number.isInteger(maximumPages) || maximumPages < 1 || maximumPages > 32768)
    throw new Error('Invalid build memory limit.');
  if (bytes.length < 8 || bytes.slice(0, 8).some((b, i) => b !== [0, 97, 115, 109, 1, 0, 0, 0][i]))
    throw new Error('Expected a WebAssembly 1.0 module.');
  let cursor = 8;
  const read = () => {
    let n = 0;
    for (let i = 0; i < 5; i++) {
      const b = bytes[cursor++];
      if (b === undefined || (i === 4 && b > 15)) throw new Error('Invalid Wasm section length.');
      n += (b & 127) * 2 ** (i * 7);
      if (!(b & 128)) return n;
    }
    throw new Error('Invalid Wasm integer.');
  };
  const leb = (n: number) => {
    const out = [];
    do {
      const b = n % 128;
      n = Math.floor(n / 128);
      out.push(b | (n ? 128 : 0));
    } while (n);
    return out;
  };
  while (cursor < bytes.length) {
    const start = cursor,
      id = bytes[cursor++],
      size = read(),
      end = cursor + size;
    if (end > bytes.length) throw new Error('Truncated Wasm section.');
    if (id === 5) {
      if (read() !== 1) throw new Error('Build VM must define exactly one memory.');
      const flags = read(),
        minimum = read();
      if (flags !== 0 && flags !== 1) throw new Error('Build VM must use unshared 32-bit memory.');
      const maximum = flags === 1 ? read() : maximumPages;
      if (cursor !== end || minimum > maximumPages || minimum > maximum)
        throw new Error('Build VM exceeds the memory budget.');
      const memory = [1, 1, ...leb(minimum), ...leb(Math.min(maximum, maximumPages))];
      const section = Uint8Array.from([5, ...leb(memory.length), ...memory]);
      const result = new Uint8Array(start + section.length + bytes.length - end);
      result.set(bytes.subarray(0, start));
      result.set(section, start);
      result.set(bytes.subarray(end), start + section.length);
      return result;
    }
    cursor = end;
  }
  throw new Error('Build VM must define its memory. Imported memory is not supported.');
}
