/** Original browser/Node-independent contracts for a QuickJS PebbleKit JS companion. */
export type AppMessageValue = string | number | boolean | number[];
export type AppMessageDictionary = Record<string, AppMessageValue>;
export interface PhoneCoordinates {
  latitude: number;
  longitude: number;
  accuracy?: number;
  altitude?: number | null;
  altitudeAccuracy?: number | null;
  heading?: number | null;
  speed?: number | null;
}
export interface VirtualPhoneLimits {
  memoryBytes: number;
  stackBytes: number;
  turnMilliseconds: number;
  sourceBytes: number;
  storageBytes: number;
  eventBytes: number;
  eventCount: number;
  outputBytes: number;
  timers: number;
  timerCallbacks: number;
  pendingJobs: number;
  pendingMessages: number;
  messageTimeoutMs: number;
  pendingNetworkRequests: number;
  networkRequestBytes: number;
  networkResponseBytes: number;
  networkTimeoutMs: number;
  configurationBytes: number;
}
export interface VirtualPhoneOptions {
  appId: string;
  nowMs?: number;
  /** Explicit deterministic Math.random source for repeatable scenarios. */
  randomSeed?: number;
  coordinates?: PhoneCoordinates;
  storage?: Readonly<Record<string, string>>;
  messageKeys?: Readonly<Record<string, number>> | readonly string[];
  limits?: Partial<VirtualPhoneLimits>;
  watchInfo?: PhoneWatchInfo | null;
  /** Compatibility extension: JSON metadata supplied by the loaded app package. */
  appInfo?: Readonly<Record<string, unknown>>;
  /** Explicit simulator identity, not a real Pebble account/device credential. */
  accountToken?: string;
  watchToken?: string;
  network?: PhoneNetworkOptions;
}
export type VirtualPhoneEvent =
  | {
      type: 'log';
      level: 'log' | 'info' | 'warn' | 'error' | 'debug';
      text: string;
      timestamp: number;
    }
  | {
      type: 'outbound';
      transactionId: number;
      appId: string;
      payload: AppMessageDictionary;
      timestamp: number;
    }
  | {
      type: 'storage';
      key: string | null;
      value: string | null;
      timestamp: number;
    }
  | { type: 'configuration'; requestId: number; url: string; timestamp: number }
  | { type: 'network-request'; request: PhoneNetworkRequest; timestamp: number }
  | { type: 'network-cancel'; requestId: number; timestamp: number }
  | { type: 'error'; message: string; timestamp: number }
  | { type: 'limit'; resource: 'output'; message: string; timestamp: number };

export interface PhoneWatchInfo {
  platform: string;
  model: string;
  language: string;
  firmware: { major: number; minor: number; patch: number; suffix: string };
}
export interface PhoneNetworkRequest {
  id: number;
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | null;
  timeoutMs: number;
}
export type PhoneNetworkResult =
  | {
      status: number;
      statusText?: string;
      headers?: Record<string, string>;
      body: string;
      url?: string;
      redirected?: boolean;
    }
  | {
      error: 'network' | 'timeout' | 'abort' | 'disabled' | 'limit';
      message?: string;
    };
export interface PhoneNetworkFixture {
  url: string;
  method?: string;
  /** Omit to match any request body; null matches an absent body. */
  body?: string | null;
  response: PhoneNetworkResult;
  delayMs?: number;
}
export interface PhoneNetworkOptions {
  mode: 'disabled' | 'fixtures' | 'cors';
  fixtures?: readonly PhoneNetworkFixture[];
}
