# Build tooling only. Visitors' source and proprietary SDK/firmware are not included.
# Convert this image to browser WASI with container2wasm; see README.md.
FROM alpine:3.18.12
RUN apk add --no-cache python3 py3-pip nodejs npm bash make cmake ninja git \
    gcc-arm-none-eabi g++-arm-none-eabi newlib-arm-none-eabi binutils-arm-none-eabi \
    freetype py3-pyelftools py3-pillow
RUN pip3 install --no-cache-dir pebble-tool==5.0.38 freetype-py==2.5.1 sh==2.2.1 pypng==0.20220715.0
WORKDIR /project
ENTRYPOINT ["/bin/sh"]
