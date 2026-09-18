// Offline evaluation, permitted only after every planned capture has terminated and hashes verify.
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { resolve, join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { crc32 } from '../../src/app/integrity.ts';
import { verifySeal, json, save, pool, sha } from './common.mjs';
const dir = resolve(process.argv[2] ?? 'tmp/compatibility-census'),
  { manifest, seal } = await verifySeal(dir);
const capture = await json(join(dir, 'capture.json'));
const output = join(dir, 'evaluation');
await mkdir(output, { recursive: true });
const escape = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
function png(bytes, width, height) {
  function chunk(type, data) {
    const name = Buffer.from(type),
      length = Buffer.alloc(4),
      checksum = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    checksum.writeUInt32BE(crc32(Buffer.concat([name, data])) >>> 0);
    return Buffer.concat([length, name, data, checksum]);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const scan = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const v = bytes[y * width + x],
        at = y * (width * 3 + 1) + 1 + x * 3;
      scan[at] = ((v >> 4) & 3) * 85;
      scan[at + 1] = ((v >> 2) & 3) * 85;
      scan[at + 2] = (v & 3) * 85;
    }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(scan)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
const results = await pool(seal.terminals, 8, async (terminal) => {
  const path = join(dir, 'cases', terminal.id),
    entry = manifest.entries.find((e) => terminal.id.startsWith(e.id + '-'));
  const row = {
    id: terminal.id,
    entryId: entry.id,
    title: entry.title,
    category: entry.category,
    rank: entry.rank,
    profile: terminal.id.slice(entry.id.length + 1),
    hostMs: terminal.hostMs,
    diagnostics: {
      phoneErrors: [],
      phoneLimits: [],
      networkRequests: 0,
      configurationRequests: 0,
      inputsApplied: 0,
      inputsRejected: [],
      traceDropped: 0,
    },
    frames: [],
  };
  let o;
  try {
    o = await json(join(path, 'observations.json'));
  } catch {}
  row.installed = !!o?.installed;
  row.scenarioCompleted = !!o?.scenarioCompleted;
  row.phoneStarted = !!o?.phoneStarted;
  let consoleText = '';
  try {
    consoleText = await readFile(join(path, 'console.txt'), 'utf8');
  } catch {}
  const firmwareMessages = [
    ...new Set(
      (
        consoleText.match(
          /[^\n]*(?:task queue full|callback queue.*full|queue is full|Resetting!|rebooting|core dump|assertion fail|hardfault)[^\n]*/gi,
        ) ?? []
      ).map((s) => s.trim()),
    ),
  ];
  row.firmwareMessages = firmwareMessages.slice(0, 30);
  if (!entry.acquisition.path) row.outcome = 'download-unavailable';
  else if (terminal.timedOut || /Host capture deadline exceeded/.test(o?.exception?.message ?? ''))
    row.outcome = 'host-timeout';
  else if (!o || terminal.code !== 0) row.outcome = 'capture-process-error';
  else if (o.exception?.phase === 'package')
    row.outcome = /no .* manifest|different watch platform/.test(o.exception.message)
      ? 'no-compatible-binary'
      : 'package-rejected';
  else if (o.exception) row.outcome = 'execution-stopped';
  else if (firmwareMessages.length) row.outcome = 'firmware-error-observed';
  else if (o.scenarioCompleted) row.outcome = 'scenario-completed';
  else row.outcome = 'incomplete';
  row.reason = o?.exception?.message ?? row.firmwareMessages[0] ?? null;
  if (!entry.acquisition.path) row.reason = entry.acquisition.attempts?.at(-1)?.error ?? row.reason;
  row.phase = o?.exception?.phase ?? o?.phase;
  row.maxRssKiB = o?.resourceUsage.maxRSS;
  row.processCpuUs = o
    ? (o.resourceUsage.userCPUTime ?? 0) + (o.resourceUsage.systemCPUTime ?? 0)
    : null;
  row.virtualUs = o?.virtualUs;
  row.droppedEvents = o?.droppedEvents ?? 0;
  row.droppedConsoleBytes = o?.droppedConsoleBytes ?? 0;
  if (o) {
    for await (const line of createInterface({
      input: createReadStream(join(path, 'events.jsonl')),
      crlfDelay: Infinity,
    })) {
      const e = JSON.parse(line);
      if (e.phase === 'scenario') row.scenarioStartUs ??= e.virtualUs;
      if (e.type === 'sample') row.lastSample = e;
      if (e.type === 'frame')
        row.frames.push({ sha256: e.sha256, virtualUs: e.virtualUs, phase: e.phase });
      if (e.type === 'checkpoint' && e.name === 'installed') row.baselineFrame = row.frames.at(-1);
      if (e.type === 'input-applied') row.diagnostics.inputsApplied++;
      if (e.type === 'input-rejected')
        row.diagnostics.inputsRejected.push({ signal: e.signal, error: e.error });
      if (e.type === 'trace') row.diagnostics.traceDropped += e.dropped;
      if (e.type === 'phone') {
        if (e.event.type === 'error') row.diagnostics.phoneErrors.push(e.event.message);
        if (e.event.type === 'limit') row.diagnostics.phoneLimits.push(e.event.message);
        if (e.event.type === 'network-request') row.diagnostics.networkRequests++;
        if (e.event.type === 'configuration') row.diagnostics.configurationRequests++;
      }
      if (['phone-delivery-error', 'packet-decode-error', 'phone-dispose-error'].includes(e.type))
        row.diagnostics.phoneErrors.push(e.error);
    }
    const eligible = row.frames.filter((f) => f.phase === 'scenario' || f.phase === 'complete'),
      first = row.baselineFrame ?? eligible[0],
      last = eligible.at(-1) ?? row.frames.at(-1);
    if (last) {
      const b = await readFile(join(path, 'frames', last.sha256 + '.gcolor8'));
      const histogram = new Array(64).fill(0);
      for (const pixel of b) histogram[pixel & 63]++;
      row.lastFrameMetrics = {
        colorCounts: histogram,
        distinctColors: histogram.filter((n) => n > 0).length,
        blackFraction: histogram[0] / b.length,
        whiteFraction: histogram[63] / b.length,
        uniform: histogram.some((n) => n === b.length),
      };
      row.image = terminal.id + '.png';
      await writeFile(join(output, row.image), png(b, o.dimensions.width, o.dimensions.height));
      if (first) {
        const a = await readFile(join(path, 'frames', first.sha256 + '.gcolor8'));
        let different = 0;
        for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) different++;
        row.frameComparison = {
          kind: 'installed checkpoint versus last captured frame; no hardware reference',
          first: first.sha256,
          last: last.sha256,
          changedPixels: different,
          pixels: a.length,
          fraction: different / a.length,
        };
      }
    }
  }
  if (
    /InternalError: interrupted/.test(o?.exception?.message ?? '') ||
    row.diagnostics.phoneErrors.some((e) => /InternalError: interrupted/.test(e))
  ) {
    row.outcome = 'execution-budget-exceeded';
  }
  row.scenarioElapsedMs =
    row.scenarioStartUs == null || o?.virtualUs == null
      ? null
      : (o.virtualUs - row.scenarioStartUs) / 1000;
  row.frameRecords = row.frames.length;
  row.uniqueFrames = new Set(row.frames.map((f) => f.sha256)).size;
  delete row.frames;
  delete row.baselineFrame;
  if (
    row.outcome === 'scenario-completed' &&
    (row.diagnostics.phoneErrors.length || row.diagnostics.phoneLimits.length)
  )
    row.outcome = 'companion-error-observed';
  if (
    row.outcome === 'scenario-completed' &&
    (row.droppedEvents || row.droppedConsoleBytes || row.diagnostics.traceDropped)
  )
    row.outcome = 'capture-truncated';
  return row;
});
const counts = {};
for (const r of results) counts[r.outcome] = (counts[r.outcome] ?? 0) + 1;
const titles = manifest.entries.map((e) => {
  const cases = results.filter((r) => r.entryId === e.id);
  return {
    id: e.id,
    title: e.title,
    category: e.category,
    rank: e.rank,
    hearts: e.hearts,
    listing: e.listing,
    downloaded: !!e.acquisition.path,
    installedProfiles: cases.filter((c) => c.installed).map((c) => c.profile),
    completedProfiles: cases
      .filter((c) => c.outcome === 'scenario-completed')
      .map((c) => c.profile),
    outcomes: cases.map((c) => ({ profile: c.profile, outcome: c.outcome })),
  };
});
const clusters = {};
for (const r of results) {
  if (r.outcome === 'scenario-completed') continue;
  const key =
    r.outcome +
    ': ' +
    (r.reason ?? '').replace(/0x[\da-f]+/gi, '0xADDR').replace(/\b\d{3,}\b/g, 'N');
  (clusters[key] ??= []).push(r.id);
}
const limitations = [
  'Execution budgets use host wall time. Budget overruns are inconclusive and can reflect load or expensive guest code; they are not independently proven emulator defects.',
  'Popularity is the official Most Loved collection (hearts), not measured usage; the emery query filter is part of the snapshot.',
  'Unmodified PBWs only; older platform binaries are not remapped or rebuilt. Physical targets remain paused.',
  `${capture.durationMs / 1000}-second generic-core scenario with real sandboxed PKJS, seeded inputs and offline networking. No settings-page DOM/save, Android/iOS companion, live service, notification/calendar or full UI acceptance in this census.`,
  'Scenario completion means only bounded execution without the recorded error patterns; it does not establish correct rendering, hardware fidelity, cycles, long-term stability or every app feature.',
  'Frame comparisons are within-run pixel changes, with no physical/reference correctness oracle. Frames are sampled at CPU boundaries; transient guest frames may be missed.',
  'Instruction/MMIO traces are bounded 1000-step windows once per virtual second; serial/event caps and trace drop counts are explicit. UART captures are bytes available from the core; hardware overflow cannot be reconstructed.',
];
const report = {
  format: 'pebble-compatibility-evaluation',
  version: 1,
  evaluatedAt: new Date().toISOString(),
  evaluatorSha256: sha(await readFile(new URL(import.meta.url))),
  sealedAt: seal.finishedAt,
  ranking: manifest.ranking,
  execution: {
    workers: capture.workers,
    hostMs: capture.hostMs,
    casesPerMinute: capture.casesPerMinute,
    recordedProcessCpuUs: results.reduce((n, r) => n + (r.processCpuUs ?? 0), 0),
    peakWorkerRssKiB: Math.max(0, ...results.map((r) => r.maxRssKiB ?? 0)),
    artifactBytes: seal.files.reduce((n, f) => n + f.bytes, 0),
  },
  counts,
  titleCounts: {
    total: titles.length,
    downloaded: titles.filter((t) => t.downloaded).length,
    installedAny: titles.filter((t) => t.installedProfiles.length).length,
    completedAny: titles.filter((t) => t.completedProfiles.length).length,
  },
  limitations,
  clusters,
  titles,
  results,
};
await save(join(output, 'report.json'), report);
const csv = (v) => '"' + String(v ?? '').replaceAll('"', '""') + '"';
await writeFile(
  join(output, 'cases.csv'),
  [
    ['title', 'category', 'rank', 'profile', 'outcome', 'reason', 'hostMs', 'uniqueFrames'],
    ...results.map((r) => [
      r.title,
      r.category,
      r.rank,
      r.profile,
      r.outcome,
      r.reason,
      r.hostMs,
      r.uniqueFrames,
    ]),
  ]
    .map((row) => row.map(csv).join(','))
    .join('\n') + '\n',
);
const summary = `# Generic emulator compatibility census\n\nCaptured ${manifest.entries.length} titles across ${manifest.profiles.length} profiles (${results.length} cases). Raw capture sealed ${seal.finishedAt}; evaluation began afterwards.\n\n${manifest.ranking}\n\n| Outcome | Cases |\n|---|---:|\n${Object.entries(
  counts,
)
  .map(([k, v]) => `| ${k} | ${v} |`)
  .join('\n')}\n\n${Object.entries(report.titleCounts)
  .map(([k, v]) => `- ${k}: ${v}`)
  .join(
    '\n',
  )}\n\n## Scope and limits\n\n${limitations.map((s) => '- ' + s).join('\n')}\n\n## Failure groups\n\n${Object.entries(
  clusters,
)
  .sort((a, b) => b[1].length - a[1].length)
  .map(([k, v]) => `- ${v.length}: ${k.replaceAll('\n', ' ')}`)
  .join('\n')}\n`;
await writeFile(join(output, 'SUMMARY.md'), summary);
await writeFile(
  join(output, 'index.html'),
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Pebble compatibility census</title><style>body{font:15px system-ui;margin:2rem;background:#f7f8fa;color:#1b2430}main{display:grid;grid-template-columns:repeat(auto-fill,minmax(310px,1fr));gap:1rem}article{background:white;padding:1rem;border:1px solid #d8dfe7;border-radius:8px}img{image-rendering:pixelated;max-width:200px;max-height:228px}pre{white-space:pre-wrap;overflow-wrap:anywhere}input{padding:.8rem;width:90%;margin:1rem 0}small{display:block}</style><h1>Generic emulator compatibility census</h1><p>${escape(manifest.ranking)}</p><p>${escape(JSON.stringify(counts))}</p><details><summary>Scope and limits</summary><ul>${limitations.map((l) => '<li>' + escape(l) + '</li>').join('')}</ul></details><input id="filter" placeholder="Filter title, profile or outcome" aria-label="Filter cases"><main>${results.map((r) => `<article><h2>${escape(r.title)}</h2><small>${escape(r.profile)} · rank ${r.rank} · ${escape(r.category)}</small><p>${escape(r.outcome)}</p>${r.image ? `<img src="${r.image}" alt="Last captured firmware frame"><small>Last captured frame; may show firmware UI, not the app.</small>` : ''}<pre>${escape(r.reason ?? '')}</pre><p>${r.frameRecords} frame records · ${r.uniqueFrames} distinct frames</p><a href="../cases/${r.id}/observations.json">Raw observations</a> · <a href="../cases/${r.id}/console.txt">Console</a></article>`).join('')}</main><script>document.querySelector('#filter').oninput=e=>{for(const card of document.querySelectorAll('article'))card.hidden=!card.textContent.toLowerCase().includes(e.target.value.toLowerCase())}</script>`,
);
console.log(
  JSON.stringify({ counts, titleCounts: report.titleCounts, report: join(output, 'SUMMARY.md') }),
);
