export interface MachineState {
  registers: number[];
  flags: number;
  instructions: number;
  halted: boolean;
  running: boolean;
  loaded: boolean;
  programName: string;
  inputRevision: number;
  fault: string;
  framebuffer: Uint8Array;
  buttons: number;
  battery: number;
}
export type EmulatorCommand =
  | { type: 'diagnostic' | 'run' | 'pause' | 'step' | 'reset' | 'snapshot' }
  | { type: 'init'; wasmUrl: string }
  | { type: 'inputs'; buttons: number; battery: number; inputRevision: number }
  | { type: 'image'; bytes: Uint8Array; name: string }
  | { type: 'restore'; bytes: Uint8Array; name: string; inputRevision: number }
  | { type: 'ping'; cookie: number };
export type EmulatorEvent =
  | { type: 'ready' }
  | { type: 'state'; state: MachineState }
  | { type: 'error'; message: string; fatal?: boolean }
  | { type: 'snapshot' | 'packet'; bytes: Uint8Array; name?: string };
