import { pino, type Logger } from 'pino';

export type { Logger };

/**
 * Secrets must never reach the log stream: sessions carry environment and CLI
 * arguments that can contain credentials.
 */
const REDACT_PATHS = [
  'env',
  '*.env',
  'req.headers.authorization',
  'req.headers.cookie',
  'headers.authorization',
  'headers.cookie',
  'apiKey',
  '*.apiKey',
  'token',
  '*.token',
];

export function createLogger(opts: { level: string; pretty: boolean }): Logger {
  return pino({
    level: opts.level,
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    base: { app: 'terminal-agent' },
    ...(opts.pretty
      ? { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } } }
      : {}),
  });
}
