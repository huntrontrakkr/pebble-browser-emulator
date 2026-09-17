// Fixed workload shared by Node and browser measurement. Only core calls are timed.
export function workload(api, micro, flash, profile) {
  const pointer = api.spike_upload(micro.length + flash.length);
  if (!pointer) throw new Error('Firmware upload failed');
  const upload = new Uint8Array(api.memory.buffer, pointer, micro.length + flash.length);
  upload.set(micro);
  upload.set(flash, micro.length);
  if (!api.spike_boot_profile(profile, micro.length, flash.length))
    throw new Error('Firmware boot rejected');
  api.spike_set_epoch(1789660000);
  const checkpoints = [],
    phases = { boot: 0, buttons: 0 };
  let schedulerSteps = 0;
  for (let block = 0; block < 40; block++) {
    if (block >= 20) {
      api.spike_button([0, 2, 0, 8, 0, 4, 0, 1][block % 8]);
      if (profile !== 1) api.spike_touch(block % 2, 30 + block, 40);
    }
    const start = performance.now();
    const done = api.spike_run_until(250000, Number.MAX_SAFE_INTEGER);
    phases[block < 20 ? 'boot' : 'buttons'] += performance.now() - start;
    if (done !== 250000 || api.spike_faulted())
      throw new Error(`Core failed at ${api.spike_pc().toString(16)}`);
    schedulerSteps += done;
    const uart = [];
    for (let port = 0; port < 3; port++) {
      const length = api.spike_uart_tx_len(port);
      uart.push(Array.from(new Uint8Array(api.memory.buffer, api.spike_uart_tx_ptr(port), length)));
      api.spike_uart_tx_consume(port, length);
    }
    checkpoints.push({
      ticks: api.spike_ticks(),
      registers: Array.from({ length: 16 }, (_, i) => api.spike_register(i)),
      xpsr: api.spike_xpsr(),
      cfsr: api.spike_cfsr(),
      hfsr: api.spike_hfsr(),
      frames: api.spike_frame_counter(),
      frame: Array.from(
        new Uint8Array(api.memory.buffer, api.spike_frame(), api.spike_frame_len()),
      ),
      uart,
    });
  }
  return { phases, schedulerSteps, memoryBytes: api.memory.buffer.byteLength, checkpoints };
}
