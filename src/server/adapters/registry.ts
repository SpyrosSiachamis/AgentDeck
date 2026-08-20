import fs from 'node:fs';
import path from 'node:path';
import { makeClaudeCodeFactory } from './claude-code.js';
import { makeAntigravityFactory } from './antigravity.js';
import type { AdapterDescriptor, CLIAdapterFactory } from './types.js';

/**
 * Adapter lookup. Adding another CLI/model provider means writing one module
 * that implements `CLIAdapter` and adding a row to `DEFINITIONS` — nothing else
 * in the application changes.
 */

export class AdapterError extends Error {
  constructor(
    message: string,
    readonly code: 'unknown_adapter' | 'adapter_disabled' | 'adapter_unavailable',
  ) {
    super(message);
    this.name = 'AdapterError';
  }
}

type AdapterDefinition = {
  id: string;
  displayName: string;
  defaultCommand: string;
  persistentProcess: boolean;
  supportsPermissionPrompts: boolean;
  note: string;
  build: (command: string) => CLIAdapterFactory;
};

const DEFINITIONS: readonly AdapterDefinition[] = [
  {
    id: 'claude-code',
    displayName: 'Claude Code',
    defaultCommand: 'claude',
    persistentProcess: true,
    supportsPermissionPrompts: true,
    note: 'One long-lived process per session. Asks before running a risky command, and cancelling interrupts the turn without ending the session.',
    build: makeClaudeCodeFactory,
  },
  {
    id: 'antigravity-cli',
    displayName: 'Antigravity CLI',
    defaultCommand: 'agy',
    persistentProcess: true,
    // The CLI has no approval channel of its own; DevTunnel brokers shell
    // commands on its behalf, which covers command execution but not file edits.
    supportsPermissionPrompts: true,
    note: 'One long-lived process per session. Asks before running a shell command; its file edits are not gated.',
    build: makeAntigravityFactory,
  },
];

/** Resolve a command the way execvp would, so availability reflects reality. */
export function isExecutableOnPath(command: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (command.includes(path.sep)) {
    try {
      fs.accessSync(command, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
  const dirs = (env['PATH'] ?? '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    try {
      fs.accessSync(path.join(dir, command), fs.constants.X_OK);
      return true;
    } catch {
      /* keep looking */
    }
  }
  return false;
}

export type AdapterRegistryConfig = Readonly<{
  /** Adapter ids the operator has enabled. */
  enabled: readonly string[];
  defaultAdapter: string;
  /** Per-adapter command override, keyed by adapter id. */
  commands: Readonly<Record<string, string>>;
  /** Per-adapter model override, keyed by adapter id. */
  models: Readonly<Record<string, string>>;
}>;

export class AdapterRegistry {
  private readonly definitions = new Map<string, AdapterDefinition>();
  private readonly factories = new Map<string, CLIAdapterFactory>();

  private constructor(
    private readonly config: AdapterRegistryConfig,
    definitions: AdapterDefinition[],
  ) {
    for (const definition of definitions) {
      this.definitions.set(definition.id, definition);
      this.factories.set(definition.id, definition.build(this.commandFor(definition)));
    }
  }

  static create(config: AdapterRegistryConfig): AdapterRegistry {
    const unknown = config.enabled.filter((id) => !DEFINITIONS.some((d) => d.id === id));
    if (unknown.length > 0) {
      throw new AdapterError(
        `Unknown CLI adapter(s): ${unknown.join(', ')}. Available: ${DEFINITIONS.map((d) => d.id).join(', ')}`,
        'unknown_adapter',
      );
    }
    const enabled = DEFINITIONS.filter((d) => config.enabled.includes(d.id));
    if (enabled.length === 0) {
      throw new AdapterError('No CLI adapters are enabled. Set CLI_ADAPTERS.', 'adapter_disabled');
    }
    return new AdapterRegistry(config, [...enabled]);
  }

  private commandFor(definition: AdapterDefinition): string {
    return this.config.commands[definition.id] || definition.defaultCommand;
  }

  modelFor(id: string): string | null {
    return this.config.models[id] || null;
  }

  /** Descriptors for every enabled adapter, including unavailable ones. */
  list(): AdapterDescriptor[] {
    return [...this.definitions.values()].map((definition) => {
      const command = this.commandFor(definition);
      return Object.freeze({
        id: definition.id,
        displayName: definition.displayName,
        command,
        model: this.modelFor(definition.id),
        available: isExecutableOnPath(command),
        persistentProcess: definition.persistentProcess,
        supportsPermissionPrompts: definition.supportsPermissionPrompts,
        note: definition.note,
      });
    });
  }

  has(id: unknown): boolean {
    return typeof id === 'string' && this.definitions.has(id);
  }

  /** The adapter used when a request does not name one. */
  defaultId(): string {
    if (this.definitions.has(this.config.defaultAdapter)) return this.config.defaultAdapter;
    const firstAvailable = this.list().find((a) => a.available);
    return firstAvailable?.id ?? [...this.definitions.keys()][0]!;
  }

  /**
   * Resolve a client-supplied adapter id. Throws unless it is enabled and its
   * binary is actually installed.
   */
  require(id: unknown): CLIAdapterFactory {
    if (typeof id !== 'string' || !this.definitions.has(id)) {
      throw new AdapterError(
        `Unknown agent: ${typeof id === 'string' ? id.slice(0, 40) : typeof id}`,
        'unknown_adapter',
      );
    }
    const definition = this.definitions.get(id)!;
    const command = this.commandFor(definition);
    if (!isExecutableOnPath(command)) {
      throw new AdapterError(
        `${definition.displayName} is not installed: "${command}" was not found on PATH.`,
        'adapter_unavailable',
      );
    }
    return this.factories.get(id)!;
  }

  /** Used when restoring a persisted session, where the binary may have moved. */
  factory(id: string): CLIAdapterFactory | undefined {
    return this.factories.get(id);
  }

  displayName(id: string): string {
    return this.definitions.get(id)?.displayName ?? id;
  }
}

export function listAdapterIds(): string[] {
  return DEFINITIONS.map((d) => d.id);
}
