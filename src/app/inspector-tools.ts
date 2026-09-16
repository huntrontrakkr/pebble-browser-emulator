import type { MachineState } from './emulator.types';
export interface InspectorRegistry {
  registerTool(
    tool: {
      name: string;
      title: string;
      description: string;
      inputSchema: object;
      annotations: { readOnlyHint: boolean; untrustedContentHint: boolean };
      execute(input: unknown): unknown;
    },
    options: { signal: AbortSignal },
  ): void | Promise<void>;
}
export function registerInspector(
  registry: InspectorRegistry | undefined,
  read: () => MachineState | null,
): () => void {
  if (!registry) return () => {};
  const lifecycle = new AbortController();
  try {
    void Promise.resolve(
      registry.registerTool(
        {
          name: 'read_emulator_state',
          title: 'Read emulator state',
          description:
            'Read the currently displayed diagnostic machine registers and execution status. This does not run the machine or imply PebbleOS compatibility.',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
          annotations: { readOnlyHint: true, untrustedContentHint: true },
          execute(input: unknown) {
            if (
              !input ||
              typeof input !== 'object' ||
              Array.isArray(input) ||
              Object.keys(input).length
            )
              throw new Error('Expected an empty object.');
            const state = read();
            if (!state) throw new Error('Emulator is not ready.');
            const { framebuffer, ...details } = state;
            return { profile: 'diagnostic-v1', ...details };
          },
        },
        { signal: lifecycle.signal },
      ),
    ).catch(() => {});
  } catch {
    /* Optional proposed API must not break the workbench. */
  }
  return () => lifecycle.abort();
}
