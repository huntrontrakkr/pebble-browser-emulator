# Firmware identity and bundles

The release picker accepts an exact tag and any public `owner/repository` GitHub source.
Tags are not rewritten into a particular version pattern. Missing releases, download errors
and unsupported boards remain explicit. Where GitHub disallows direct browser downloads,
download the matching assets and open them locally. Firmware is not uploaded.

For supported generic boards, the existing micro/SPI pickers remain the quickest route.
For a repeatable named combination, select one bundle JSON and its assets together:

```json
{
  "format": "pebble-firmware-bundle",
  "version": 1,
  "board": "qemu_emery",
  "revision": "generic",
  "firmwareVersion": "your-exact-release-tag",
  "assets": [
    { "role": "micro-flash", "path": "micro.bin", "sha256": "replace-with-the-file-sha256" },
    { "role": "spi-flash", "path": "spi.bin", "sha256": "replace-with-the-file-sha256" }
  ]
}
```

Replace each hash with the file's 64-character lowercase SHA-256. Use plain filenames in
the UI picker; it does not import an entire directory tree. Generic boards require both
roles and a 32 MiB SPI image. Micro flash can be raw or an ELF with validated physical load
addresses. Files are checked before the firmware-load request.

`qemu_flint`, `qemu_emery` and `qemu_gabbro` are independent emulator-board identities.
`asterix`, `obelix` and `getafix` identify physical boards with distinct firmware roles
(package, internal/external flash, bootloader and controller; SiFli also has ROM).
Physical bundles currently support checksum/identity inspection only and report the missing
hardware runtime. They are never relabeled as generic firmware.

Arbitrary version _selection_ does not establish arbitrary firmware _execution_. The current
boot and application gates cover unchanged official 4.37.0 on all three generic boards and
4.36.0 on Emery. Stock physical images require their own memory maps, peripherals, boot ROM
and controller behavior. Unsupported instructions/register accesses remain failures.
