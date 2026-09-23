/// <reference lib="webworker" />
/**
 * The libpebble3 phone in a browser worker: upstream's companion-app library
 * (tools/phone-spike) as the emulated watch's phone. It is a separate phone profile
 * from the built-in virtual phone (phone.worker.ts); the two never share a watch.
 *
 * The page sends `init` with where the libpebble3 build and SQLite's WebAssembly build
 * are served and the QuickJS engine binary, then `link` with the QEMU worker's
 * `phone-link` port. Everything the phone does on the wire comes from libpebble3 and
 * the firmware; this worker reports what libpebble3 reports.
 *
 * Apps' PebbleKit JS reaches the network only as the session's phone network setting
 * allows (`network`, libpebble-network.ts): off unless it is `cors`.
 *
 * In: init {bundleUrl, sqliteUrl, quickjsWasmUrl, network?} · network {id, setting}
 *     · link {port, platform?} (platform: the emulated watch's codename, e.g. 'flint')
 *     · unlink · install {id, bytes, name} · configure {id} · configuration-closed {id, url} · status {id}
 * Out: ready · done {id, value?} · failed {id?, message} · running-app {uuid}
 *     · pkjs-console {app, level, text}
 */
import * as fflate from 'fflate';
import { newQuickJSWASMModuleFromVariant, newVariant } from 'quickjs-emscripten-core';
import RELEASE_SYNC from '@jitl/quickjs-wasmfile-release-sync';
import {
  LibPebbleLink,
  asLibPebbleModule,
  provideLibPebbleDependencies,
} from './libpebble-host.ts';
import { libPebbleNetworkHost, type PhoneNetworkSetting } from './libpebble-network.ts';
import { quickJsPkjsHost } from './libpebble-pkjs.ts';

let link: LibPebbleLink | undefined;
let starting: Promise<LibPebbleLink> | undefined;
let runningApp = '';
let watcher: ReturnType<typeof setInterval> | undefined;
const network = libPebbleNetworkHost({ mode: 'disabled' });

async function start(data: {
  bundleUrl: string;
  sqliteUrl: string;
  quickjsWasmUrl: string;
  network?: PhoneNetworkSetting;
}): Promise<LibPebbleLink> {
  if (data.network) network.configure(data.network);
  const [sqliteModule, quickjsWasm] = await Promise.all([
    import(/* @vite-ignore */ data.sqliteUrl),
    fetch(data.quickjsWasmUrl).then((response) => {
      if (!response.ok) throw new Error(`Phone engine download failed (${response.status}).`);
      return response.arrayBuffer();
    }),
  ]);
  const quickjs = await newQuickJSWASMModuleFromVariant(
    newVariant(RELEASE_SYNC, { wasmBinary: quickjsWasm }),
  );
  provideLibPebbleDependencies({
    sqlite3: await sqliteModule.default(),
    fflate,
    pkjs: quickJsPkjsHost(quickjs, {
      console: (app, level, text) => postMessage({ type: 'pkjs-console', app, level, text }),
    }),
    network,
  });
  const phone = new LibPebbleLink(
    asLibPebbleModule(await import(/* @vite-ignore */ data.bundleUrl)),
  );
  phone.start();
  return phone;
}

function watchRunningApp(phone: LibPebbleLink) {
  clearInterval(watcher);
  watcher = setInterval(() => {
    const uuid = phone.runningApp();
    if (uuid === runningApp) return;
    runningApp = uuid;
    postMessage({ type: 'running-app', uuid });
  }, 250);
}

function ready(): LibPebbleLink {
  if (!link) throw new Error('The phone has not started.');
  return link;
}

self.onmessage = async ({ data }: MessageEvent) => {
  const id = data?.id;
  try {
    switch (data?.type) {
      case 'init':
        starting ??= start(data);
        link = await starting;
        postMessage({ type: 'ready' });
        break;
      case 'network':
        network.configure(data.setting);
        postMessage({ type: 'done', id });
        break;
      case 'link': {
        const phone = ready();
        phone.close();
        if (data.platform) phone.setUnknownWatchPlatform(data.platform);
        phone.connect(data.port);
        watchRunningApp(phone);
        postMessage({ type: 'done', id });
        break;
      }
      case 'unlink':
        clearInterval(watcher);
        link?.close();
        runningApp = '';
        postMessage({ type: 'done', id });
        break;
      case 'install':
        await ready().install(data.bytes, data.name);
        postMessage({ type: 'done', id });
        break;
      case 'configure':
        postMessage({ type: 'done', id, value: await ready().requestConfiguration() });
        break;
      case 'configuration-closed':
        ready().configurationClosed(data.url);
        postMessage({ type: 'done', id });
        break;
      case 'status':
        postMessage({ type: 'done', id, value: ready().status() });
        break;
      default:
        throw new Error(`Unknown phone command ${data?.type}.`);
    }
  } catch (error) {
    if (data?.type === 'init') starting = undefined;
    postMessage({
      type: 'failed',
      id,
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
