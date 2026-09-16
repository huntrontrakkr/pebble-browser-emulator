# Architecture and current interfaces

Angular sends typed commands to a module Worker. The Worker owns a Rust-produced Wasm
instance. Wasm has no host imports: CPU/memory/framebuffer operations happen locally.
Angular only converts the returned ARGB2222 bytes to a Canvas image.

## Current diagnostic profile

This is a development test board. It intentionally is **not qemu_emery or Obelix**.

| Region | Address | Behavior |
|---|---|---|
| Raw code image | 0x00000000 | Up to 4 MiB, read-only, vector table at zero |
| SRAM | 0x20000000 | 512 KiB |
| Button input | 0x40000000 | Bits 0–3: Back, Up, Select, Down |
| Battery input | 0x40000004 | Integer 0–100; no chemistry/power model |
| Framebuffer | 0x50000000 | 45,600 ARGB2222 bytes, 200×228 |

The vector table supplies initial SP and Thumb reset address. Invalid imports do not replace
the running image. Unsupported instructions and addresses halt with PC/address diagnostics.
Only supported aligned word/halfword accesses are accepted; this is not an Armv8-M policy.

Supported Thumb forms: MOVS/CMP/ADDS/SUBS immediate; three-register/immediate-three ADD/SUB;
literal LDR; immediate word/byte load/store; conditional and unconditional branches; NOP;
BKPT (diagnostic halt). There is no CPU timing claim, exception handling, or production
startup compatibility. Instruction counters are not cycles.

## ABI v1

`abi_version`, `load_diagnostic`, `run(budget)`, `reset`, `register(index)`, `flags`,
`instructions`, `halted`, `fault`, `framebuffer_ptr`, `set_inputs`, `buttons`, `battery`,
`input_reserve`, `load_image`, `snapshot`, `restore`, `encode_ping`, `output_ptr`, `output_len`.

Uploads and outputs occupy separate Rust-owned buffers. Copy output immediately; buffer
addresses can change after calls or memory growth. Requests are processed serially inside
one Worker. Each run batch is bounded so pause/cancel messages can be processed.
Snapshot format is currently internal JSON, valid only for this diagnostic version.

## Protocol foundation

Raw Pebble packets are `payload_length:u16BE | endpoint:u16BE | payload`. They have no
frame checksum or magic delimiter. QEMU FEED/BEEF framing is a distinct transport layer.
The current UI only encodes a packet; it does not synthesize watch acknowledgments.

## Next architectural boundary

Implement complete CPU/system behavior and the qemu_emery board using versioned profiles,
then install PBWs through a virtual phone transport. Introduce deterministic device-event
scheduling before adding timers/interrupts; never tie guest time directly to animation frames.
Production Obelix remains an independent board with its own validated boot dependencies.
