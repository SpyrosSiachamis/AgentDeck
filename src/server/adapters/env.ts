/**
 * The CLI child process inherits a deliberately narrow environment. The server
 * may be started from a shell loaded with API keys, cloud credentials and other
 * secrets; none of that should be reachable by a process an AI drives.
 */

/** Variables the CLI genuinely needs to run and authenticate itself. */
const ALLOW_EXACT = new Set([
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'TMPDIR',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'XDG_DATA_HOME',
  'SSL_CERT_FILE',
  'NODE_EXTRA_CA_CERTS',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
]);

/**
 * Prefixes that are forwarded so the CLI can pick up its own configuration
 * (model routing, telemetry opt-outs, cloud provider selection).
 */
const ALLOW_PREFIX = ['CLAUDE_CODE_', 'ANTHROPIC_'];

/** Never forwarded, even when a prefix rule would otherwise allow it. */
const DENY_EXACT = new Set(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_ADMIN_KEY']);

const DENY_PATTERN = /(SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE_KEY|SESSION_TOKEN)/i;

export type EnvPolicy = Readonly<{
  /**
   * Names the operator explicitly opted into forwarding (CLI_FORWARD_ENV).
   * An explicit opt-in overrides the deny lists — that is the only way an API
   * key can reach the child, and it is a documented, deliberate choice.
   */
  extraAllow?: readonly string[];
  /** Values injected explicitly by the server. */
  inject?: Readonly<Record<string, string>>;
}>;

export function buildChildEnv(
  parent: NodeJS.ProcessEnv = process.env,
  policy: EnvPolicy = {},
): Record<string, string> {
  const extra = new Set(policy.extraAllow ?? []);
  const out: Record<string, string> = {};

  for (const [key, value] of Object.entries(parent)) {
    if (value === undefined) continue;
    if (extra.has(key)) {
      out[key] = value;
      continue;
    }
    if (DENY_EXACT.has(key)) continue;
    if (DENY_PATTERN.test(key)) continue;

    const allowed = ALLOW_EXACT.has(key) || ALLOW_PREFIX.some((p) => key.startsWith(p));
    if (allowed) out[key] = value;
  }

  for (const [key, value] of Object.entries(policy.inject ?? {})) out[key] = value;
  return out;
}
