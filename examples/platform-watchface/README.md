# Platform watchface

A native SDK 3 watchface that builds for all seven SDK 4.33.1 platforms. It uses a
raw text resource, automatically assigned message keys, a shared JavaScript
module, JSON settings, geolocation, XMLHttpRequest, and actual watch ACKs.

In the emulator, import this folder with **Load example**, select the build
platform, import SDK 4.33.1, and build. Install into the matching running emulator
firmware. Firmware execution currently covers Flint, Emery, and Gabbro.

The virtual phone's **Test responses** default fixture matches the example weather
URL. Select that mode and restart the phone script to show `23C` alongside the
injected coordinates. Change the fixture to exercise other temperatures/errors.
The example address is deliberately a fixture URL, not a live weather service.
Network-disabled mode still displays location.

The earlier `examples/watchface` is retained unchanged as the pinned Emery rendering
reference. This example adapts its layout to rectangular and round display sizes.
