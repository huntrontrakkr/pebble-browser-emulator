import { PhoneWebSocketNetwork } from './phone-websocket.ts';
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
/**
 * Accepts a relay only when both halves are present and well formed. An
 * endpoint without its key, or a key without its endpoint, is no relay: the
 * request would be sent and refused, which reads like the host failing rather
 * than a half-finished setting.
 */
function relayOptions(value: unknown): { relay?: { endpoint: string; key: string } } {
  const relay = value as { endpoint?: unknown; key?: unknown } | null | undefined;
  const endpoint = typeof relay?.endpoint === 'string' ? relay.endpoint : '';
  const key = typeof relay?.key === 'string' ? relay.key : '';
  if (!endpoint || key.length < 16) return {};
  try {
    const url = new URL(endpoint);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) return {};
  } catch {
    return {};
  }
  return { relay: { endpoint, key } };
}
let socketNetwork: PhoneWebSocketNetwork | undefined;
let externalClock = false,
  clockOriginUs = 0,
  clockEpochMs = 0,
  latestClockUs = 0;
let pendingClocks: { sequence: number; transportGeneration: number; direct: boolean }[] = [];
let clockPort: MessagePort | undefined;
let uiTransportPending = false;
let pendingLocations: any[] = [];
let starting = false;
function acknowledgeClocks() {
  if (!phone) return;
  for (const clock of pendingClocks) {
    const ack = {
      type: 'clock-ack',
      sequence: clock.sequence,
      transportGeneration: clock.transportGeneration,
      virtualUs: latestClockUs,
      phoneGeneration: generation,
    };
    // Outbound AppMessages must reach the watch before releasing this barrier.
    // They and this acknowledgment use the same FIFO UI path when needed.
    if (clock.direct && clockPort && !uiTransportPending) clockPort.postMessage(ack);
    else postMessage(ack);
  }
  if (pendingClocks.length) uiTransportPending = false;
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
    if (event.type === 'outbound') uiTransportPending = true;
    postMessage({ type: 'event', phoneGeneration: generation, event });
    network?.handle(event);
    socketNetwork?.handle(event);
  }
  const values = phone.readStorageIfChanged();
  if (values) {
    const serialized = JSON.stringify(values);
    storage.set(appId, values);
    if (serialized !== lastStorage) {
      lastStorage = serialized;
      postMessage({ type: 'storage', appId, storage: values });
    }
  }
}
function stop() {
  clockPort?.close();
  clockPort = undefined;
  uiTransportPending = false;
  starting = false;
  externalClock = false;
  pendingLocations = [];
  generation++;
  socketNetwork?.dispose();
  socketNetwork = undefined;
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
async function handleMessage(data: any, fromClockPort = false) {
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
      if (data.clockPort && externalClock) {
        const port: MessagePort = data.clockPort;
        clockPort = port;
        port.onmessage = ({ data }) => {
          if (clockPort === port && job === generation && data.type === 'clock')
            void handleMessage(data, true);
        };
      }
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
        language: data.language ?? globalThis.navigator?.language ?? 'en-US',
        randomSeed: data.randomSeed,
        coordinates: data.coordinates,
        storage: storage.get(appId) ?? data.storage ?? {},
        messageKeys: data.messageKeys ?? {},
        watchInfo: data.watchInfo,
        appInfo: data.appInfo,
        watchToken: data.watchToken,
        accountToken: data.accountToken,
        timelineToken: data.timelineToken,
        network: data.network,
      });
      if (data.network?.mode === 'cors') {
        const owner = phone;
        socketNetwork = new PhoneWebSocketNetwork((socketId, event) => {
          if (job !== generation || phone !== owner) return;
          try {
            const accepted = owner.deliverWebSocketEvent(socketId, event);
            postMessage({
              type: 'websocket-result',
              phoneGeneration: generation,
              socketId,
              event,
              accepted,
            });
            output();
          } catch (error) {
            fail(error);
          }
        });
        // Relaying is off unless the session supplied an endpoint and its key.
        // Without one a host the browser refuses simply fails, which is the
        // no-service contract the static build is held to.
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
        }, relayOptions(data.network?.relay));
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
          direct: fromClockPort,
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
}
self.onmessage = ({ data }) => handleMessage(data);
