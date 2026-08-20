import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import type { Logger } from './logger.js';

/**
 * The workspace registry is the only place where a filesystem path may enter the
 * system. Clients address workspaces exclusively by id; a path coming from the
 * browser is never resolved, joined, or handed to a child process.
 */

const WORKSPACE_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

const workspaceSchema = z.object({
  id: z.string().regex(WORKSPACE_ID, 'workspace id must be lowercase [a-z0-9_-], max 64 chars'),
  name: z.string().min(1).max(120),
  path: z.string().min(1),
  enabled: z.boolean().default(true),
  /** Optional per-workspace overrides for the CLI adapter. */
  adapterId: z.string().max(64).optional(),
  model: z.string().max(120).optional(),
  models: z.record(z.string(), z.string().max(120)).optional(),
  permissionMode: z
    .enum(['default', 'acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan'])
    .optional(),
  permissionModes: z.record(z.string(), z.string().max(64)).optional(),
});

const registryFileSchema = z.object({
  workspaces: z.array(workspaceSchema).max(64),
});

export type WorkspaceConfig = z.infer<typeof workspaceSchema>;

export type Workspace = Readonly<{
  id: string;
  name: string;
  /** Fully resolved, symlink-free absolute path. Server-side only. */
  path: string;
  enabled: boolean;
  adapterId?: string;
  model?: string;
  models?: Record<string, string>;
  permissionMode?: string;
  permissionModes?: Record<string, string>;
  /** Whether the resolved path is a git repository. */
  isGitRepo: boolean;
}>;

/** The shape sent to the browser. It deliberately omits the filesystem path. */
export type PublicWorkspace = Readonly<{
  id: string;
  name: string;
  enabled: boolean;
  isGitRepo: boolean;
}>;

export function toPublicWorkspace(ws: Workspace): PublicWorkspace {
  return { id: ws.id, name: ws.name, enabled: ws.enabled, isGitRepo: ws.isGitRepo };
}

export class WorkspaceError extends Error {
  constructor(
    message: string,
    readonly code: 'unknown_workspace' | 'workspace_disabled' | 'invalid_registry',
  ) {
    super(message);
    this.name = 'WorkspaceError';
  }
}

/** Paths that must never be handed to an AI CLI as a working directory. */
function forbiddenRoots(): string[] {
  const home = os.homedir();
  return [
    path.parse(home).root,
    home,
    path.join(home, '.ssh'),
    path.join(home, '.aws'),
    path.join(home, '.gnupg'),
    path.join(home, '.config'),
    path.join(home, '.claude'),
    path.join(home, '.gemini'),
    path.join(home, '.antigravity'),
    path.join(home, '.agy'),
    path.join(home, 'Library'),
    '/etc',
    '/var',
    '/usr',
    '/bin',
    '/sbin',
    '/System',
    '/private/etc',
  ];
}

function expandHome(p: string): string {
  return p.startsWith('~/') || p === '~' ? path.join(os.homedir(), p.slice(1)) : p;
}

export class WorkspaceRegistry {
  private readonly byId = new Map<string, Workspace>();

  private constructor(workspaces: Workspace[]) {
    for (const ws of workspaces) this.byId.set(ws.id, ws);
  }

