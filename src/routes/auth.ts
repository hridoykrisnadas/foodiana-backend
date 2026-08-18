import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { env } from '../lib/env.js';
import { roleForPassword } from '../lib/auth.js';
import { unauthorized } from '../lib/errors.js';
import { parseBody } from '../lib/validate.js';

const loginSchema = z.object({
  password: z.string().min(1, 'Password is required'),
});

export const authRoutes: FastifyPluginAsync = async (app) => {
  /**
   * Exchange the staff password for a short-lived JWT. Deliberately rate
   * limited hard — this is the only brute-forceable surface in the API.
   */
  app.post(
    '/login',
    {
      config: {
        rateLimit: { max: 10, timeWindow: '5 minutes' },
      },
    },
    async (request) => {
      const { password } = parseBody(loginSchema, request.body);
      const role = roleForPassword(password);

      if (!role) {
        request.log.warn({ ip: request.ip }, 'failed staff login');
        throw unauthorized('Invalid password');
      }

      const token = app.jwt.sign({ role }, { expiresIn: env.JWT_EXPIRES_IN });
      request.log.info({ role, ip: request.ip }, 'staff login');

      return { token, role, expiresIn: env.JWT_EXPIRES_IN };
    },
  );

  /** Lets the frontend confirm a stored token is still valid on page load. */
  app.get('/me', async (request) => {
    try {
      await request.jwtVerify();
    } catch {
      throw unauthorized('Missing or invalid bearer token');
    }
    return { role: request.user.role };
  });
};
