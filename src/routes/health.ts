import type { FastifyPluginAsync } from 'fastify';
import { db } from '../db/supabase.js';

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
    const { error } = await db.from('event_settings').select('id').eq('id', 1).maybeSingle();
    if (error) {
      return reply.code(503).send({
        status: 'unavailable',
        pid: process.pid,
        database: 'unreachable',
        detail: error.message,
      });
    }
    return { status: 'ok', pid: process.pid, database: 'reachable' };
  });
};