  static async load(file: string, log: Logger): Promise<WorkspaceRegistry> {
    let raw: string;
    try {
      raw = await fsp.readFile(file, 'utf8');
    } catch (err) {
      throw new WorkspaceError(
        `Cannot read workspace registry at "${file}": ${(err as Error).message}. ` +
          `Run "npm run setup" or copy workspaces.example.json to workspaces.json to register your repositories.`,
        'invalid_registry',
      );
    }

    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch (err) {
      throw new WorkspaceError(`Workspace registry is not valid JSON: ${(err as Error).message}`, 'invalid_registry');
    }

    const parsed = registryFileSchema.safeParse(json);
    if (!parsed.success) {
      throw new WorkspaceError(`Workspace registry is invalid: ${parsed.error.message}`, 'invalid_registry');
    }

    const seen = new Set<string>();
    const workspaces: Workspace[] = [];

    for (const entry of parsed.data.workspaces) {
      if (seen.has(entry.id)) {
        throw new WorkspaceError(`Duplicate workspace id "${entry.id}" in registry`, 'invalid_registry');
      }
      seen.add(entry.id);

      const expanded = expandHome(entry.path);
      if (!path.isAbsolute(expanded)) {
        throw new WorkspaceError(
          `Workspace "${entry.id}" must use an absolute path (got "${entry.path}")`,
          'invalid_registry',
        );
      }

      // realpath collapses "..", symlinks and case differences so the stored path
      // is the one the OS will actually use.
      let resolved: string;
      try {
        resolved = await fsp.realpath(expanded);
      } catch (err) {
        log.warn(
          { workspaceId: entry.id, err: (err as Error).message },
          'workspace path does not exist; entry disabled',
        );
        workspaces.push({ ...entry, path: path.resolve(expanded), enabled: false, isGitRepo: false });
        continue;
      }

      const stat = await fsp.stat(resolved);
      if (!stat.isDirectory()) {
        throw new WorkspaceError(`Workspace "${entry.id}" path is not a directory: ${resolved}`, 'invalid_registry');
      }

      const forbidden = forbiddenRoots().find((root) => path.resolve(root) === resolved);
      if (forbidden) {
        throw new WorkspaceError(
          `Workspace "${entry.id}" points at a protected directory (${resolved}). ` +
            `Register a specific project directory instead.`,
          'invalid_registry',
        );
      }

      const isGitRepo = fs.existsSync(path.join(resolved, '.git'));
      workspaces.push({ ...entry, path: resolved, isGitRepo });
      log.info({ workspaceId: entry.id, enabled: entry.enabled, isGitRepo }, 'workspace registered');
    }

    if (workspaces.length === 0) {
      log.warn({ file }, 'workspace registry is empty; no sessions can be started');
    }
    return new WorkspaceRegistry(workspaces);
  }

  /** Test helper: build a registry from already-resolved entries. */
  static fromResolved(workspaces: Workspace[]): WorkspaceRegistry {
    return new WorkspaceRegistry(workspaces);
  }

  list(): Workspace[] {
    return [...this.byId.values()];
  }

  listPublic(): PublicWorkspace[] {
    return this.list().map(toPublicWorkspace);
  }

  /** Look up without asserting availability. */
  find(id: unknown): Workspace | undefined {
    if (typeof id !== 'string' || !WORKSPACE_ID.test(id)) return undefined;
    return this.byId.get(id);
  }

  /**
   * Resolve a client-supplied workspace id. Throws for anything that is not an
   * enabled, registered workspace — including ids that look like paths.
   */
  require(id: unknown): Workspace {
    const ws = this.find(id);
    if (!ws) {
      throw new WorkspaceError(`Unknown workspace: ${typeof id === 'string' ? id.slice(0, 64) : typeof id}`, 'unknown_workspace');
    }
    if (!ws.enabled) {
      throw new WorkspaceError(`Workspace "${ws.id}" is disabled`, 'workspace_disabled');
    }
    return ws;
  }

  /**
   * Resolve a repository-relative path inside a workspace (used for git diffs).
   * Rejects absolute paths, traversal, and anything that escapes via symlink.
   */
  resolveInside(ws: Workspace, relative: string): string {
    if (typeof relative !== 'string' || relative.length === 0 || relative.length > 1024) {
      throw new WorkspaceError('Invalid path', 'unknown_workspace');
    }
    if (relative.includes('\0')) {
      throw new WorkspaceError('Invalid path', 'unknown_workspace');
    }
    if (path.isAbsolute(relative) || relative.startsWith('~')) {
      throw new WorkspaceError('Path must be relative to the workspace', 'unknown_workspace');
    }
    const resolved = path.resolve(ws.path, relative);
    const prefix = ws.path.endsWith(path.sep) ? ws.path : ws.path + path.sep;
    if (resolved !== ws.path && !resolved.startsWith(prefix)) {
      throw new WorkspaceError('Path escapes the workspace', 'unknown_workspace');
    }
    // Follow symlinks when the target exists; a link pointing outside is rejected.
    try {
      const real = fs.realpathSync(resolved);
      if (real !== ws.path && !real.startsWith(prefix)) {
        throw new WorkspaceError('Path escapes the workspace', 'unknown_workspace');
      }
      return real;
    } catch (err) {
      if (err instanceof WorkspaceError) throw err;
      return resolved; // deleted file: the containment check above already passed
    }
  }
}
