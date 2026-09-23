// The host glue end to end: upstream's libpebble3, linked for the browser, as the phone
// of the emulated watch. The QEMU worker runs the released firmware in the existing
// firmware harness; the phone runs on this thread, as it would on a page; the glue
// (src/app/libpebble-host.ts) carries serial bytes between them over a MessagePort.
// Every response comes from the firmware or from libpebble3.
import { MessageChannel } from 'node:worker_threads';
import { readFile } from 'node:fs/promises';
import { FirmwareHarness } from '../../tests/firmware-harness.mjs';
import { LibPebbleLink } from '../../src/app/libpebble-host.ts';
import { loadPhone } from './load.mjs';

const [dist, deps, firmware, app = 'public/examples/clock-emery.pbw'] = process.argv.slice(2);
const appUuid = JSON.parse(
  // The bundle's own appinfo.json, read the way the watch would see it installed.
  new TextDecoder().decode((await import('fflate')).unzipSync(await readFile(app))['appinfo.json']),
).uuid;
const seconds = Number(process.env.PHONE_E2E_SECONDS ?? 60);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const phone = await loadPhone(dist, deps);
const harness = new FirmwareHarness();
let code = 1;
try {
  const booted = Date.now();
  await harness.boot('qemu_emery', firmware);
  console.log(`firmware ready after ${((Date.now() - booted) / 1000).toFixed(1)} s`);

  // Real time, as in Preview: libpebble3's timeouts are wall-clock, and a worker running
  // flat out in Node services its messages only every few seconds.
  harness.send({ type: 'pacing', realtime: true });
  const link = new LibPebbleLink(phone);
  link.start();
  const { port1, port2 } = new MessageChannel();
  harness.send({ type: 'phone-link', port: port2 }, [port2]);
  await harness.wait((m) => m.type === 'phone-link' && m.attached);
  link.connect(port1);

  // Negotiation is done when libpebble3 has read the watch's version response and
  // recorded its properties; the status names them.
  const end = Date.now() + seconds * 1000;
  let status = '';
  while (Date.now() < end) {
    status = link.status();
    if (/knownWatchProps=KnownWatchProperties/.test(status)) break;
    await sleep(500);
  }
  const negotiated = /knownWatchProps=KnownWatchProperties/.test(status);
  console.log('link bytes', JSON.stringify(link.counters));
  console.log('status:\n' + status);
  console.log(negotiated ? 'NEGOTIATED' : `not negotiated within ${seconds} s`);

  // Install through libpebble3's own sideload, which syncs the app to the watch and
  // launches it; the watch reports the running app itself (AppRunState).
  let launched = false;
  if (negotiated) {
    const began = Date.now();
    try {
      await link.install(await readFile(app), 'Clock.pbw');
      console.log(`sideload finished after ${((Date.now() - began) / 1000).toFixed(1)} s`);
    } catch (error) {
      console.log('install failed:', error.message);
    }
    const until = Date.now() + seconds * 1000;
    while (Date.now() < until) {
      if (link.runningApp() === appUuid) break;
      await sleep(500);
    }
    launched = link.runningApp() === appUuid;
    status = link.status();
    console.log('link bytes', JSON.stringify(link.counters));
    console.log(
      launched
        ? `LAUNCHED ${appUuid}`
        : `${appUuid} not running within ${seconds} s (running: ${link.runningApp() || 'none reported'})`,
    );
    console.log('status:\n' + status);
  }
  console.log('firmware console tail:\n' + harness.serial.slice(-4000));
  link.close();
  code = negotiated && launched ? 0 : 1;
} catch (error) {
  console.log('e2e failed:', error);
  console.log('firmware console tail:\n' + harness.serial.slice(-3000));
} finally {
  await harness.close();
}
process.exit(code);
