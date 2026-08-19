import 'dotenv/config';
import { z } from 'zod';

const csv = (value: string) =>
  value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),

  DB_HOST: z.string().min(1, 'DB_HOST is required'),
  DB_PORT: z.coerce.number().int().min(1).max(65535).default(3306),
  DB_USER: z.string().min(1, 'DB_USER is required'),
  DB_PASSWORD: z.string().default(''),
  DB_NAME: z.string().min(1, 'DB_NAME is required'),
  DB_POOL_SIZE: z.coerce.number().int().min(1).max(100).default(10),

  /**
   * Absolute path for uploaded photos. On Hostinger this MUST be outside the
   * versioned build directory (.../hbuilds/versions/<uuid>/nodejs/) or every
   * deploy silently discards every uploaded image.
   */
  UPLOAD_DIR: z.string().min(1).default('./uploads'),

  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_EXPIRES_IN: z.string().default('8h'),

  ADMIN_PASSWORD: z.string().min(8, 'ADMIN_PASSWORD must be at least 8 characters'),
  /** Optional separate password for gate agents. Falls back to admin-only login when unset. */
  AGENT_PASSWORD: z.string().min(8).optional(),

  /** Comma-separated list of allowed browser origins. */
  CORS_ORIGINS: z.string().default('http://localhost:3000'),

  RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(300),
  RATE_LIMIT_WINDOW: z.string().default('1 minute'),
  /** Tighter budget for the public registration endpoint. */
  REGISTER_RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(10),
  REGISTER_RATE_LIMIT_WINDOW: z.string().default('10 minutes'),

  /** Trust X-Forwarded-* headers. Enable when running behind a load balancer. */
  TRUST_PROXY: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const details = parsed.error.issues
    .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n');
  console.error(`\nInvalid environment configuration:\n${details}\n`);
  console.error('Copy .env.example to .env and fill in the values.\n');
  process.exit(1);
}

export const env = {
  ...parsed.data,
  corsOrigins: csv(parsed.data.CORS_ORIGINS),
  isProduction: parsed.data.NODE_ENV === 'production',
};

export type Env = typeof env;
