import { sql } from 'kysely';
import { db } from '../db/client.js';

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
 * Counts for the whole visitor table, in one round trip.
 *
 * A single aggregate rather than five head-counts: the dashboard polls this, and
 * five round trips to count the same table is wasteful. The RPC-with-fallback
 * this replaces existed only because the counting lived in Postgres.
 */
export async function fetchVisitorMetrics(): Promise<VisitorMetrics> {
  const { rows } = await sql<{
    total: number | string;
    paid: number | string | null;
    checked_in: number | string | null;
    exited: number | string | null;
    inside_now: number | string | null;
  }>`
    SELECT
      COUNT(*)                                    AS total,
      SUM(payment_status = 'Paid')                AS paid,
      SUM(entry_status = 1)                       AS checked_in,
      SUM(exited_status = 1)                      AS exited,
      SUM(entry_status = 1 AND exited_status = 0) AS inside_now
    FROM visitors
  `.execute(db);

  const row = rows[0];
  // SUM() over zero rows is NULL, not 0.
  const total = Number(row?.total ?? 0);
  const paid = Number(row?.paid ?? 0);

  return {
    total,
    paid,
    pending: total - paid,
    checkedIn: Number(row?.checked_in ?? 0),
    exited: Number(row?.exited ?? 0),
    insideNow: Number(row?.inside_now ?? 0),
  };
}

export async function fetchGroundCapacity(): Promise<number> {
  try {
    const row = await db
      .selectFrom('event_settings')
      .select('ground_capacity')
      .where('id', '=', 1)
      .executeTakeFirst();
    const capacity = Number(row?.ground_capacity);
    return Number.isFinite(capacity) && capacity > 0 ? capacity : DEFAULT_CAPACITY;
  } catch {
    return DEFAULT_CAPACITY;
  }
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
  const [inside, capacity] = await Promise.all([
    db
      .selectFrom('visitors')
      .select((eb) => eb.fn.countAll().as('inside'))
      .where('entry_status', '=', true)
      .where('exited_status', '=', false)
      .executeTakeFirstOrThrow(),
    fetchGroundCapacity(),
  ]);
  return toCrowdMetrics(Number(inside.inside), capacity);
}
