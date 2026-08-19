import { createClient, type PostgrestError, type SupabaseClient } from '@supabase/supabase-js';
import { env } from '../lib/env.js';
import { upstream } from '../lib/errors.js';

/**
 * Derived from supabase-js's own options rather than imported from
 * @supabase/realtime-js, which is only a transitive dependency here.
 */
type RealtimeTransport = NonNullable<
  NonNullable<NonNullable<Parameters<typeof createClient>[2]>['realtime']>['transport']
>;

/**
 * `createClient` always builds a RealtimeClient, and RealtimeClient resolves a
 * WebSocket constructor while constructing — even though this service never opens
 * a realtime channel. On a runtime with no global WebSocket (Node < 22) that
 * lookup throws, and because the client is created at module scope the process
 * dies on import, before it ever listens. That took the API down in production.
 *
 * RealtimeClient resolves it as `options?.transport ?? getWebSocketConstructor()`,
 * so passing `transport` explicitly skips the failing lookup entirely. The
 * runtime floor becomes a decision this service makes, not one imposed by a
 * feature it does not use.
 *
 * Where a native WebSocket exists it is passed straight through, so realtime
 * still works if it is ever wanted. Where it does not, the stub fails only if
 * something actually opens a socket — and says why.
 */
const realtimeTransport =
  globalThis.WebSocket ??
  class RealtimeUnavailable {
    constructor() {
      throw new Error(
        'Realtime is unavailable: this runtime has no global WebSocket (Node < 22). ' +
          'This service does not use realtime — to add it, run Node 22+ or pass a ' +
          'WebSocket implementation as realtime.transport.',
      );
    }
  };

/**
 * Service-role client. Bypasses RLS, so it must never be reachable from a browser —
 * every table read/write in this service goes through an explicitly whitelisted route.
 */
export const db: SupabaseClient = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  global: { headers: { 'x-application-name': 'foodiana-backend' } },
  // Cast because the DOM's WebSocket types its event handlers more narrowly than
  // supabase's structural WebSocketLike; the two are compatible at runtime.
  realtime: { transport: realtimeTransport as unknown as RealtimeTransport },
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
