# Linux build images

The compatibility Worker runs container2wasm WASI images entirely on the user's device.
It supplies `/work` (the selected source), `/inputs` (SDKs and dependencies) and `/outputs`.
Commands run in a private copy at `/tmp/pebble-project` so POSIX operations work. Only named
artifacts are returned. There is no network device or proxy, and no host file handles.

The included Dockerfile is an **image preparation recipe, not a verified packaged SDK**.
It is for maintainers or users preparing their own toolchain once. Do not run visitors'
projects through Docker or a CI compiler. No proprietary SDK or firmware is included.
The Python 3 toolchain is intended for modern SDKs; Python 2 SDKs require their own image.

Example preparation with [container2wasm](https://github.com/container2wasm/container2wasm):

```sh
docker build -t pebble-browser-build tools/linux-build
c2w --target-arch amd64 --build-arg VM_MEMORY_SIZE_MB=512 \
  pebble-browser-build pebble-browser-build.wasm
```

Import the resulting `.wasm` in Projects → Linux compatibility build. Supply SDK and
dependency archives with the input picker; their names appear under `/inputs`. The recipe
must unpack/configure the SDK required by the project and name the resulting PBW explicitly.
Toolchain preinstallation, SDK setup and dependency acquisition are separate gates: the
Dockerfile above has not yet passed a full SDK/Waf/PBW acceptance test.

Review the final image size and licenses before distribution. The current Worker accepts
images up to 512 MiB, bounds Wasm linear memory to 1.5 GiB, shared files to 256 MiB, artifacts
to 64 MiB and logs to 2 MiB. Linux's own RAM and writable filesystem limits are selected
when converting the image; increasing the host ceiling does not increase guest RAM.
The original image and memory-bounded module hashes are recorded separately. The bounded
module changes only the Wasm memory declaration, never watch firmware.

Shell commands are untrusted guest code. Builds are canceled by terminating their Worker,
including stuck native programs. Cache credentials and application storage are not mounted.
For dependencies, use explicit locally imported archives; do not add a CORS proxy.

## Recipe format

```yaml
version: 1
backend: linux-wasi
workdir: .
commands:
  - python3 generate.py
  - make
outputs:
  - build/example.pbw
timeoutSeconds: 600
env:
  EXAMPLE_SETTING: 'value'
# Optional: require one exact image before executing any command.
# imageSha256: <64 lowercase hex digits>
```

Paths are relative to the selected project. Output paths are relative to `workdir`; wildcards
are rejected. Unknown recipe fields and duplicate YAML keys fail validation. Environment
values are quoted literally. `PEBBLE_PLATFORM` is provided to guest commands. A recipe can
use any tool present in the image, but importing a repository does not guarantee its build
environment is available.

## Verified execution

The acceptance evidence uses the upstream container2wasm Python 3.11/Alpine 3.18.3 demo
image (Linux 6.1, x86-64), imported locally at its recorded SHA-256. It runs custom Python
and the actual Alpine ARM GCC 12.2.0 executable, returning an ARM EABI5 object. This does
not establish a complete Waf build, custom font generation, or arbitrary npm install support.
See `docs/evidence/linux-build-gate.json` for image/package provenance and measured artifacts.

To reproduce that gate, import the exact image and APKs listed in the evidence file locally:

```sh
PEBBLE_LINUX_IMAGE=/path/to/reference-linux.wasm \
PEBBLE_LINUX_APKS=/path/to/apk-directory \
node scripts/verify-linux-arm-build.mjs
```

The script verifies every imported hash, selectively extracts compiler files inside the small
guest, generates C with Python, and checks the ARM object's hash. No image, compiler executable
or SDK is committed. A separate [browser UI gate](../../docs/BROWSER_TESTING.md) verifies large
image persistence across reload, Python execution, artifact export and cancellation.
