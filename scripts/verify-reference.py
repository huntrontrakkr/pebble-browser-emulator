"""Compare the shipped Wasm diagnostic with independent Unicorn ARM execution.

Run: uv run --with unicorn==2.1.4 python scripts/verify-reference.py
Requires npm run build:wasm. No files are written and no firmware is downloaded.
"""
import hashlib
import json
import struct
import subprocess

from unicorn import Uc, UC_ARCH_ARM, UC_MODE_THUMB, UC_MODE_MCLASS, UC_HOOK_CODE
from unicorn.arm_const import UC_ARM_REG_SP, UC_ARM_REG_R0, UC_ARM_REG_R1, UC_ARM_REG_R2

node = """
import {readFileSync} from 'node:fs';
const m=(await WebAssembly.instantiate(readFileSync('public/wasm/emulator.wasm'),{})).instance.exports;
m.load_diagnostic(); m.snapshot();
const initial=JSON.parse(new TextDecoder().decode(new Uint8Array(m.memory.buffer,m.output_ptr(),m.output_len())));
m.run(300000); m.snapshot();
const final=JSON.parse(new TextDecoder().decode(new Uint8Array(m.memory.buffer,m.output_ptr(),m.output_len())));
console.log(JSON.stringify({initial,final}));
"""
states = json.loads(subprocess.check_output(["node", "--input-type=module", "-e", node]))
image = bytes(states["initial"]["flash"])
sp, reset = struct.unpack_from("<II", image)
cpu = Uc(UC_ARCH_ARM, UC_MODE_THUMB | UC_MODE_MCLASS)
cpu.mem_map(0, 4096)
cpu.mem_write(0, image)
cpu.mem_map(0x20000000, 512 * 1024)
cpu.mem_map(0x50000000, 65536)
cpu.reg_write(UC_ARM_REG_SP, sp)
instructions = 0

def instruction(uc, address, size, _):
    global instructions
    instructions += 1
    if uc.mem_read(address, 2) == b"\x00\xbe":
        uc.emu_stop()  # Diagnostic halt; not an architectural BKPT exception test.

cpu.hook_add(UC_HOOK_CODE, instruction)
cpu.emu_start(reset, len(image), count=1_000_000)
actual = bytes(cpu.mem_read(0x50000000, 45600))
assert actual == bytes(states["final"]["framebuffer"])
assert instructions == states["final"]["instructions"] == 228004
for index, register in enumerate([UC_ARM_REG_R0, UC_ARM_REG_R1, UC_ARM_REG_R2]):
    assert cpu.reg_read(register) == states["final"]["registers"][index]
print(json.dumps({"reference": "Unicorn 2.1.4 ARM M-class", "instructions": instructions,
                  "framebuffer_sha256": hashlib.sha256(actual).hexdigest(),
                  "result": "match"}, indent=2))
