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

  /** 0 = one worker per CPU core. 1 = single process (no clustering). */
  CLUSTER_WORKERS: z.coerce.number().int().min(0).default(0),

  SUPABASE_URL: z.string().url('SUPABASE_URL must be a valid URL'),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20, 'SUPABASE_SERVICE_ROLE_KEY looks too short'),

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
  console.error(`\nInvalid backend environment configuration:\n${details}\n`);
  console.error('Copy backend/.env.example to backend/.env and fill in the values.\n');
  process.exit(1);
}

export const env = {
  ...parsed.data,
  corsOrigins: csv(parsed.data.CORS_ORIGINS),
  isProduction: parsed.data.NODE_ENV === 'production',
};

export type Env = typeof env;
