import type { FastifyPluginAsync } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { db } from '../db/client.js';
import { admitVisitor, exitVisitor } from '../db/gate.js';
import type { ContentTableName } from '../db/schema.js';
import { requireRole } from '../lib/auth.js';
import { notFound } from '../lib/errors.js';
import {
  fetchGroundCapacity,
  fetchVisitorMetrics,
  toCrowdMetrics,
} from '../lib/metrics.js';
import {
  CONTENT_TABLE_NAMES,
  resolveContentTable,
  sanitizeContentPayload,
} from '../lib/content.js';
import { parseBody } from '../lib/validate.js';

const VISITOR_FILTERS = ['all', 'paid', 'pending', 'entered', 'inside', 'exited'] as const;

const visitorQuerySchema = z.object({
  filter: z.enum(VISITOR_FILTERS).default('all'),
  search: z.string().trim().max(120).default(''),
  page: z.coerce.number().int().min(0).default(0),
  pageSize: z.coerce.number().int().min(1).max(200).default(10),
});

const idParamSchema = z.object({ id: z.uuid() });

const tierSchema = z.object({
  day: z.enum(['Thursday', 'Friday', 'Saturday']),
  start_time: z.string().regex(/^\d{2}:\d{2}$/, 'start_time must be HH:MM'),
  end_time: z.string().regex(/^\d{2}:\d{2}$/, 'end_time must be HH:MM'),
  price: z.coerce.number().int().min(0).max(1_000_000),
  includes_concert: z.coerce.boolean().default(false),
  label_en: z.string().trim().max(120).default(''),
  label_bn: z.string().trim().max(120).default(''),
  is_active: z.coerce.boolean().default(true),
  display_order: z.coerce.number().int().min(0).default(0),
});

const eventSettingsSchema = z
  .object({
    event_date: z.iso.date().optional(),
    event_end_date: z.iso.date().optional(),
    ground_capacity: z.coerce.number().int().min(1).max(1_000_000).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'Supply at least one of event_date, event_end_date, ground_capacity',
  });

const contentParamSchema = z.object({
  table: z.enum(CONTENT_TABLE_NAMES as [string, ...string[]]),
});

const contentItemParamSchema = contentParamSchema.extend({ id: z.uuid() });

/** Escape the LIKE wildcards in a user-supplied search term. */
function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (match) => `\\${match}`);
}

/**
 * Admin dashboard endpoints. Admin role only — the gate-agent token cannot
 * reach visitor lists, pricing or site content.
 */
