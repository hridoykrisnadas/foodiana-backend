import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { db } from '../db/client.js';
import { admitVisitor, exitVisitor } from '../db/gate.js';
import { requireRole } from '../lib/auth.js';
import { badRequest, conflict, notFound, unprocessable, upstream } from '../lib/errors.js';
import { fetchCrowdMetrics, fetchGroundCapacity, toCrowdMetrics } from '../lib/metrics.js';
import { parseBody } from '../lib/validate.js';

const qrParamSchema = z.object({
  qrCodeId: z.string().trim().min(3).max(64),
});

/*
 * The QR lookup sits under /lookup rather than /visitor/:qrCodeId so the two
 * kinds of identifier stay visually distinct: /lookup takes the short human
 * code printed on a ticket (FDL-XXXXXX), while /visitor/:id takes the row's UUID.
 */

const idParamSchema = z.object({
  id: z.uuid('A visitor id is required'),
});

const entryBodySchema = z.object({
  payment_method: z.enum(['Cash', 'bKash']).nullish(),
});

type VisitorRow = {
  entry_status: boolean;
  exited_status: boolean;
  payment_status: string;
};

/** The single source of truth for a visitor's gate status. */
export function deriveStatus(visitor: VisitorRow): 'already_exited' | 'entered' | 'paid' | 'pending' {
  if (visitor.exited_status) return 'already_exited';
  if (visitor.entry_status) return 'entered';
  if (visitor.payment_status === 'Paid') return 'paid';
  return 'pending';
}

/**
 * Gate scanner endpoints. Requires a staff token (admin or agent).
 *
 * Admission and exit both run inside a transaction that takes a row lock, so the
 * capacity ceiling holds even with several gates scanning at once against
 * several backend replicas. Checking capacity and then updating without that
 * lock would let two simultaneous scans both pass a full-venue check.
 * See src/db/gate.ts.
 */
export const scanRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requireRole('admin', 'agent'));

  /** Live occupancy. Polled every few seconds by the scanner UI. */
  app.get('/crowd', async () => ({ crowd: await fetchCrowdMetrics() }));

  /** Look up a visitor by the code encoded in their QR. */
  app.get('/lookup/:qrCodeId', async (request) => {
    const { qrCodeId } = parseBody(qrParamSchema, request.params);
    const normalized = qrCodeId.trim().toUpperCase();

    const visitor = await db
      .selectFrom('visitors')
      .select([
        'id', 'qr_code_id', 'name', 'mobile', 'profession', 'payment_status',
        'payment_method', 'entry_status', 'checked_in_at', 'ticket_tier_id',
        'ticket_price', 'includes_concert', 'exited_status', 'exited_at',
      ])
      .where('qr_code_id', '=', normalized)
      .executeTakeFirst();

    if (!visitor) throw notFound(`No visitor found for code ${normalized}`);

    const tier = visitor.ticket_tier_id
      ? ((await db
          .selectFrom('ticket_tiers')
          .select([
            'id', 'day', 'start_time', 'end_time',
            'price', 'includes_concert', 'label_en', 'label_bn',
          ])
          .where('id', '=', visitor.ticket_tier_id)
          .executeTakeFirst()) ?? null)
      : null;

    return { visitor, tier, status: deriveStatus(visitor) };
  });

  /**
   * Admit a visitor: marks them paid (gate payment) and inside, in one atomic
   * step that also enforces the ground capacity.
   */
  app.post('/visitor/:id/entry', async (request) => {
    const { id } = parseBody(idParamSchema, request.params);
    const { payment_method: paymentMethod } = parseBody(entryBodySchema, request.body);

    const outcome = await admitVisitor(id, paymentMethod ?? null);

    switch (outcome.status) {
      case 'admitted':
        request.log.info(
          { visitorId: id, insideNow: outcome.inside_now, by: request.user.role },
          'visitor admitted',
        );
        return {
          status: 'admitted',
          visitor: outcome.visitor,
          crowd: toCrowdMetrics(outcome.inside_now ?? 0, outcome.capacity ?? 0),
        };
      case 'not_found':
        throw notFound('Visitor no longer exists');
      case 'already_inside':
        throw conflict('This visitor is already inside the venue', { visitor: outcome.visitor });
      case 'already_exited':
        throw conflict('This visitor has already exited and cannot re-enter', {
          visitor: outcome.visitor,
        });
      case 'capacity_full':
        throw unprocessable('CAPACITY_FULL', 'The venue is at capacity — entry is on hold', {
          crowd: toCrowdMetrics(outcome.inside_now ?? 0, outcome.capacity ?? 0),
        });
      default:
        throw upstream(`Unexpected admit_visitor outcome: ${outcome.status}`);
    }
  });

  /** Record a visitor leaving, freeing a slot for the crowd counter. */
  app.post('/visitor/:id/exit', async (request) => {
    const { id } = parseBody(idParamSchema, request.params);
    const outcome = await exitVisitor(id);

    switch (outcome.status) {
      case 'exited': {
        request.log.info({ visitorId: id, by: request.user.role }, 'visitor exited');
        const capacity = outcome.capacity ?? (await fetchGroundCapacity());
        return {
          status: 'exited',
          visitor: outcome.visitor,
          crowd: toCrowdMetrics(outcome.inside_now ?? 0, capacity),
        };
      }
      case 'not_found':
        throw notFound('Visitor no longer exists');
      case 'not_entered':
        throw badRequest('This visitor has not entered the venue yet');
      case 'already_exited':
        throw conflict('This visitor has already been marked as exited', {
          visitor: outcome.visitor,
        });
      default:
        throw upstream(`Unexpected exit_visitor outcome: ${outcome.status}`);
    }
  });
};
