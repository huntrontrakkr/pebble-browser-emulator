// Observations only: never change guest state or manufacture a readiness response.
export function bootFailureReason(api, done, elapsedMs, limitMs = 120000) {
  if (done === -1 || done === 0xffffffff || api.spike_faulted()) return 'Firmware bus fault';
  if (api.spike_cfsr() || api.spike_hfsr()) return 'Firmware CPU fault during boot';
  if (elapsedMs >= limitMs) return 'Firmware boot exceeded two minutes';
  return null;
}

export function bootDiagnostics(
  api,
  { profile, firmware, coreSha256, steps, elapsedMs, serial, reason },
) {
  const hex = (n) => '0x' + (n >>> 0).toString(16).padStart(8, '0');
  return {
    profile,
    firmware,
    coreSha256,
    reason,
    elapsedMs: Math.round(elapsedMs),
    schedulerSteps: steps,
    pc: hex(api.spike_pc()),
    xpsr: hex(api.spike_xpsr()),
    cfsr: hex(api.spike_cfsr()),
    hfsr: hex(api.spike_hfsr()),
    bfar: hex(api.spike_bfar()),
    bfarValid: Boolean(api.spike_cfsr() & 0x8000),
    busFault: Boolean(api.spike_faulted()),
    busFaultAddress: hex(api.spike_fault()),
    busFaultPc: hex(api.spike_fault_pc()),
    registers: Array.from({ length: 16 }, (_, i) => hex(api.spike_register(i))),
    ticks: api.spike_ticks(),
    frames: api.spike_frame_counter(),
    // Retain a bounded tail and escape control bytes when serialized to JSON.
    uartTail: serial.slice(-8000),
  };
}
