import { makeClaudeCodeFactory } from './claude-code.js';
import type { CLIAdapterFactory } from './types.js';

/**
 * Adapter lookup. Adding a second CLI/model provider means writing one module
 * that implements `CLIAdapter` and registering its factory here — nothing else
 * in the application changes.
 */
const builders: Record<string, (command: string) => CLIAdapterFactory> = {
  'claude-code': makeClaudeCodeFactory,
};

export function createAdapterFactory(adapterId: string, command: string): CLIAdapterFactory {
  const build = builders[adapterId];
  if (!build) {
    throw new Error(
      `Unknown CLI adapter "${adapterId}". Available adapters: ${Object.keys(builders).join(', ')}`,
    );
  }
  return build(command);
}

export function listAdapters(): string[] {
  return Object.keys(builders);
}
