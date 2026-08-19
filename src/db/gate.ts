import type { Selectable } from 'kysely';
import { db } from './client.js';
import type { VisitorsTable } from './schema.js';

/** A visitor row as it comes back from a SELECT (ColumnType resolved to its read side). */
export type Visitor = Selectable<VisitorsTable>;

/**
 * The gate's status contract. These strings reach the scanner UI through
 * scan.ts and admin.ts, so renaming one is a breaking change to the frontend.
 */
export type GateStatus =
  | 'not_found'
  | 'already_inside'
  | 'already_exited'
  | 'capacity_full'
  | 'admitted'
  | 'not_entered'
  | 'exited';

export type GateOutcome = {
  status: GateStatus;
  visitor?: Visitor;
  inside_now?: number;
  capacity?: number;
};

export const DEFAULT_CAPACITY = 2000;

/** Read the ceiling and take the lock that serialises the whole critical section. */
async function lockCapacity(trx: {
  selectFrom: typeof db.selectFrom;
}): Promise<number> {
  const settings = await trx
    .selectFrom('event_settings')
    .select('ground_capacity')
    .where('id', '=', 1)
    .forUpdate()
    .executeTakeFirst();

  const capacity = Number(settings?.ground_capacity);
  return Number.isFinite(capacity) && capacity > 0 ? capacity : DEFAULT_CAPACITY;
}

/**
 * Admit a visitor, enforcing the venue capacity atomically.
 *
 * The `FOR UPDATE` on the event_settings singleton is what makes this correct.
 * It serialises every concurrent admission for the life of the transaction, so
 * two gates scanning at once cannot both pass a check at capacity - 1. It is
 * taken on a row the transaction has to read anyway, and MariaDB releases it on
 * commit or rollback — unlike GET_LOCK(), which is session-scoped and can be
 * stranded by a pooled connection dying mid-scan.
 *
 * Removing `.forUpdate()` makes tests/gate-concurrency.test.mjs fail. That is
 * the point of that test.
 */
export async function admitVisitor(
  id: string,
  paymentMethod?: string | null,
): Promise<GateOutcome> {
  return db.transaction().execute(async (trx) => {
    const capacity = await lockCapacity(trx);

    const visitor = await trx
      .selectFrom('visitors')
      .selectAll()
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirst();

    if (!visitor) return { status: 'not_found' };
    if (visitor.exited_status) return { status: 'already_exited', visitor, capacity };
    if (visitor.entry_status) return { status: 'already_inside', visitor, capacity };

    const { inside } = await trx
      .selectFrom('visitors')
      .select((eb) => eb.fn.countAll().as('inside'))
      .where('entry_status', '=', true)
      .where('exited_status', '=', false)
      .executeTakeFirstOrThrow();

    const insideNow = Number(inside);
    if (insideNow >= capacity) {
      return { status: 'capacity_full', visitor, inside_now: insideNow, capacity };
    }

    await trx
      .updateTable('visitors')
      .set({
        entry_status: true,
        checked_in_at: new Date(),
        // Admission at the gate is also the point of payment.
        payment_status: 'Paid',
        ...(paymentMethod ? { payment_method: paymentMethod } : {}),
      })
      .where('id', '=', id)
      .execute();

    const updated = await trx
      .selectFrom('visitors')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow();

    return { status: 'admitted', visitor: updated, inside_now: insideNow + 1, capacity };
  });
}

/** Record a visitor leaving. Same locking discipline, no capacity check. */
export async function exitVisitor(id: string): Promise<GateOutcome> {
  return db.transaction().execute(async (trx) => {
    const capacity = await lockCapacity(trx);

    const visitor = await trx
      .selectFrom('visitors')
      .selectAll()
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirst();

    if (!visitor) return { status: 'not_found' };
    if (visitor.exited_status) return { status: 'already_exited', visitor, capacity };
    if (!visitor.entry_status) return { status: 'not_entered', visitor, capacity };

    await trx
      .updateTable('visitors')
      .set({ exited_status: true, exited_at: new Date() })
      .where('id', '=', id)
      .execute();

    const { inside } = await trx
      .selectFrom('visitors')
      .select((eb) => eb.fn.countAll().as('inside'))
      .where('entry_status', '=', true)
      .where('exited_status', '=', false)
      .executeTakeFirstOrThrow();

    const updated = await trx
      .selectFrom('visitors')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow();

    return { status: 'exited', visitor: updated, inside_now: Number(inside), capacity };
  });
}
