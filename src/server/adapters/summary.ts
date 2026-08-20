import { truncateText } from '../sessions/events.js';

/**
 * Turning a tool call into one readable line.
 *
 * This text is the whole story on a lock screen: a push notification for an
 * approval shows the tool name and this summary and nothing else. Every CLI
 * names its parameters differently — `command`, `CommandLine`, `file_path`,
 * `AbsolutePath` — and the old per-adapter key lists drifted apart, so an
 * unrecognised tool fell through to `JSON.stringify` and the phone displayed a
 * raw object. Matching is therefore case- and separator-insensitive, and the
 * last resort is still readable prose rather than JSON.
 */

type Json = Record<string, unknown>;

/** `AbsolutePath`, `absolute_path` and `absolutePath` all normalise alike. */
function normaliseKey(key: string): string {
  return key.replace(/[^a-z0-9]/gi, '').toLowerCase();
}

/**
 * Ordered by how well the parameter identifies the action: what a shell tool
 * will run beats which file it touches, which beats a free-text description.
 */
const PREFERRED_KEYS = [
  'commandline',
  'command',
  'cmd',
  'script',
  'filepath',
  'absolutepath',
  'targetfile',
  'notebookpath',
  'pathtodelete',
  'path',
  'file',
  'directorypath',
  'searchdirectory',
  'nodepath',
  'pattern',
  'searchterm',
  'query',
  'url',
  'prompt',
  'instruction',
  'description',
  'message',
  'title',
];

/** Values that identify nothing on their own and only crowd out real detail. */
const UNINFORMATIVE_KEYS = new Set(['type', 'role', 'id', 'kind', 'name', 'tool', 'cwd']);

const MAX_FALLBACK_FIELDS = 3;
const MAX_FALLBACK_VALUE = 60;

export function summariseToolInput(name: string, input: unknown, max: number): string {
  if (!input || typeof input !== 'object') return name;

  const byNormalisedKey = new Map<string, unknown>();
  for (const [key, value] of Object.entries(input as Json)) {
    // First writer wins, so `command` is not shadowed by a later `Command`.
    if (!byNormalisedKey.has(normaliseKey(key))) byNormalisedKey.set(normaliseKey(key), value);
  }

  for (const key of PREFERRED_KEYS) {
    const value = byNormalisedKey.get(key);
    if (typeof value === 'string' && value.trim() !== '') return oneLine(value, max);
  }

  return oneLine(describeUnknownInput(name, input as Json), max);
}

/**
 * A tool this build has never heard of still has to read as something a human
 * can judge, because approving it is a security decision.
 */
function describeUnknownInput(name: string, input: Json): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(input)) {
    if (parts.length >= MAX_FALLBACK_FIELDS) break;
    if (UNINFORMATIVE_KEYS.has(normaliseKey(key))) continue;

    if (typeof value === 'string') {
      if (value.trim() === '') continue;
      parts.push(`${key}: ${clip(value, MAX_FALLBACK_VALUE)}`);
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      parts.push(`${key}: ${value}`);
    } else if (Array.isArray(value)) {
      parts.push(`${key}: ${value.length} item${value.length === 1 ? '' : 's'}`);
    }
    // Nested objects are skipped: they cannot be rendered in one line usefully.
  }
  return parts.length > 0 ? parts.join(', ') : name;
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

function oneLine(text: string, max: number): string {
  return truncateText(text.replace(/\s+/g, ' ').trim(), max).text;
}

export function safeStringify(value: unknown, max = 4000): string {
  try {
    const out = JSON.stringify(value);
    return out === undefined ? '' : out.slice(0, max);
  } catch {
    return '[unserialisable]';
  }
}

/** Keep tool input small enough to stream to a phone. */
export function compactInput(input: unknown, max: number): unknown {
  if (input == null || typeof input !== 'object') return input;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Json)) {
    out[key] = typeof value === 'string' ? truncateText(value, Math.min(max, 4000)).text : value;
  }
  return out;
}
