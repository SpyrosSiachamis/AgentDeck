import { loadConfig, isLoopbackHost } from './config.js';
import { createLogger } from './logger.js';
import { WorkspaceRegistry } from './workspaces.js';
import { SessionManager } from './sessions/manager.js';
import { SessionStore } from './sessions/store.js';
import { buildServer } from './http.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const log = createLogger({ level: config.logLevel, pretty: config.logPretty });

  const workspaces = await WorkspaceRegistry.load(config.workspacesFile, log);
  const store = new SessionStore(config.stateDir, log);
  const sessions = new SessionManager(config, log, workspaces, store);
  await sessions.init();

  const { app, hub } = await buildServer({ config, log, workspaces, sessions });

  await app.listen({ host: config.host, port: config.port });

  log.info(
    {
      host: config.host,
      port: config.port,
      adapter: config.cliAdapter,
      workspaces: workspaces.list().length,
      requireTailscaleIdentity: config.requireTailscaleIdentity,
    },
    'terminal-agent listening',
  );
  if (!isLoopbackHost(config.host)) {
    log.warn(
      'Server is NOT bound to loopback. Tailscale identity headers are spoofable in this configuration.',
    );
  } else {
    log.info(
      `Publish to your tailnet with: tailscale serve --bg ${config.port}  (then open the https://<host>.<tailnet>.ts.net URL)`,
    );
  }

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, 'shutting down');

    const force = setTimeout(() => {
      log.error('graceful shutdown timed out; forcing exit');
      process.exit(1);
    }, config.shutdownGraceMs + 5_000);
    force.unref?.();

    try {
      await hub.shutdown();
      await app.close();
      await sessions.shutdown();
      log.info('shutdown complete');
      process.exit(0);
    } catch (err) {
      log.error({ err: (err as Error).message }, 'error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => {
    log.error({ reason: String(reason) }, 'unhandled rejection');
  });
  process.on('uncaughtException', (err) => {
    log.fatal({ err: err.message, stack: err.stack }, 'uncaught exception');
    void shutdown('uncaughtException');
  });
}

main().catch((err: Error) => {
  // Config/registry failures happen before the logger exists in some paths.
  process.stderr.write(`terminal-agent failed to start: ${err.message}\n`);
  process.exit(1);
});
