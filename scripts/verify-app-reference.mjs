// Reproduce app launch, touch and switching in independently supplied native QEMU.
// No app or firmware is modified, redistributed or used as a runtime backend.
import fs from 'node:fs/promises';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve, delimiter } from 'node:path';
import { tmpdir } from 'node:os';
import { PebbleTransport } from '../src/app/pebble-transport.ts';
import { appPackage } from '../src/app/archives.ts';
import { FIRMWARE_PROFILES, APP_PLATFORMS } from '../src/app/watch-profiles.ts';
const profile = process.env.PEBBLE_PROFILE ?? 'qemu_emery',
  version = process.env.PEBBLE_FIRMWARE_VERSION ?? '4.37.0';
if (!FIRMWARE_PROFILES[profile]) throw new Error('Unknown generic profile.');
if (!process.env.PEBBLE_FIRMWARE_DIR || !process.env.PEBBLE_APP_PBW)
  throw new Error('Set PEBBLE_FIRMWARE_DIR and PEBBLE_APP_PBW.');
const platform = FIRMWARE_PROFILES[profile].platform,
  { width, height } = APP_PLATFORMS[platform];
const assets = resolve(process.env.PEBBLE_FIRMWARE_DIR),
  out = resolve(process.env.PEBBLE_TRACE_DIR ?? 'tmp/app-reference-' + platform);
