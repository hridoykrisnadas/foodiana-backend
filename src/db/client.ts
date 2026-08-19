import { Kysely, MysqlDialect } from 'kysely';
import { createPool } from 'mysql2';
import { env } from '../lib/env.js';
import type { Database } from './schema.js';

/** MariaDB duplicate-key error. Replaces the Postgres 23505 checks. */
export const DUPLICATE_ENTRY = 1062;

const pool = createPool({
  host: env.DB_HOST,
  port: env.DB_PORT,
  user: env.DB_USER,
  password: env.DB_PASSWORD,
  database: env.DB_NAME,
  connectionLimit: env.DB_POOL_SIZE,
  charset: 'utf8mb4',
  // DATETIME columns are stored UTC; without this mysql2 applies the server's
  // local offset and timestamps drift.
  timezone: 'Z',
  // Keep DATE as 'YYYY-MM-DD'. Becoming a Date here would change dob and
  // event_date in every public response.
  dateStrings: ['DATE'],
  // TINYINT(1) is our boolean. mysql2 hands back 0/1 without this, and `1` is
  // truthy but `entry_status === true` would be false everywhere.
  typeCast(field, next) {
    if (field.type === 'TINY' && field.length === 1) {
      const value = field.string();
      return value === null ? null : value === '1';
    }
    return next();
  },
});

export const db = new Kysely<Database>({ dialect: new MysqlDialect({ pool }) });

export function isDuplicateEntry(error: unknown): boolean {
  return (error as { errno?: number } | null)?.errno === DUPLICATE_ENTRY;
}
