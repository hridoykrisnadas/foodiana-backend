import { db, UNDEFINED_FUNCTION, unwrapCount } from '../db/supabase.js';
import { upstream } from './errors.js';

export type VisitorMetrics = {
  total: number;
  paid: number;
  pending: number;
  checkedIn: number;
  exited: number;
  insideNow: number;
};

export type CrowdMetrics = {
  insideNow: number;
  capacity: number;
  available: number;
  isFull: boolean;
};

export const DEFAULT_CAPACITY = 2000;

/**
 * Counts for the whole visitor table.
 *
 * Prefers the `get_visitor_metrics()` RPC (one round trip, counted inside
 * Postgres). Falls back to parallel head-counts if that migration has not been
 * applied yet, so the dashboard degrades in speed rather than breaking.
 */
export async function fetchVisitorMetrics(): Promise<VisitorMetrics> {
  const rpc = await db.rpc('get_visitor_metrics').maybeSingle();

  if (!rpc.error && rpc.data) {
    const row = rpc.data as Record<string, number | null>;
    const total = Number(row.total ?? 0);
    const paid = Number(row.paid ?? 0);
    return {
      total,
      paid,
      pending: total - paid,
      checkedIn: Number(row.checked_in ?? 0),
      exited: Number(row.exited ?? 0),
      insideNow: Number(row.inside_now ?? 0),
    };
  }

  if (rpc.error && rpc.error.code !== UNDEFINED_FUNCTION) {
    // A real failure (permissions, bad SQL, unreachable database) — surface it as
    // a 502 like every other upstream error rather than a generic 500.
    throw upstream('get_visitor_metrics failed', {
      code: rpc.error.code,
      message: rpc.error.message,
    });
  }

  const base = () => db.from('visitors').select('*', { count: 'exact', head: true });
  const [total, paid, checkedIn, exited, insideNow] = await Promise.all([
    base(),
    base().eq('payment_status', 'Paid'),
    base().eq('entry_status', true),
    base().eq('exited_status', true),
    base().eq('entry_status', true).eq('exited_status', false),
  ]);

  const totalCount = unwrapCount(total, 'count visitors');
  const paidCount = unwrapCount(paid, 'count paid visitors');

  return {
    total: totalCount,
    paid: paidCount,
    pending: totalCount - paidCount,
    checkedIn: unwrapCount(checkedIn, 'count checked-in visitors'),
    exited: unwrapCount(exited, 'count exited visitors'),
    insideNow: unwrapCount(insideNow, 'count visitors inside'),
  };
}

export async function fetchGroundCapacity(): Promise<number> {
  const { data, error } = await db
    .from('event_settings')
    .select('ground_capacity')
    .eq('id', 1)
    .maybeSingle();
  if (error) return DEFAULT_CAPACITY;
  const capacity = Number(data?.ground_capacity);
  return Number.isFinite(capacity) && capacity > 0 ? capacity : DEFAULT_CAPACITY;
}

export function toCrowdMetrics(insideNow: number, capacity: number): CrowdMetrics {
  return {
    insideNow,
    capacity,
    available: Math.max(0, capacity - insideNow),
    isFull: insideNow >= capacity,
  };
}

/** Live occupancy — the number the gate scanner polls. */
export async function fetchCrowdMetrics(): Promise<CrowdMetrics> {
  const [insideResult, capacity] = await Promise.all([
    db
      .from('visitors')
      .select('*', { count: 'exact', head: true })
      .eq('entry_status', true)
      .eq('exited_status', false),
    fetchGroundCapacity(),
  ]);
  return toCrowdMetrics(unwrapCount(insideResult, 'count visitors inside'), capacity);
}
