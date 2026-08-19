import { buildServer } from './server.js';
import { runMigrations } from './db/migrate.js';
import { env } from './lib/env.js';

/**
 * Entry point. A plain, conventional Fastify server: build the app, listen on the
 * port the platform gives us, shut down cleanly on a signal.
 *
 * There is deliberately no process clustering here. A managed host's framework
 * preset owns how the app is started, so anything unusual in this file forces you
 * off the preset and into hand-written deploy config. Scaling is handled outside
 * the process instead — run more replicas behind the load balancer
 * (see docker-compose.yml and infra/nginx/nginx.conf).
 *
 * That works because the API is stateless: JWT auth, no in-process session or
 * cache that has to stay coherent, and the venue capacity ceiling is enforced
 * inside Postgres. Any request can land on any instance.
 */
async function main(): Promise<void> {
  const app = await buildServer();

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'shutting down');
    try {
      // Lets in-flight gate scans finish before the socket closes.
      await app.close();
      process.exit(0);
    } catch (error) {
      app.log.error({ err: error }, 'error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  // Apply pending migrations before accepting a single request. A half-migrated
  // database must never serve traffic: failing to start is loud and visible in
  // the platform's logs, whereas serving wrong data is neither.
  try {
    const applied = await runMigrations(app.log);
    app.log.info({ applied: applied.length }, 'database migrations up to date');
  } catch (error) {
    app.log.error({ err: error }, 'migrations failed — refusing to serve');
    process.exit(1);
  }

  try {
    await app.listen({ host: env.HOST, port: env.PORT });
    app.log.info(
      { url: `http://${env.HOST}:${env.PORT}`, env: env.NODE_ENV },
      'foodiana backend listening',
    );
  } catch (error) {
    app.log.error({ err: error }, 'failed to start');
    process.exit(1);
  }
}

void main();
