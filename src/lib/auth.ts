import type { FastifyReply, FastifyRequest } from 'fastify';
import { env } from './env.js';
import { forbidden, unauthorized } from './errors.js';

export const ROLES = ['admin', 'agent'] as const;
export type Role = (typeof ROLES)[number];

export type TokenPayload = { role: Role };

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: TokenPayload;
    user: TokenPayload;
  }
}

/**
 * Resolve a submitted password to a role. Admin is checked first so that an
 * identical AGENT_PASSWORD can never downgrade an admin.
 */
export function roleForPassword(password: string): Role | null {
  if (timingSafeEqual(password, env.ADMIN_PASSWORD)) return 'admin';
  if (env.AGENT_PASSWORD && timingSafeEqual(password, env.AGENT_PASSWORD)) return 'agent';
  return null;
}

/** Constant-time string compare so login latency cannot leak the password. */
function timingSafeEqual(a: string, b: string): boolean {
  const length = Math.max(a.length, b.length);
  let mismatch = a.length === b.length ? 0 : 1;
  for (let i = 0; i < length; i += 1) {
    mismatch |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return mismatch === 0;
}

/**
 * Fastify preHandler factory. Verifies the bearer token and asserts the caller
 * holds one of the allowed roles. Stateless, so every clustered replica can
 * validate a token minted by any other replica.
 */
export function requireRole(...allowed: Role[]) {
  return async function guard(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
    try {
      await request.jwtVerify();
    } catch {
      throw unauthorized('Missing or invalid bearer token');
    }
    if (!allowed.includes(request.user.role)) {
      throw forbidden(`This endpoint requires role: ${allowed.join(' or ')}`);
    }
  };
}
