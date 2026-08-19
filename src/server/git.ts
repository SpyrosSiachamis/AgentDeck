import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Config } from './config.js';
import { buildChildEnv } from './adapters/env.js';
import type { Workspace, WorkspaceRegistry } from './workspaces.js';

const exec = promisify(execFile);

/**
 * Read-only git inspection. Every command is a fixed argv array run with
 * `cwd` set to a registry-validated workspace path — there is no shell, no
 * string interpolation, and no write operation in this module.
 */

export type GitFileChange = {
  path: string;
  /** Two-character porcelain status, e.g. " M", "??", "A ". */
  status: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
};

export type GitStatus = {
  isRepo: boolean;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  clean: boolean;
  files: GitFileChange[];
  stats: { insertions: number; deletions: number; filesChanged: number };
  detached: boolean;
  error?: string;
};

export class GitService {
  constructor(
    private readonly config: Config,
    private readonly registry: WorkspaceRegistry,
  ) {}

  private async run(ws: Workspace, args: string[], maxBuffer?: number): Promise<string> {
    const { stdout } = await exec('git', args, {
      cwd: ws.path,
      timeout: this.config.gitTimeoutMs,
      maxBuffer: maxBuffer ?? this.config.maxGitDiffBytes,
      env: buildChildEnv(process.env, {
        // Never let git prompt for credentials or open an editor from a daemon.
        inject: { GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_PAGER: 'cat' },
      }),
      windowsHide: true,
    });
    return stdout;
  }

  async status(ws: Workspace): Promise<GitStatus> {
    const empty: GitStatus = {
      isRepo: false,
      branch: null,
      upstream: null,
      ahead: 0,
      behind: 0,
      clean: true,
      files: [],
      stats: { insertions: 0, deletions: 0, filesChanged: 0 },
      detached: false,
    };
    if (!ws.isGitRepo) return empty;

    try {
      const porcelain = await this.run(ws, [
        'status',
        '--porcelain=v1',
        '--branch',
        '--untracked-files=normal',
        '--no-renames',
      ]);
      const parsed = parsePorcelain(porcelain);
      const stats = await this.diffStats(ws);
      return { ...parsed, isRepo: true, stats };
    } catch (err) {
      return { ...empty, isRepo: true, error: describeGitError(err) };
    }
  }

  private async diffStats(ws: Workspace): Promise<GitStatus['stats']> {
    try {
      const out = await this.run(ws, ['diff', 'HEAD', '--numstat']);
      let insertions = 0;
      let deletions = 0;
      let filesChanged = 0;
      for (const line of out.split('\n')) {
        const parts = line.trim().split('\t');
        if (parts.length < 3) continue;
        filesChanged += 1;
        const added = Number.parseInt(parts[0] ?? '0', 10);
        const removed = Number.parseInt(parts[1] ?? '0', 10);
        if (Number.isFinite(added)) insertions += added;
        if (Number.isFinite(removed)) deletions += removed;
      }
      return { insertions, deletions, filesChanged };
    } catch {
      return { insertions: 0, deletions: 0, filesChanged: 0 };
    }
  }

  /**
   * Diff for the whole tree or a single file. `file` is validated against the
   * workspace root before it is passed to git, and always after `--`.
   */
  async diff(ws: Workspace, file?: string): Promise<{ diff: string; truncated: boolean; error?: string }> {
    if (!ws.isGitRepo) return { diff: '', truncated: false, error: 'not a git repository' };

    let relative: string | undefined;
    if (file) {
      // Throws if the path escapes the workspace in any way.
      this.registry.resolveInside(ws, file);
      relative = file;
    }

    const base = ['diff', 'HEAD', '--no-color', '--no-ext-diff'];
    const args = relative ? [...base, '--', relative] : base;

    try {
      const [tracked, untracked] = await Promise.all([
        this.run(ws, args),
        relative ? Promise.resolve('') : this.untrackedPreview(ws),
      ]);
      const combined = tracked + untracked;
      const limit = this.config.maxGitDiffBytes;
      if (Buffer.byteLength(combined) > limit) {
        return {
          diff: combined.slice(0, limit) + '\n… [diff truncated]',
          truncated: true,
        };
      }
      return { diff: combined, truncated: false };
    } catch (err) {
      const message = describeGitError(err);
      // ENOBUFS means the diff blew past maxBuffer.
      if (/maxBuffer/i.test(message)) {
        return { diff: '', truncated: true, error: 'diff too large to display' };
      }
      return { diff: '', truncated: false, error: message };
    }
  }

  /** Untracked files are invisible to `git diff`; list them as a hint. */
  private async untrackedPreview(ws: Workspace): Promise<string> {
    try {
      const out = await this.run(ws, ['ls-files', '--others', '--exclude-standard'], 256 * 1024);
      const files = out.split('\n').filter(Boolean).slice(0, 100);
      if (files.length === 0) return '';
      return `\n--- untracked files (${files.length}) ---\n` + files.map((f) => `?? ${f}`).join('\n') + '\n';
    } catch {
      return '';
    }
  }
}

export function parsePorcelain(output: string): Omit<GitStatus, 'stats' | 'isRepo'> {
  const files: GitFileChange[] = [];
  let branch: string | null = null;
  let upstream: string | null = null;
  let ahead = 0;
  let behind = 0;
  let detached = false;

  for (const line of output.split('\n')) {
    if (!line) continue;
    if (line.startsWith('## ')) {
      const header = line.slice(3);
      if (header.startsWith('HEAD (no branch)')) {
        detached = true;
        branch = 'HEAD (detached)';
        continue;
      }
      const [branchPart, trackingPart] = header.split(/\s+\[/, 2);
      const [local, remote] = (branchPart ?? '').split('...');
      branch = local ?? null;
      upstream = remote ?? null;
      if (trackingPart) {
        const aheadMatch = /ahead (\d+)/.exec(trackingPart);
        const behindMatch = /behind (\d+)/.exec(trackingPart);
        ahead = aheadMatch?.[1] ? Number.parseInt(aheadMatch[1], 10) : 0;
        behind = behindMatch?.[1] ? Number.parseInt(behindMatch[1], 10) : 0;
      }
      continue;
    }
    const status = line.slice(0, 2);
    const filePath = line.slice(3);
    if (!filePath) continue;
    files.push({
      path: filePath,
      status,
      staged: status[0] !== ' ' && status[0] !== '?',
      unstaged: status[1] !== ' ' && status[1] !== '?',
      untracked: status === '??',
    });
  }

  return { branch, upstream, ahead, behind, clean: files.length === 0, files, detached };
}

function describeGitError(err: unknown): string {
  const e = err as { stderr?: string; message?: string; killed?: boolean };
  if (e?.killed) return 'git command timed out';
  const stderr = typeof e?.stderr === 'string' ? e.stderr.trim() : '';
  return (stderr || e?.message || 'git command failed').slice(0, 500);
}
