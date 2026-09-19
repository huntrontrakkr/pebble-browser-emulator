/**
 * WebAssembly exposes an `i32` result to JavaScript as a signed number.
 * Rust's `u32::MAX` run-failure sentinel therefore arrives as `-1` even
 * though native Rust callers observe `0xffff_ffff`.
 */
export function isWasmRunFailure(value: number): boolean {
  return wasmU32(value) === 0xffff_ffff;
}

export function wasmU32(value: number): number {
  return value >>> 0;
}
