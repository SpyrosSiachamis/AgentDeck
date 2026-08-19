import net from 'node:net';
import type { Config } from './config.js';
import { isLoopbackHost } from './config.js';

/**
 * Authorization model
 * -------------------
 * Tailscale is the network boundary: the app binds to loopback and is published
 * with `tailscale serve`, so the only way in is through the tailnet.
 *
 * `tailscale serve` injects identity headers for the authenticated tailnet user.
 * Those headers are trustworthy only because nothing but the local proxy can
 * reach the socket — a client that could connect directly could also set them.
 * That is why this module refuses to trust the headers unless the peer address
 * is loopback, and why the server refuses to bind elsewhere by default.
 */

export type Identity = Readonly<{
  login: string | null;
  displayName: string | null;
  profilePicUrl: string | null;
  /** True when the identity came from the Tailscale proxy rather than a guess. */
  viaTailscale: boolean;
  source: 'tailscale' | 'loopback' | 'unknown';
}>;

export class AuthorizationError extends Error {
  constructor(
    message: string,
    readonly status = 403,
  ) {
    super(message);
    this.name = 'AuthorizationError';
  }
}

const TAILSCALE_LOGIN_HEADER = 'tailscale-user-login';
const TAILSCALE_NAME_HEADER = 'tailscale-user-name';
const TAILSCALE_PIC_HEADER = 'tailscale-user-profile-pic';

export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const addr = address.startsWith('::ffff:') ? address.slice(7) : address;
  if (addr === '::1' || addr === 'localhost') return true;
  if (net.isIPv4(addr)) return addr.startsWith('127.');
  return false;
}

function headerValue(headers: Record<string, unknown>, name: string): string | null {
  const raw = headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  // Guard against header smuggling and absurd values.
  if (!trimmed || trimmed.length > 320 || /[\r\n]/.test(trimmed)) return null;
  return trimmed;
}

export function resolveIdentity(
  headers: Record<string, unknown>,
  remoteAddress: string | undefined,
  config: Config,
): Identity {
  const peerIsLoopback = isLoopbackAddress(remoteAddress);
  const trustHeaders = peerIsLoopback && isLoopbackHost(config.host);

  const login = trustHeaders ? headerValue(headers, TAILSCALE_LOGIN_HEADER) : null;
  if (login) {
    return Object.freeze({
      login: login.toLowerCase(),
      displayName: headerValue(headers, TAILSCALE_NAME_HEADER),
      profilePicUrl: headerValue(headers, TAILSCALE_PIC_HEADER),
      viaTailscale: true,
      source: 'tailscale' as const,
    });
  }

  return Object.freeze({
    login: null,
    displayName: peerIsLoopback ? 'local user' : null,
    profilePicUrl: null,
    viaTailscale: false,
    source: peerIsLoopback ? ('loopback' as const) : ('unknown' as const),
  });
}

/** Throws when the caller is not permitted to use the application. */
export function authorize(identity: Identity, config: Config): void {
  if (config.requireTailscaleIdentity && !identity.viaTailscale) {
    throw new AuthorizationError(
      'This server requires a Tailscale identity. Reach it through the Tailscale Serve URL, not directly.',
    );
  }
  if (config.allowedTailscaleUsers.length > 0) {
    if (!identity.login || !config.allowedTailscaleUsers.includes(identity.login)) {
      throw new AuthorizationError('Your tailnet identity is not on the allow list for this server.');
    }
  }
}

export function identityLabel(identity: Identity): string {
  return identity.login ?? identity.displayName ?? 'anonymous-loopback';
}