await fs.mkdir(out, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hash = (b) => createHash('sha256').update(b).digest('hex');
const executableName = process.env.PEBBLE_QEMU ?? 'qemu-pebble';
let executablePath;
for (const path of executableName.includes('/')
  ? [resolve(executableName)]
  : (process.env.PATH ?? '').split(delimiter).map((dir) => resolve(dir, executableName))) {
  if (
    await fs.access(path, fs.constants.X_OK).then(
      () => true,
      () => false,
    )
  ) {
    executablePath = path;
    break;
  }
}
if (!executablePath) throw new Error('Native QEMU executable is unavailable.');
const versionResult = spawnSync(executablePath, ['--version'], {
  encoding: 'utf8',
  timeout: 10000,
});
if (versionResult.error || versionResult.status !== 0)
  throw new Error(
    'Native QEMU version check failed: ' + (versionResult.error?.message ?? versionResult.stderr),
  );
const referenceIdentity = {
  name: 'native Pebble QEMU',
  version: versionResult.stdout.trim(),
  sha256: hash(await fs.readFile(executablePath)),
  clock: {
    execution: process.env.PEBBLE_QEMU_ICOUNT ?? 'default virtual clock',
    rtc: 'host wall time',
    inputScheduling: 'host waits; not deterministic virtual-time replay',
  },
};
const micro = resolve(assets, `${profile}_v${version}_micro_flash.bin`),
  flash = resolve(assets, `${profile}_v${version}_spi_flash.bin`);
const scratch = await fs.mkdtemp(resolve(tmpdir(), 'pebble-app-oracle-'));
const processHandle = spawn(
  executablePath,
  [
    '-machine',
    'pebble-' + platform,
    ...(process.env.PEBBLE_QEMU_ICOUNT ? ['-icount', process.env.PEBBLE_QEMU_ICOUNT] : []),
    '-audiodev',
    'driver=none,id=silent',
    '-global',
    'pebble-audio.audiodev=silent',
    '-display',
    'none',
    '-kernel',
    micro,
    '-drive',
    'if=mtd,format=raw,snapshot=on,file=' + flash,
    '-serial',
    'null',
    '-serial',
    `unix:${scratch}/uart.sock,server=on,wait=off`,
    '-serial',
    'file:' + scratch + '/console.bin',
    '-qmp',
    `unix:${scratch}/qmp.sock,server=on,wait=off`,
  ],
  { env: process.env, stdio: ['ignore', 'ignore', 'pipe'] },
);
let processError = '',
  socket,
  qmp,
  transport;
processHandle.stderr.on('data', (b) => (processError = (processError + b).slice(-4000)));
processHandle.on('error', (e) => (processError = String(e)));
const waitConsole = async (text) => {
  const end = Date.now() + 30000;
  while (Date.now() < end) {
    if (
      (await fs.readFile(scratch + '/console.bin').catch(() => Buffer.alloc(0))).includes(
        Buffer.from(text),
      )
    )
      return;
    if (processHandle.exitCode !== null) throw new Error(processError);
    await sleep(50);
  }
  throw new Error('Native QEMU did not log ' + text + '. ' + processError);
};
const connect = (path) =>
  new Promise((resolve, reject) => {
    const socket = net.connect(path);
    socket.once('error', reject);
    socket.once('connect', () => resolve(socket));
  });
try {
  await waitConsole('Ready for communication.');
  qmp = await connect(scratch + '/qmp.sock');
  let buffer = '',
    id = 0;
  const pending = new Map();
  qmp.on('data', (b) => {
    buffer += b;
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (!line.trim()) continue;
      const value = JSON.parse(line);
      const job = pending.get(value.id);
      if (job) {
        pending.delete(value.id);
        clearTimeout(job.timer);
        value.error
          ? job.reject(new Error(JSON.stringify(value.error)))
          : job.resolve(value.return);
      }
    }
  });
  const command = (execute, args = {}) =>
    new Promise((resolve, reject) => {
      const token = ++id;
      const timer = setTimeout(() => {
        pending.delete(token);
        reject(new Error('QMP timeout: ' + execute));
      }, 10000);
      pending.set(token, { resolve, reject, timer });
      qmp.write(JSON.stringify({ execute, arguments: args, id: token }) + '\n');
    });
  await command('qmp_capabilities');
  socket = await connect(scratch + '/uart.sock');
  const controls = [];
  transport = new PebbleTransport(
    {
      writeUart: (bytes) =>
        new Promise((resolve, reject) => socket.write(bytes, (e) => (e ? reject(e) : resolve()))),
      advance: () => sleep(5),
      nowMs: () => performance.now(),
    },
    {
      onControl: (channel, payload) => {
        if (controls.length < 1000) controls.push({ channel, bytes: [...payload] });
      },
    },
  );
  socket.on('data', (b) => transport.feedUart(b));
  const pbw = await fs.readFile(process.env.PEBBLE_APP_PBW);
  await transport.setBluetooth(true);
  await transport.install(appPackage(pbw, platform));
  console.log('Native app installed.');
  await sleep(1000);
  const frameBytes = platform === 'flint' ? 3360 : width * height;
  await command('human-monitor-command', {
    'command-line': `pmemsave 0x50000000 ${frameBytes} "${scratch}/initial.bin"`,
  });
  const initial = await fs.readFile(scratch + '/initial.bin');
  if (platform !== 'flint')
    await command('input-send-event', {
      events: [
        { type: 'abs', data: { axis: 'x', value: Math.ceil((100 * 32767) / width) } },
        { type: 'abs', data: { axis: 'y', value: Math.ceil((182 * 32767) / height) } },
        { type: 'btn', data: { button: 'left', down: true } },
      ],
    });
  await sleep(100);
  if (platform !== 'flint')
    await command('input-send-event', {
      events: [{ type: 'btn', data: { button: 'left', down: false } }],
    });
  await sleep(1000);
  await command('human-monitor-command', {
    'command-line': `pmemsave 0x50000000 ${frameBytes} "${scratch}/after.bin"`,
  });
  const after = await fs.readFile(scratch + '/after.bin');
  console.log('native touch changes frame', !initial.equals(after));
  await fs.writeFile(out + '/initial.bin', initial);
  await fs.writeFile(out + '/after.bin', after);
  await transport.install(
    appPackage(await fs.readFile(`public/examples/clock-${platform}.pbw`), platform),
  );
  console.log('Native app switched to Clock.');
  await command('stop');
  const size = platform === 'flint' ? 3360 : width * height;
  await command('human-monitor-command', {
    'command-line': `pmemsave 0x50000000 ${size} "${scratch}/frame.bin"`,
  });
  const raw = await fs.readFile(scratch + '/frame.bin');
  const frame =
    platform === 'flint'
      ? Uint8Array.from({ length: width * height }, (_, i) =>
          raw[Math.floor(i / width) * 20 + Math.floor((i % width) / 8)] & (1 << (i % 8))
            ? 255
            : 192,
        )
      : raw;
  const consoleBytes = await fs.readFile(scratch + '/console.bin');
  await fs.writeFile(out + '/native-frame.bin', frame);
  await fs.writeFile(out + '/native-console.bin', consoleBytes);
  const evidence = {
    referenceIdentity,
    referenceTarget: 'native-qemu',
    scope:
      'Launch, input and app-switch observations. A changed frame does not establish gameplay correctness or physical timing.',
    profile,
    version,
    qemuIcount: process.env.PEBBLE_QEMU_ICOUNT ?? null,
    width,
    height,
    pbwSha256: hash(pbw),
    microSha256: hash(await fs.readFile(micro)),
    flashSha256: hash(await fs.readFile(flash)),
    frameSha256: hash(frame),
    frameBytes: frame.length,
    touch: platform === 'flint' ? null : { x: 100, y: 182, heldMs: 100 },
    frameChangedAfterTouch: !initial.equals(after),
    switchedToClock: true,
    controls,
  };
  await fs.writeFile(out + '/native.json', JSON.stringify(evidence, null, 2) + '\n');
  console.log(
    JSON.stringify({ profile, frameBytes: frame.length, frameSha256: evidence.frameSha256 }),
  );
} finally {
  await fs.writeFile(
    out + '/console.bin',
    await fs.readFile(scratch + '/console.bin').catch(() => Buffer.alloc(0)),
  );
  transport?.dispose();
  socket?.destroy();
  qmp?.destroy();
  if (processHandle.exitCode === null) {
    const closed = new Promise((r) => processHandle.once('exit', r));
    processHandle.kill('SIGTERM');
    await Promise.race([closed, sleep(2000)]);
    if (processHandle.exitCode === null) processHandle.kill('SIGKILL');
  }
  await fs.rm(scratch, { recursive: true, force: true });
}
