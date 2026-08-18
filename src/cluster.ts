import cluster from 'node:cluster';
import { availableParallelism } from 'node:os';
import { env } from './lib/env.js';

/**
 * Clustered entry point: forks one worker per CPU core and keeps the pool
 * topped up. All workers share the listening socket, so a single container
 * saturates the whole machine.
 *
 * The API is stateless (JWT auth, no in-process session or cache that must be
 * coherent), so a request can land on any worker or any replica. The one caveat
 * is the rate-limit counter, which is per worker — see the note in server.ts.
 *
 * Set CLUSTER_WORKERS=1 to run a single process instead, which is what you want
 * when the orchestrator (Kubernetes, ECS, Fly) already scales by replica.
 */
const desired = env.CLUSTER_WORKERS === 0 ? availableParallelism() : env.CLUSTER_WORKERS;

if (desired === 1) {
  await import('./index.js');
} else if (cluster.isPrimary) {
  console.log(`[cluster] primary ${process.pid} starting ${desired} workers`);

  for (let i = 0; i < desired; i += 1) cluster.fork();

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
} else {
  await import('./index.js');
}
