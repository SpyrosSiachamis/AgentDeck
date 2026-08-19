import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import { z } from 'zod';
import type { Config } from './config.js';
import type { Logger } from './logger.js';
import { AuthorizationError, authorize, identityLabel, resolveIdentity, type Identity } from './auth.js';
import { WorkspaceError, type WorkspaceRegistry } from './workspaces.js';
import type { SessionManager } from './sessions/manager.js';
import { SessionBusyError, SessionNotRunningError } from './sessions/session.js';
import { GitService } from './git.js';
import { WebSocketHub } from './ws/hub.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, '../web');

declare module 'fastify' {
  interface FastifyRequest {
    identity: Identity;
  }
}

const createSessionSchema = z.object({
  workspaceId: z.string().min(1).max(64),
  title: z.string().max(200).optional(),
  model: z.string().max(120).optional(),
});

const instructSchema = z.object({ text: z.string().min(1) });

export type AppDeps = {
  config: Config;
  log: Logger;
  workspaces: WorkspaceRegistry;
  sessions: SessionManager;
};

export async function buildServer(deps: AppDeps) {
  const { config, log, workspaces, sessions } = deps;
  const git = new GitService(config, workspaces);
  const hub = new WebSocketHub({ config, log, sessions, workspaces });

  const app = Fastify({
    loggerInstance: log,
    bodyLimit: 1024 * 1024,
    trustProxy: false, // the only proxy is tailscaled on loopback; do not trust XFF
  });

  await app.register(fastifyWebsocket, {
    options: { maxPayload: config.maxWsPayloadBytes },
  });

  // Several actions (cancel, resume, stop) carry no body. Clients routinely send
  // a JSON content-type anyway, which Fastify would reject; treat an empty body
  // as an empty object instead of failing the request.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    const raw = typeof body === 'string' ? body.trim() : '';
    if (raw === '') return done(null, {});
    try {
      done(null, JSON.parse(raw));
    } catch (err) {
      const error = err as Error & { statusCode?: number };
      error.statusCode = 400;
      done(error, undefined);
    }
  });

  // ---------------------------------------------------------------- identity
  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    req.identity = resolveIdentity(
      req.headers as Record<string, unknown>,
      req.socket.remoteAddress,
      config,
    );
    if (req.url === '/api/health') return; // health probe stays reachable on loopback
    try {
      authorize(req.identity, config);
    } catch (err) {
      if (err instanceof AuthorizationError) {
        log.warn({ url: req.url, remote: req.socket.remoteAddress }, 'request rejected by authorization');
        return reply.code(err.status).send({ error: 'forbidden', message: err.message });
      }
      throw err;
    }
  });

  // Defence in depth for a browser page: no external loads, no framing.
  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header(
      'Content-Security-Policy',
      "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
        "connect-src 'self' ws: wss:; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    );
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Frame-Options', 'DENY');
    return payload;
  });

  app.setErrorHandler((err: unknown, req, reply) => {
    const status = mapErrorStatus(err);
    const message = err instanceof Error ? err.message : 'Unexpected error';
    if (status >= 500) log.error({ err: message, url: req.url }, 'request failed');
    else log.warn({ err: message, url: req.url, status }, 'request rejected');
    // 5xx bodies stay generic so internal details never reach the browser.
    reply.code(status).send({
      error: errorCode(err),
      message: status >= 500 ? 'Internal server error' : message,
    });
  });

  // ------------------------------------------------------------------ routes

  app.get('/api/health', async () => ({
    status: 'ok',
    uptimeSec: Math.round(process.uptime()),
    sessions: { live: sessions.liveCount, total: sessions.list().length },
    workspaces: workspaces.list().length,
    adapter: config.cliAdapter,
    version: process.env.npm_package_version ?? '0.1.0',
  }));

  app.get('/api/me', async (req) => ({
    identity: {
      login: req.identity.login,
      displayName: req.identity.displayName,
      viaTailscale: req.identity.viaTailscale,
      source: req.identity.source,
    },
    limits: {
      maxConcurrentSessions: config.maxConcurrentSessions,
      maxInstructionChars: config.maxInstructionChars,
    },
  }));

  app.get('/api/workspaces', async () => ({ workspaces: workspaces.listPublic() }));

  app.get('/api/sessions', async () => ({ sessions: sessions.list() }));

  app.post('/api/sessions', async (req, reply) => {
    const body = createSessionSchema.parse(req.body);
    const session = await sessions.create({
      workspaceId: body.workspaceId,
      title: body.title,
      model: body.model ?? null,
      createdBy: identityLabel(req.identity),
    });
    hub.broadcastSessions();
    return reply.code(201).send({ session: session.summary() });
  });

  app.get('/api/sessions/:id', async (req) => {
    const { id } = req.params as { id: string };
    return { session: sessions.requireAuthorized(id).summary() };
  });

  app.get('/api/sessions/:id/events', async (req) => {
    const { id } = req.params as { id: string };
    const query = z
      .object({ since: z.coerce.number().int().min(0).default(0), limit: z.coerce.number().int().min(1).max(2000).default(500) })
      .parse(req.query);
    const session = sessions.requireAuthorized(id);
    const history = await session.historySince(query.since, query.limit);
    return { sessionId: id, lastSeq: session.lastSeq, skipped: history.skipped, events: history.events };
  });

  app.post('/api/sessions/:id/instruct', async (req) => {
    const { id } = req.params as { id: string };
    const body = instructSchema.parse(req.body);
    if (body.text.length > config.maxInstructionChars) {
      throw new AuthorizationError(`Instruction exceeds ${config.maxInstructionChars} characters`, 413);
    }
    const session = sessions.requireAuthorized(id);
    const instructionId = await session.instruct(body.text, identityLabel(req.identity));
    return { instructionId, session: session.summary() };
  });

  app.post('/api/sessions/:id/cancel', async (req) => {
    const { id } = req.params as { id: string };
    const session = sessions.requireAuthorized(id);
    await session.cancel(`cancelled by ${identityLabel(req.identity)}`);
    return { session: session.summary() };
  });

  app.post('/api/sessions/:id/resume', async (req) => {
    const { id } = req.params as { id: string };
    const session = await sessions.resume(id);
    hub.broadcastSessions();
    return { session: session.summary() };
  });

  app.delete('/api/sessions/:id', async (req) => {
    const { id } = req.params as { id: string };
    sessions.requireAuthorized(id);
    await sessions.terminate(id, `stopped by ${identityLabel(req.identity)}`);
    hub.broadcastSessions();
    return { ok: true };
  });

  app.get('/api/workspaces/:id/git/status', async (req) => {
    const { id } = req.params as { id: string };
    const workspace = workspaces.require(id);
    return { workspaceId: workspace.id, git: await git.status(workspace) };
  });

  app.get('/api/workspaces/:id/git/diff', async (req) => {
    const { id } = req.params as { id: string };
    const query = z.object({ file: z.string().max(1024).optional() }).parse(req.query);
    const workspace = workspaces.require(id);
    const result = await git.diff(workspace, query.file);
    return { workspaceId: workspace.id, file: query.file ?? null, ...result };
  });

  // --------------------------------------------------------------- websocket
  app.get('/ws', { websocket: true }, (socket, req) => {
    // The onRequest hook already authorized this handshake.
    hub.handleConnection(socket as unknown as import('ws').WebSocket, req.identity);
  });

  // ------------------------------------------------------------ static files
  await app.register(fastifyStatic, {
    root: webRoot,
    index: ['index.html'],
    maxAge: '5m',
  });

  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api') || req.url.startsWith('/ws')) {
      return reply.code(404).send({ error: 'not_found', message: 'No such endpoint' });
    }
    return reply.sendFile('index.html');
  });

  return { app, hub };
}

function errorCode(err: unknown): string {
  if (err instanceof WorkspaceError) return err.code;
  if (err instanceof AuthorizationError) return 'forbidden';
  if (err instanceof SessionBusyError || err instanceof SessionNotRunningError) return err.code;
  if (err instanceof z.ZodError) return 'invalid_request';
  const code = (err as { code?: unknown })?.code;
  return typeof code === 'string' ? code : 'error';
}

function mapErrorStatus(err: unknown): number {
  if (err instanceof AuthorizationError) return err.status;
  if (err instanceof z.ZodError) return 400;
  if (err instanceof WorkspaceError) return err.code === 'unknown_workspace' ? 404 : 403;
  if (err instanceof SessionBusyError) return 429;
  if (err instanceof SessionNotRunningError) return 409;
  const code = (err as { code?: unknown })?.code;
  if (code === 'session_not_found') return 404;
  if (code === 'session_limit') return 429;
  const statusCode = (err as { statusCode?: unknown })?.statusCode;
  if (typeof statusCode === 'number') return statusCode;
  return 500;
}
