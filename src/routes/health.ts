import type { FastifyPluginAsync } from 'fastify';
import { sql } from 'kysely';
import { db } from '../db/client.js';

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
    // SELECT 1 rather than a table read: this probe reports connectivity, not
    // schema state. Migrations run on boot, so a missing table means the process
    // never started and cannot be observed here.
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
