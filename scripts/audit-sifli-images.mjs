// Read-only inspection of a locally supplied production slot-0 image and ELF.
// The report is an artifact layout audit, never an executable firmware bundle.
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { auditSifliImage } from '../src/app/sifli-image-audit.ts';

const [revision, elfPath, binPath, reportPath] = process.argv.slice(2);
if (!['obelix_pvt', 'getafix_dvt2'].includes(revision) || !elfPath || !binPath) {
  console.error(
    'Usage: node scripts/audit-sifli-images.mjs REVISION SLOT0.elf SLOT0.bin [report.json]',
  );
  process.exit(2);
}

const [elf, bin] = await Promise.all([readFile(elfPath), readFile(binPath)]);
const audit = auditSifliImage(revision, elf, bin);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const report = {
  format: 'pebble-sifli-artifact-audit',
  version: 1,
  outcome: 'layout-verified',
  evidenceTarget: 'published-binary-self-consistency',
  files: {
    elf: { name: basename(elfPath), bytes: elf.byteLength, sha256: sha256(elf) },
    bin: { name: basename(binPath), bytes: bin.byteLength, sha256: sha256(bin) },
  },
  audit,
};
const json = JSON.stringify(report, null, 2) + '\n';
if (reportPath) await writeFile(reportPath, json);
else process.stdout.write(json);
