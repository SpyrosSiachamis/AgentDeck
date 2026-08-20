import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { buildChildEnv } from './env.js';
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
  /**
   * Whether `<command> models` prints a usable list. Only some CLIs do, and
   * the settings page offers a picker only for those.
   */
  listsModels: boolean;
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
    listsModels: false,
    note: 'One long-lived process per session. Asks before running a risky command, and cancelling interrupts the turn without ending the session.',
    build: makeClaudeCodeFactory,
  },
  {
    id: 'antigravity-cli',
    displayName: 'Antigravity CLI',
    defaultCommand: 'agy',
    persistentProcess: true,
    // The CLI has no approval channel of its own; AgentDeck brokers shell
    // commands on its behalf, which covers command execution but not file edits.
    supportsPermissionPrompts: true,
    listsModels: true,
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
        listsModels: definition.listsModels,
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

  /**
   * Ask a CLI which models it offers, for the settings picker. The result is
   * cached: the call is a network round trip on at least one agent, and a
   * settings page should not wait seconds every time it opens.
   */
  async listModels(id: string): Promise<{ id: string; label: string }[]> {
    const definition = this.definitions.get(id);
    if (!definition?.listsModels) {
      throw new AdapterError(`${definition?.displayName ?? id} cannot list its models`, 'unknown_adapter');
    }
    const cached = this.modelCache.get(id);
    if (cached && Date.now() - cached.at < MODEL_CACHE_MS) return cached.models;

    const command = this.commandFor(definition);
    if (!isExecutableOnPath(command)) {
      throw new AdapterError(`"${command}" was not found on PATH.`, 'adapter_unavailable');
    }

    const models = parseModelList(await runModelList(command));
    this.modelCache.set(id, { at: Date.now(), models });
    return models;
  }

  private readonly modelCache = new Map<string, { at: number; models: { id: string; label: string }[] }>();
}

const MODEL_CACHE_MS = 10 * 60 * 1000;
const MODEL_LIST_TIMEOUT_MS = 20_000;
const MODEL_LIST_MAX_BYTES = 1024 * 1024;

/**
 * Run `<command> models` and return its stdout.
 *
 * stdin is closed rather than left as an open pipe: these CLIs also read
 * instructions from stdin, and at least one of them blocks forever on a pipe
 * that never reaches EOF instead of printing its model list.
 */
function runModelList(command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, ['models'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: buildChildEnv(process.env),
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (err: Error | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(stdout);
    };

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new AdapterError(`"${command} models" timed out.`, 'adapter_unavailable'));
    }, MODEL_LIST_TIMEOUT_MS);
    timer.unref?.();

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      if (stdout.length > MODEL_LIST_MAX_BYTES) {
        child.kill('SIGKILL');
        finish(new AdapterError(`"${command} models" produced too much output.`, 'adapter_unavailable'));
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk.slice(0, 4000);
    });

    child.on('error', (err) => finish(new AdapterError(`Could not run "${command} models": ${err.message}`, 'adapter_unavailable')));
    child.on('close', (code) => {
      if (code === 0) return finish(null);
      // The CLI's own words are far more useful than "exited 1".
      const detail = stderr.trim().split('\n').at(-1) ?? `exit code ${code}`;
      finish(new AdapterError(`"${command} models" failed: ${detail}`, 'adapter_unavailable'));
    });
  });
}

/** Lines are "<id>\t<human label>"; anything else is chatter like a spinner. */
export function parseModelList(stdout: string): { id: string; label: string }[] {
  const models: { id: string; label: string }[] = [];
  const seen = new Set<string>();
  for (const line of stdout.split('\n')) {
    const [rawId, ...rest] = line.split('\t');
    const id = rawId?.trim() ?? '';
    if (!id || rest.length === 0) continue;
    if (!/^[A-Za-z0-9._:@/-]{1,120}$/.test(id) || seen.has(id)) continue;
    seen.add(id);
    models.push({ id, label: rest.join(' ').trim() || id });
  }
  return models;
}

export function listAdapterIds(): string[] {
  return DEFINITIONS.map((d) => d.id);
}
