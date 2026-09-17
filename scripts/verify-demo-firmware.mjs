import { FirmwareHarness } from '../tests/firmware-harness.mjs';
import { defaultDemoSettings } from '../src/app/demo-settings.ts';
const directory = process.argv[2];
if (!directory)
  throw new Error('Usage: node scripts/verify-demo-firmware.mjs FIRMWARE_DIRECTORY [qemu_emery]');
const profiles = process.argv[3] ? [process.argv[3]] : ['qemu_flint', 'qemu_emery', 'qemu_gabbro'];
const result = [];
for (const profile of profiles) {
  const h = new FirmwareHarness();
  try {
    const began = Date.now();
    await h.boot(profile, directory);
    console.error(profile, 'boot', Date.now() - began);
    const generation = h.messages.findLast((m) => m.type === 'session').generation;
    const settings = defaultDemoSettings();
    h.send({ type: 'demo-settings', generation, revision: 1, settings });
    const applied = await h.wait((m) => m.type === 'demo-applied' && m.revision === 1);
    console.error(profile, 'demo', Date.now() - began);
    await h.install(`public/examples/clock-${profile.replace('qemu_', '')}.pbw`);
    await h.wait((m) => m.type === 'state' && m.state.battery === 69);
    h.send({ type: 'demo-notification', generation, revision: 2, settings, id: 0 });
    await h.wait((m) => m.type === 'demo-applied' && m.revision === 2);
    settings.enabled = false;
    h.send({ type: 'demo-settings', generation, revision: 3, settings });
    await h.wait((m) => m.type === 'demo-applied' && m.revision === 3);
    h.send({ type: 'pause' });
    result.push({
      profile,
      ...applied,
      realBlobAcks: h.messages
        .filter((m) => m.type === 'protocol' && m.direction === 'watch' && m.endpoint === 0xb1db)
        .map((m) => Array.from(m.bytes)),
      signals: [...new Set(h.signals.map((m) => m.signal.kind))],
    });
  } finally {
    await h.close();
  }
}
console.log(JSON.stringify(result, null, 2));
