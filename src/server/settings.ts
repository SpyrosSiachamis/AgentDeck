import fsp from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { Config } from './config.js';
import type { Logger } from './logger.js';

/**
 * Preferences a person can change from the app, as opposed to the ones an
 * operator sets in the environment.
 *
 * These live on the server rather than in the browser because they change what
 * the server does — which model a session starts with, whether a finished turn
 * is worth a push — and because a phone and a laptop should not disagree about
 * them. Purely presentational choices (the theme) stay in the browser.
 *
 * Every field is optional and falls back to the environment, so deleting this
 * file returns the deployment to exactly its configured behaviour.
 */

/** Model ids are passed to a CLI as one argv element; keep them boring. */
const MODEL_ID = /^[A-Za-z0-9._:@/-]{1,120}$/;

const settingsSchema = z.object({
  /** adapterId -> model id. An absent or empty entry means "use the default". */
  models: z.record(z.string().max(64), z.string().max(120)).default({}),
  notifications: z
    .object({
      /** Push when a turn ends. Approvals always notify and are not optional. */
      turnFinished: z.boolean().optional(),
    })
    .default({}),
});

export type AppSettings = z.infer<typeof settingsSchema>;

/** What the client is allowed to send. Same shape, but every part optional. */
export const settingsPatchSchema = z
  .object({
    models: z.record(z.string().min(1).max(64), z.string().max(120)).optional(),
    notifications: z.object({ turnFinished: z.boolean() }).partial().optional(),
  })
  .strict();

export type SettingsPatch = z.infer<typeof settingsPatchSchema>;

export class SettingsError extends Error {
  readonly code = 'invalid_settings';
}

const EMPTY: AppSettings = { models: {}, notifications: {} };

export class SettingsStore {
  private settings: AppSettings = EMPTY;
  private writeChain: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<(settings: AppSettings) => void>();

  constructor(
    private readonly config: Config,
    private readonly log: Logger,
  ) {}

  private file(): string {
    return path.join(this.config.stateDir, 'settings.json');
  }

  async init(): Promise<void> {
    try {
      const raw = await fsp.readFile(this.file(), 'utf8');
      this.settings = settingsSchema.parse(JSON.parse(raw));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        // A corrupt file must not stop the server; the environment still works.
        this.log.warn({ err: (err as Error).message }, 'could not read settings; using defaults');
      }
      this.settings = EMPTY;
    }
  }

  get(): AppSettings {
    return this.settings;
  }

  onChange(listener: (settings: AppSettings) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * The model a new session should use for this agent, or null to let the
   * agent pick. Workspace-level configuration is more specific and still wins;
   * this replaces the environment default.
   */
  modelFor(adapterId: string): string | null {
    const chosen = this.settings.models[adapterId];
    return chosen && chosen.trim() !== '' ? chosen : null;
  }

  notifyTurnFinished(): boolean {
    return this.settings.notifications.turnFinished ?? this.config.push.notifyTurnFinished;
  }

  async update(patch: SettingsPatch): Promise<AppSettings> {
    const next: AppSettings = {
      models: { ...this.settings.models },
      notifications: { ...this.settings.notifications },
    };

    for (const [adapterId, model] of Object.entries(patch.models ?? {})) {
      const trimmed = model.trim();
      if (trimmed === '') {
        // Clearing a field is how the user says "go back to the default".
        delete next.models[adapterId];
        continue;
      }
      if (!MODEL_ID.test(trimmed)) {
        throw new SettingsError(`"${trimmed.slice(0, 40)}" is not a valid model id`);
      }
      next.models[adapterId] = trimmed;
    }

    if (patch.notifications?.turnFinished !== undefined) {
      next.notifications.turnFinished = patch.notifications.turnFinished;
    }

    this.settings = settingsSchema.parse(next);
    await this.persist();
    for (const listener of this.listeners) {
      try {
        listener(this.settings);
      } catch (err) {
        this.log.warn({ err: (err as Error).message }, 'settings listener failed');
      }
    }
    return this.settings;
  }

  private persist(): Promise<void> {
    this.writeChain = this.writeChain.then(async () => {
      // The state directory may not exist yet: settings load before the session
      // store has had a chance to create it.
      await fsp.mkdir(this.config.stateDir, { recursive: true, mode: 0o700 });
      const tmp = `${this.file()}.tmp`;
      await fsp.writeFile(tmp, JSON.stringify(this.settings, null, 2), { mode: 0o600 });
      await fsp.rename(tmp, this.file());
    });
    return this.writeChain;
  }
}
