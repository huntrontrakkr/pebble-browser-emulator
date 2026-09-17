# Linux compiler smoke project

This recipe generates C using Python and compiles it with a Linux ARM GCC executable inside
the Wasm VM. Import a Linux image containing Python 3 and `arm-none-eabi-gcc` first. The result
is an ARM object, not an installable Pebble application. The example tests custom script
execution; use `examples/sensor-test` or `examples/platform-watchface` for a complete PBW.

No dependencies or native binaries are included. The local acceptance experiment used
Alpine's original packages in the image identified by `docs/evidence/linux-build-gate.json`.
