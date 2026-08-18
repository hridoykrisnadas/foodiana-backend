import { buildServer } from './server.js';
import { env } from './lib/env.js';

/**
 * Single-process entry point. Used by `npm run dev` and by container platforms
 * that prefer one process per container and scale by replica count.
 * For in-container clustering use `cluster.ts` (`npm start`).
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
