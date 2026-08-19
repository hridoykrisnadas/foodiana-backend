import type { FastifyPluginAsync } from 'fastify';
import { sql } from 'kysely';
import { db } from '../db/client.js';
import { getMigrationFailure } from '../db/startup.js';

const startedAt = Date.now();

/**
 * Liveness and readiness probes. Kept outside /api and un-rate-limited so a
 * load balancer can poll them freely.
 */
export const healthRoutes: FastifyPluginAsync = async (app) => {
  app.get('/health', { config: { rateLimit: false } }, async () => ({
    status: 'ok',
    pid: process.pid,
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
  }));

  app.get('/health/ready', { config: { rateLimit: false } }, async (_request, reply) => {
    // A failed boot migration is the most useful thing this probe can report, so
    // it is checked before connectivity: the database may well be reachable now
    // while the schema was never applied.
    const migrationFailure = getMigrationFailure();
    if (migrationFailure) {
      return reply.code(503).send({
        status: 'unavailable',
        pid: process.pid,
        database: 'migrations_failed',
        detail: migrationFailure.message,
        hint: 'The service started but could not apply its migrations. Check DB_HOST, DB_PORT, DB_USER, DB_PASSWORD and DB_NAME, then restart.',
      });
    }

    try {
      await sql`SELECT 1`.execute(db);
    } catch (error) {
      return reply.code(503).send({
        status: 'unavailable',
        pid: process.pid,
        database: 'unreachable',
        detail: (error as Error).message,
      });
    }
    return { status: 'ok', pid: process.pid, database: 'reachable' };
  });
};
