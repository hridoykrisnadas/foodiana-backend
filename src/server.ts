import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import { env } from './lib/env.js';
import { ApiError } from './lib/errors.js';
import { healthRoutes } from './routes/health.js';
import { authRoutes } from './routes/auth.js';
import { publicRoutes } from './routes/public.js';
import { registerRoutes } from './routes/register.js';
import { scanRoutes } from './routes/scan.js';
import { adminRoutes } from './routes/admin.js';

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      // Pretty logs in development only; production emits newline-delimited JSON
      // so a log shipper can parse it.
      ...(env.isProduction
        ? {}
        : { transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } } }),
      base: { pid: process.pid },
    },
    // Behind a load balancer the client IP arrives in X-Forwarded-For; without
    // this every request would rate-limit against the balancer's IP.
    trustProxy: env.TRUST_PROXY,
    disableRequestLogging: env.isProduction,
    bodyLimit: 256 * 1024,
  });

  await app.register(helmet, { contentSecurityPolicy: false });

  await app.register(cors, {
    origin: (origin, callback) => {
      // Same-origin/server-to-server requests arrive without an Origin header.
      if (!origin) return callback(null, true);
      if (env.corsOrigins.includes('*') || env.corsOrigins.includes(origin)) {
        return callback(null, true);
      }
      // Pass an ApiError so the error handler answers 403 instead of 500.
      return callback(
        new ApiError(403, 'CORS_FORBIDDEN', `Origin ${origin} is not allowed by CORS_ORIGINS`),
        false,
      );
    },
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  });

  await app.register(rateLimit, {
    max: env.RATE_LIMIT_MAX,
    timeWindow: env.RATE_LIMIT_WINDOW,
    // NOTE: this counter is per replica, held in memory. With N replicas the
    // effective ceiling is N x RATE_LIMIT_MAX. Point it at a shared Redis store
    // (`redis` option) when you need one global budget across the cluster.
  });

  await app.register(jwt, {
    secret: env.JWT_SECRET,
    sign: { expiresIn: env.JWT_EXPIRES_IN },
  });

  app.setErrorHandler((raw, request, reply) => {
    if (raw instanceof ApiError) {
      if (raw.statusCode >= 500) request.log.error({ err: raw }, raw.message);
      else request.log.warn({ code: raw.code }, raw.message);
      return reply.code(raw.statusCode).send({
        error: raw.message,
        code: raw.code,
        ...(raw.details === undefined ? {} : { details: raw.details }),
      });
    }

    const error = raw as FastifyError;
    const statusCode = error.statusCode ?? 500;

    if (statusCode === 429) {
      return reply.code(429).send({ error: error.message, code: 'RATE_LIMITED' });
    }

    if (statusCode < 500) {
      return reply.code(statusCode).send({ error: error.message, code: error.code ?? 'BAD_REQUEST' });
    }

    // Never leak internals of an unexpected failure to the client.
    request.log.error({ err: error }, 'unhandled error');
    return reply.code(500).send({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  });

  app.setNotFoundHandler((request, reply) =>
    reply.code(404).send({
      error: `Route ${request.method} ${request.url} not found`,
      code: 'ROUTE_NOT_FOUND',
    }),
  );

  await app.register(healthRoutes);
  await app.register(authRoutes, { prefix: '/api/auth' });
  await app.register(publicRoutes, { prefix: '/api/public' });
  await app.register(registerRoutes, { prefix: '/api/register' });
  await app.register(scanRoutes, { prefix: '/api/scan' });
  await app.register(adminRoutes, { prefix: '/api/admin' });

  return app;
}
