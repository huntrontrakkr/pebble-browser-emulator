/// <reference lib="webworker" />
import { compilerSdkFiles } from './sdk-files.ts';
import { inspectPackage, untarGzip, unzipBounded } from './archives.ts';
addEventListener(
  'message',
  ({
    data,
  }: MessageEvent<{ id: number; kind: 'sdk' | 'package' | 'source'; bytes: Uint8Array }>) => {
    try {
      postMessage({
        id: data.id,
        result:
          data.kind === 'sdk'
            ? compilerSdkFiles(untarGzip(data.bytes))
            : data.kind === 'source'
              ? unzipBounded(data.bytes, 32 * 1024 * 1024)
              : inspectPackage(data.bytes),
      });
    } catch (e) {
      postMessage({ id: data.id, error: String(e) });
    }
  },
);
