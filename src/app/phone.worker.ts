/// <reference lib="webworker" />
import {
  newVariant,
  newQuickJSWASMModuleFromVariant,
  type QuickJSWASMModule,
} from 'quickjs-emscripten-core';
import RELEASE_SYNC from '@jitl/quickjs-wasmfile-release-sync';
import { VirtualPhone } from './virtual-phone.ts';
import { PhoneCorsNetwork } from './phone-network.ts';
let moduleLoad: Promise<QuickJSWASMModule> | undefined;
let module: QuickJSWASMModule | undefined,
  phone: VirtualPhone | undefined,
  nowMs = 0,
  timer: ReturnType<typeof setInterval> | undefined,
  appId = '',
  lastStorage = '',
  generation = 0,
  desiredConnection = false;
let network: PhoneCorsNetwork | undefined;
let externalClock = false,
  clockOriginUs = 0,
  clockEpochMs = 0,
  latestClockUs = 0;
let pendingClocks: { sequence: number; transportGeneration: number }[] = [];
let pendingLocations: any[] = [];
let starting = false;
function acknowledgeClocks() {
  if (!phone) return;
  for (const clock of pendingClocks)
    postMessage({
      type: 'clock-ack',
      ...clock,
      virtualUs: latestClockUs,
      phoneGeneration: generation,
    });
  pendingClocks = [];
}
function advanceWatchClock(virtualUs: number) {
  if (!Number.isFinite(virtualUs) || virtualUs < latestClockUs) return;
  latestClockUs = virtualUs;
  phone?.advanceTime((nowMs = clockEpochMs + Math.floor((latestClockUs - clockOriginUs) / 1000)));
}
const storage = new Map<string, Record<string, string>>();
function output() {
  if (!phone) return;
  for (const event of phone.drainEvents()) {
    postMessage({ type: 'event', phoneGeneration: generation, event });
    network?.handle(event);
  }
  const values = phone.getStorage(),
    serialized = JSON.stringify(values);
  storage.set(appId, values);
  if (serialized !== lastStorage) {
    lastStorage = serialized;
    postMessage({ type: 'storage', appId, storage: values });
  }
}
function stop() {
  starting = false;
  externalClock = false;
  pendingLocations = [];
  generation++;
  network?.dispose();
  network = undefined;
  clearInterval(timer);
  timer = undefined;
  pendingClocks = [];
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
      starting = true;
      job = generation;
      desiredConnection = !!data.connected;
      externalClock = data.clock === 'watch';
      clockOriginUs = data.virtualUs ?? 0;
      clockEpochMs = data.nowMs ?? Date.now();
      latestClockUs = clockOriginUs;
      if (
        !Number.isSafeInteger(clockOriginUs) ||
        clockOriginUs < 0 ||
        !Number.isSafeInteger(clockEpochMs) ||
        clockEpochMs < 0
      )
        throw new Error('Invalid phone clock origin.');
      if (!module) {
        moduleLoad ??= (async () => {
          const response = await fetch(data.wasmUrl);
          if (!response.ok) throw new Error('Phone engine download failed.');
          return newQuickJSWASMModuleFromVariant(
            newVariant(RELEASE_SYNC, {
              wasmBinary: await response.arrayBuffer(),
            }),
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
      nowMs = clockEpochMs;
      phone = new VirtualPhone(module, {
        appId,
        nowMs,
        randomSeed: data.randomSeed,
        coordinates: data.coordinates,
        storage: storage.get(appId) ?? data.storage ?? {},
        messageKeys: data.messageKeys ?? {},
        watchInfo: data.watchInfo,
        appInfo: data.appInfo,
        watchToken: data.watchToken,
        accountToken: data.accountToken,
        network: data.network,
      });
      if (data.network?.mode === 'cors') {
        const owner = phone;
        network = new PhoneCorsNetwork((requestId, result) => {
          if (job !== generation || phone !== owner) return;
          try {
            const accepted = owner.deliverNetworkResponse(requestId, result);
            postMessage({
              type: 'network-result',
              phoneGeneration: generation,
              requestId,
              accepted,
              ...('error' in result
                ? { error: result.error, message: result.message }
                : {
                    status: result.status,
                    responseBytes: new TextEncoder().encode(result.body).length,
                  }),
            });
            output();
          } catch (e) {
            fail(e);
          }
        });
      }
      phone.setConnected(desiredConnection);
      phone.start(data.source, data.name);
      if (externalClock) {
        const target = latestClockUs;
        latestClockUs = clockOriginUs;
        for (const input of pendingLocations) {
          if (input.virtualUs !== undefined) advanceWatchClock(input.virtualUs);
          if (input.type === 'location') phone.setLocation(input.coordinates);
          else phone.setLocationError(input.code, input.message);
        }
        pendingLocations = [];
        advanceWatchClock(target);
      }
      output();
      acknowledgeClocks();
      starting = false;
      postMessage({
        type: 'status',
        status: 'Running',
        phoneGeneration: generation,
      });
      if (!externalClock)
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
    if (data.type === 'clock') {
      if (!externalClock) return;
      if (!Number.isFinite(data.virtualUs) || data.virtualUs < latestClockUs) return;
      advanceWatchClock(data.virtualUs);
      if (Number.isSafeInteger(data.sequence))
        pendingClocks.push({
          sequence: data.sequence,
          transportGeneration: data.transportGeneration,
        });
      output();
      acknowledgeClocks();
      return;
    }
    if (data.type === 'connection') {
      desiredConnection = !!data.connected;
      phone?.setConnected(desiredConnection);
      output();
      return;
    }
    if (!phone && data.type === 'ack') return;
    if (!phone && externalClock && starting && ['location', 'location-error'].includes(data.type)) {
      if (pendingLocations.length >= 1000)
        throw new Error('Too many location inputs during phone startup.');
      pendingLocations.push(data);
      return;
    }
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
    if (externalClock && data.virtualUs !== undefined) advanceWatchClock(data.virtualUs);
    switch (data.type) {
      case 'location':
        phone.setLocation(data.coordinates);
        break;
      case 'location-error':
        phone.setLocationError(data.code, data.message);
        break;
      case 'advance':
        if (externalClock)
          throw new Error('Phone timers follow the watch clock. Advance the watch instead.');
        if (!Number.isSafeInteger(data.milliseconds) || data.milliseconds < 0)
          throw new Error('Invalid phone clock increment.');
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
        if (data.phoneGeneration !== undefined && data.phoneGeneration !== generation) return;
        phone.closeConfiguration(data.response, data.requestId);
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
