import { readFileSync } from 'node:fs';
import type { FastifyPluginAsync } from 'fastify';

/**
 * Read the version from package.json rather than hardcoding it, so it cannot
 * drift from the released artifact.
 *
 * The relative path resolves the same in every way this service runs: `tsx` from
 * src/, `node` from dist/, and the Docker image — its Dockerfile copies
 * package.json in beside dist/, so ../../ is the app root in all three.
 */
const { version } = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
) as { version: string };

/**
 * Service banner for anyone who hits the API's domain directly. Without it the
 * root falls through to the 404 handler, which is a confusing first response
 * from a host that is working perfectly.
 *
 * Deliberately does NOT enumerate the API surface — a caller who needs the
 * routes has the README. Unlike the probes this keeps the default rate limit:
 * it is public and unauthenticated, and nothing needs to poll it freely.
 */
export const rootRoutes: FastifyPluginAsync = async (app) => {
  app.get('/', async () => ({
    service: 'foodiana-backend',
    status: 'ok',
    version,
    docs: 'https://github.com/hridoykrisnadas/foodiana-backend',
    health: {
      live: '/health',
      ready: '/health/ready',
    },
  }));
};
