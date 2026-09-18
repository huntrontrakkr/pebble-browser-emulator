// Runs the browser-target Wasm against locally supplied, unchanged physical images.
// Missing inputs are NOT a pass. This gate establishes reset execution, never full boot.
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { auditSifliImage, inspectSifliResetStartup } from '../src/app/sifli-image-audit.ts';

const [revision, elfPath, imagePath, reportPath] = process.argv.slice(2);
if (!['obelix_pvt', 'getafix_dvt2'].includes(revision) || !elfPath || !imagePath) {
  console.error(
    'Usage: node scripts/verify-sifli-execution.mjs REVISION SLOT0.elf SLOT0.bin [report.json]',
  );
  process.exit(2);
}
const report = {
  format: 'pebble-sifli-reset-execution',
  version: 1,
  revision,
  outcome: 'not-run',
  bootComplete: false,
  referenceTarget: 'ELF-initializers-and-reset-binary',
  entryState: 'assumed-secure-reset-probe-v1',
};
try {
  const [elf, image, wasm] = await Promise.all([
    readFile(elfPath),
    readFile(imagePath),
    readFile('public/wasm/sifli-probe.wasm'),
  ]);
  const sha = (b) => createHash('sha256').update(b).digest('hex');
  report.identity = { elfSha256: sha(elf), imageSha256: sha(image), wasmSha256: sha(wasm) };
  const audit = auditSifliImage(revision, elf, image);
  const reset = inspectSifliResetStartup(audit, image);
  if (!reset) throw new Error('Reset pattern is not audited; no execution acceptance claim');
  // Targets from the audited, exact branch encodings and published ELF symbols.
  const systemInit = revision === 'obelix_pvt' ? 0x1211521c : 0x12100d9c;
  const { instance } = await WebAssembly.instantiate(wasm, {});
  const e = instance.exports;
  const output = () =>
    JSON.parse(
      new TextDecoder().decode(
        new Uint8Array(e.memory.buffer, e.sifli_output_ptr(), e.sifli_output_len()),
      ),
    );
  const input = e.sifli_input(image.length);
  if (!input) throw new Error('Input allocation rejected');
  new Uint8Array(e.memory.buffer, input, image.length).set(image);
  if (!e.sifli_load(revision === 'obelix_pvt' ? 0 : 1)) throw new Error(JSON.stringify(output()));
  let state;
  for (let i = 0; i < 100; i++) {
    e.sifli_run(100000, systemInit);
    state = output();
    if (state.stop || state.registers[15] === systemInit) break;
  }
  report.startup = state;
  if (state.stop || state.registers[15] !== systemInit)
    throw new Error('Reset did not reach SystemInit');
  if (state.msplim !== reset.mainStackLimit || state.psplim !== 0)
    throw new Error('Stack limits mismatch');
  const ramBytes = (address, count) =>
    Uint8Array.from({ length: count }, (_, i) => {
      const b = e.sifli_read_byte(address + i) >>> 0;
      if (b > 255) throw new Error(`Uninitialized byte at 0x${(address + i).toString(16)}`);
      return b;
    });
  report.copies = reset.copies.map((r) => {
    const actual = ramBytes(r.destination, r.bytes);
    const expected = image.subarray(
      r.source - audit.flashBase,
      r.source - audit.flashBase + r.bytes,
    );
    if (sha(actual) !== sha(expected)) throw new Error('RAM initializer mismatch');
    return { ...r, sha256: sha(actual), matches: true };
  });
  const zero = ramBytes(reset.zeroFill.destination, reset.zeroFill.bytes);
  if (zero.some((b) => b !== 0)) throw new Error('BSS not cleared');
  report.zeroFill = { ...reset.zeroFill, sha256: sha(zero), matches: true };
  report.outcome = 'reset-initialization-matched';
  // Continue without inventing the hardware state to identify the next blocker.
  for (let i = 0; i < 100; i++) {
    e.sifli_run(100000, 0);
    state = output();
    if (state.stop) break;
  }
  report.hardwareBoundary = state;
  report.limits = [
    'No verified bootloader handoff state',
    'No physical reference or calibrated timing',
    'No SiFli MMIO, ROM, LCPU, PPB or coprocessor model',
    'No full firmware boot, display, installation or phone exchange',
  ];
} catch (error) {
  report.error = error.message;
  if (report.identity) report.outcome = 'failed';
  process.exitCode = report.outcome === 'not-run' ? 2 : 1;
}
const json = JSON.stringify(report, null, 2) + '\n';
if (reportPath) await writeFile(reportPath, json);
else process.stdout.write(json);