export const adminRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requireRole('admin'));

  /** Every dashboard headline number in one round trip. */
  app.get('/metrics', async () => {
    const [metrics, capacity] = await Promise.all([fetchVisitorMetrics(), fetchGroundCapacity()]);
    return { metrics, crowd: toCrowdMetrics(metrics.insideNow, capacity) };
  });

  /** Paginated, filterable visitor list. Returns `total` so the UI can page properly. */
  app.get('/visitors', async (request) => {
    const { filter, search, page, pageSize } = parseBody(visitorQuerySchema, request.query);

    let base = db.selectFrom('visitors');

    if (filter === 'paid') base = base.where('payment_status', '=', 'Paid');
    else if (filter === 'pending') base = base.where('payment_status', '=', 'Pending');
    else if (filter === 'entered') base = base.where('entry_status', '=', true);
    else if (filter === 'inside') {
      base = base.where('entry_status', '=', true).where('exited_status', '=', false);
    } else if (filter === 'exited') base = base.where('exited_status', '=', true);

    if (search) {
      const term = `%${escapeLike(search)}%`;
      base = base.where((eb) =>
        eb.or([
          eb('name', 'like', term),
          eb('mobile', 'like', term),
          eb('email', 'like', term),
          eb('qr_code_id', 'like', term),
        ]),
      );
    }

    // MariaDB has no count-alongside-rows, so the total is its own query.
    const [visitors, counted] = await Promise.all([
      base.selectAll().orderBy('created_at', 'desc').limit(pageSize).offset(page * pageSize).execute(),
      base.select((eb) => eb.fn.countAll().as('total')).executeTakeFirstOrThrow(),
    ]);

    return { visitors, total: Number(counted.total), page, pageSize };
  });

  /** Mark a pending registration as paid without admitting them. */
  app.patch('/visitors/:id/payment', async (request) => {
    const { id } = parseBody(idParamSchema, request.params);
    await db.updateTable('visitors').set({ payment_status: 'Paid' }).where('id', '=', id).execute();
    const visitor = await db
      .selectFrom('visitors')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    if (!visitor) throw notFound('Visitor not found');
    request.log.info({ visitorId: id }, 'visitor marked paid from dashboard');
    return { visitor };
  });

  /**
   * Manual admission from the dashboard. Shares the atomic gate RPC with the
   * scanner so both paths enforce the same capacity ceiling.
   */
  app.patch('/visitors/:id/entry', async (request) => {
    const { id } = parseBody(idParamSchema, request.params);
    const outcome = await admitVisitor(id, null);
    if (outcome.status === 'not_found') throw notFound('Visitor not found');

    return {
      status: outcome.status,
      visitor: outcome.visitor ?? null,
      crowd: toCrowdMetrics(outcome.inside_now ?? 0, outcome.capacity ?? 0),
    };
  });

  /** Manual exit from the dashboard. */
  app.patch('/visitors/:id/exit', async (request) => {
    const { id } = parseBody(idParamSchema, request.params);
    const outcome = await exitVisitor(id);
    if (outcome.status === 'not_found') throw notFound('Visitor not found');

    return {
      status: outcome.status,
      visitor: outcome.visitor ?? null,
      crowd: toCrowdMetrics(outcome.inside_now ?? 0, outcome.capacity ?? (await fetchGroundCapacity())),
    };
  });

  /** Paid visitors, oldest first — the pool the raffle draw prints from. */
  app.get('/raffle', async () => {
    const visitors = await db
      .selectFrom('visitors')
      .select([
        'id', 'qr_code_id', 'name', 'mobile', 'email',
        'profession', 'ticket_price', 'includes_concert', 'created_at',
      ])
      .where('payment_status', '=', 'Paid')
      .orderBy('created_at', 'asc')
      .execute();
    return { visitors, total: visitors.length };
  });

  // ---- Ticket tiers -------------------------------------------------------

  /** All tiers including inactive ones. */
  app.get('/ticket-tiers', async () => ({
    tiers: await db.selectFrom('ticket_tiers').selectAll().orderBy('display_order', 'asc').execute(),
  }));

  app.post('/ticket-tiers', async (request, reply) => {
    const payload = parseBody(tierSchema, request.body);
    const id = randomUUID();
    await db.insertInto('ticket_tiers').values({ id, ...payload }).execute();
    const tier = await db
      .selectFrom('ticket_tiers')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    return reply.code(201).send({ tier });
  });

  app.patch('/ticket-tiers/:id', async (request) => {
    const { id } = parseBody(idParamSchema, request.params);
    const payload = parseBody(tierSchema.partial(), request.body);
    await db.updateTable('ticket_tiers').set(payload).where('id', '=', id).execute();
    const tier = await db
      .selectFrom('ticket_tiers')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    if (!tier) throw notFound('Ticket tier not found');
    return { tier };
  });

  app.delete('/ticket-tiers/:id', async (request, reply) => {
    const { id } = parseBody(idParamSchema, request.params);
    await db.deleteFrom('ticket_tiers').where('id', '=', id).execute();
    return reply.code(204).send();
  });

  // ---- Event settings -----------------------------------------------------

  app.get('/event-settings', async () => ({
    settings: await db
      .selectFrom('event_settings')
      .select(['event_date', 'event_end_date', 'ground_capacity', 'updated_at'])
      .where('id', '=', 1)
      .executeTakeFirst(),
  }));

  app.patch('/event-settings', async (request) => {
    const payload = parseBody(eventSettingsSchema, request.body);
    await db
      .updateTable('event_settings')
      .set({ ...payload, updated_at: new Date() })
      .where('id', '=', 1)
      .execute();
    const settings = await db
      .selectFrom('event_settings')
      .select(['event_date', 'event_end_date', 'ground_capacity', 'updated_at'])
      .where('id', '=', 1)
      .executeTakeFirst();
    if (!settings) throw notFound('Event settings row (id=1) is missing');
    return { settings };
  });

  // ---- Site content CRUD --------------------------------------------------
  // Table and column names are whitelisted in lib/content.ts.

  app.get('/content/:table', async (request) => {
    const { table } = parseBody(contentParamSchema, request.params);
    const entry = resolveContentTable(table);
    return {
      items: await db
        .selectFrom(entry.table as ContentTableName)
        .selectAll()
        .orderBy('display_order', 'asc')
        .execute(),
    };
  });

  app.post('/content/:table', async (request, reply) => {
    const { table } = parseBody(contentParamSchema, request.params);
    const entry = resolveContentTable(table);
    const payload = sanitizeContentPayload(
      entry,
      (request.body ?? {}) as Record<string, unknown>,
      { partial: false },
    );
    const name = entry.table as ContentTableName;

    // Append to the end of the list unless the client picked a position.
    if (payload.display_order === undefined) {
      const { count } = await db
        .selectFrom(name)
        .select((eb) => eb.fn.countAll().as('count'))
        .executeTakeFirstOrThrow();
      payload.display_order = Number(count) + 1;
    }

    const id = randomUUID();
    await db.insertInto(name).values({ id, ...payload } as never).execute();
    const item = await db
      .selectFrom(name)
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    return reply.code(201).send({ item });
  });

  app.patch('/content/:table/:id', async (request) => {
    const { table, id } = parseBody(contentItemParamSchema, request.params);
    const entry = resolveContentTable(table);
    const name = entry.table as ContentTableName;
    const payload = sanitizeContentPayload(
      entry,
      (request.body ?? {}) as Record<string, unknown>,
      { partial: true },
    );
    await db.updateTable(name).set(payload as never).where('id', '=', id).execute();
    const item = await db.selectFrom(name).selectAll().where('id', '=', id).executeTakeFirst();
    if (!item) throw notFound(`No ${entry.table} row with id ${id}`);
    return { item };
  });

  app.delete('/content/:table/:id', async (request, reply) => {
    const { table, id } = parseBody(contentItemParamSchema, request.params);
    const entry = resolveContentTable(table);
    await db.deleteFrom(entry.table as ContentTableName).where('id', '=', id).execute();
    return reply.code(204).send();
  });
};
