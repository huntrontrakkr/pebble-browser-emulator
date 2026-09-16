/// <reference lib="webworker" />
import {
  newVariant,
  newQuickJSWASMModuleFromVariant,
  type QuickJSWASMModule,
} from 'quickjs-emscripten-core';
import RELEASE_SYNC from '@jitl/quickjs-wasmfile-release-sync';
import { VirtualPhone } from './virtual-phone.ts';
let moduleLoad: Promise<QuickJSWASMModule> | undefined;
let module: QuickJSWASMModule | undefined,
  phone: VirtualPhone | undefined,
  nowMs = 0,
  timer: ReturnType<typeof setInterval> | undefined,
  appId = '',
  lastStorage = '',
  generation = 0,
  desiredConnection = false;
const storage = new Map<string, Record<string, string>>();
function output() {
  if (!phone) return;
  for (const event of phone.drainEvents()) postMessage({ type: 'event', event });
  const values = phone.getStorage(),
    serialized = JSON.stringify(values);
  storage.set(appId, values);
  if (serialized !== lastStorage) {
    lastStorage = serialized;
    postMessage({ type: 'storage', appId, storage: values });
  }
}
function stop() {
  generation++;
  clearInterval(timer);
  timer = undefined;
  if (phone) {
    try {
      output();
    } catch {}
    phone.dispose();
    phone = undefined;
  }
  postMessage({ type: 'status', status: 'Stopped' });
}
function fail(e: unknown) {
  stop();
  postMessage({ type: 'error', message: String(e) });
}
self.onmessage = async ({ data }) => {
  let job = generation;
  try {
    if (data.type === 'start') {
      stop();
      job = generation;
      desiredConnection = !!data.connected;
      if (!module) {
        moduleLoad ??= (async () => {
          const response = await fetch(data.wasmUrl);
          if (!response.ok) throw new Error('Phone engine download failed.');
          return newQuickJSWASMModuleFromVariant(
            newVariant(RELEASE_SYNC, { wasmBinary: await response.arrayBuffer() }),
          );
        })().catch((error) => {
          moduleLoad = undefined;
          throw error;
        });
        module = await moduleLoad;
      }
      if (job !== generation) return;
      appId = data.appId;
      lastStorage = '';
      nowMs = Date.now();
      phone = new VirtualPhone(module, {
        appId,
        nowMs,
        coordinates: data.coordinates,
        storage: storage.get(appId) ?? data.storage ?? {},
        messageKeys: data.messageKeys ?? {},
      });
      phone.setConnected(desiredConnection);
      phone.start(data.source, data.name);
      output();
      postMessage({ type: 'status', status: 'Running' });
      timer = setInterval(() => {
        try {
          phone?.advanceTime((nowMs += 100));
          output();
        } catch (e) {
          fail(e);
        }
      }, 100);
      return;
    }
    if (data.type === 'stop') {
      stop();
      return;
    }
    if (data.type === 'connection') {
      desiredConnection = !!data.connected;
      phone?.setConnected(desiredConnection);
      output();
      return;
    }
    if (!phone && data.type === 'ack') return;
    if (!phone && data.type === 'appmessage') {
      postMessage({
        type: 'inbound-result',
        transportGeneration: data.transportGeneration,
        transactionId: data.transactionId,
        accepted: false,
      });
      return;
    }
    if (!phone) throw new Error('Start a phone script first.');
    switch (data.type) {
      case 'location':
        phone.setLocation(data.coordinates);
        break;
      case 'advance':
        phone.advanceTime((nowMs += data.milliseconds));
        break;
      case 'connection':
        phone.setConnected(data.connected);
        break;
      case 'appmessage':
        phone.injectAppMessage(data.payload);
        postMessage({
          type: 'inbound-result',
          transportGeneration: data.transportGeneration,
          transactionId: data.transactionId,
          accepted: true,
        });
        break;
      case 'ack':
        phone.acknowledgeAppMessage(data.transactionId, data.accepted);
        break;
      case 'configuration':
        phone.showConfiguration();
        break;
      case 'configurationClosed':
        phone.closeConfiguration(data.response);
        break;
      default:
        throw new Error('Unknown phone command.');
    }
    output();
  } catch (e) {
    if (job !== generation) return;
    if (data.type === 'appmessage')
      postMessage({
        type: 'inbound-result',
        transportGeneration: data.transportGeneration,
        transactionId: data.transactionId,
        accepted: false,
      });
    fail(e);
  }
};
