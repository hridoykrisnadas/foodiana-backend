import cluster from 'node:cluster';
import { availableParallelism } from 'node:os';
import { buildServer } from './server.js';
import { env } from './lib/env.js';

/**
 * The one and only entry point for the API.
 *
 * `CLUSTER_WORKERS` decides the process shape at runtime rather than by pointing
 * at a different file:
 *
 *   1  -> a single process, no forking. Correct on managed platforms such as
 *         Hostinger, and anywhere an orchestrator already scales by replica.
 *   0  -> one worker per CPU core. Correct on a VPS or one large container.
 *   N  -> exactly N workers.
 *
 * Why this is a single file: a managed host with a framework preset starts the
 * app its own way — `npm start`, or the package `main` — and rejects a custom
 * entry file. Hostinger's Fastify preset does exactly that. So there must be one
 * path in, and clustering has to be a runtime decision.
 *
 * Workers share the listening socket. The API is stateless (JWT auth, no
 * in-process session or cache that must stay coherent), so a request can land on
 * any worker or replica. The one caveat is the rate-limit counter, which is per
 * process — see the note in server.ts.
 */

async function startServer(): Promise<void> {
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

  try {
    await app.listen({ host: env.HOST, port: env.PORT });
    app.log.info(
      {
        url: `http://${env.HOST}:${env.PORT}`,
        env: env.NODE_ENV,
        worker: cluster.isWorker ? cluster.worker?.id : null,
      },
      'foodiana backend listening',
    );
  } catch (error) {
    app.log.error({ err: error }, 'failed to start');
    process.exit(1);
  }
}

/** Fork and supervise the worker pool, replacing any worker that dies. */
function startPrimary(workers: number): void {
  console.log(`[cluster] primary ${process.pid} starting ${workers} workers`);

  for (let i = 0; i < workers; i += 1) cluster.fork();

  let shuttingDown = false;

  cluster.on('exit', (worker, code, signal) => {
    if (shuttingDown) return;
    console.error(
      `[cluster] worker ${worker.process.pid} died (code=${code} signal=${signal}); replacing`,
    );
    cluster.fork();
  });

  const shutdown = (signal: NodeJS.Signals) => {
    shuttingDown = true;
    console.log(`[cluster] ${signal} received, stopping workers`);
    for (const worker of Object.values(cluster.workers ?? {})) {
      worker?.kill(signal);
    }
    // Give workers a grace period to drain before forcing exit.
    setTimeout(() => process.exit(0), 10_000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

const workerCount = env.CLUSTER_WORKERS === 0 ? availableParallelism() : env.CLUSTER_WORKERS;

if (workerCount > 1 && cluster.isPrimary) {
  startPrimary(workerCount);
} else {
  void startServer();
}
