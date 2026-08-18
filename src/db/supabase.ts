import { createClient, type PostgrestError, type SupabaseClient } from '@supabase/supabase-js';
import { env } from '../lib/env.js';
import { upstream } from '../lib/errors.js';

/**
 * Service-role client. Bypasses RLS, so it must never be reachable from a browser —
 * every table read/write in this service goes through an explicitly whitelisted route.
 */
export const db: SupabaseClient = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  global: { headers: { 'x-application-name': 'foodiana-backend' } },
});

/** Postgres unique-constraint violation. */
export const UNIQUE_VIOLATION = '23505';
/** Postgres undefined-function — used to detect a missing RPC and fall back. */
export const UNDEFINED_FUNCTION = '42883';

/** Unwrap a Supabase result, converting a Postgrest error into a 502 ApiError. */
export function unwrap<T>(
  result: { data: T | null; error: PostgrestError | null },
  context: string,
): T {
  if (result.error) {
    throw upstream(`${context} failed`, {
      code: result.error.code,
      message: result.error.message,
      hint: result.error.hint,
    });
  }
  return result.data as T;
}

/** Unwrap a `head: true, count: 'exact'` result down to a plain number. */
export function unwrapCount(
  result: { count: number | null; error: PostgrestError | null },
  context: string,
): number {
  if (result.error) {
    throw upstream(`${context} failed`, {
      code: result.error.code,
      message: result.error.message,
    });
  }
  return result.count ?? 0;
}
