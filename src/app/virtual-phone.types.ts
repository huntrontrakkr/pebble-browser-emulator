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
}
export interface VirtualPhoneOptions {
  appId: string;
  nowMs?: number;
  coordinates?: PhoneCoordinates;
  storage?: Readonly<Record<string, string>>;
  messageKeys?: Readonly<Record<string, number>> | readonly string[];
  limits?: Partial<VirtualPhoneLimits>;
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
  | { type: 'storage'; key: string | null; value: string | null; timestamp: number }
  | { type: 'configuration'; url: string; timestamp: number }
  | { type: 'error'; message: string; timestamp: number }
  | { type: 'limit'; resource: 'output'; message: string; timestamp: number };
