import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { db, unwrap } from '../db/supabase.js';
import { requireRole } from '../lib/auth.js';
import { notFound, upstream } from '../lib/errors.js';
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

/** Escape the PostgREST `or`/`ilike` metacharacters in a user-supplied search term. */
function escapeSearchTerm(term: string): string {
  return term.replace(/[%_,()\\]/g, (match) => `\\${match}`);
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

    let query = db
      .from('visitors')
      .select('*', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(page * pageSize, page * pageSize + pageSize - 1);

    if (filter === 'paid') query = query.eq('payment_status', 'Paid');
    else if (filter === 'pending') query = query.eq('payment_status', 'Pending');
    else if (filter === 'entered') query = query.eq('entry_status', true);
    else if (filter === 'inside') query = query.eq('entry_status', true).eq('exited_status', false);
    else if (filter === 'exited') query = query.eq('exited_status', true);

    if (search) {
      const term = escapeSearchTerm(search);
      query = query.or(
        `name.ilike.%${term}%,mobile.ilike.%${term}%,email.ilike.%${term}%,qr_code_id.ilike.%${term}%`,
      );
    }

    const { data, error, count } = await query;
    if (error) throw upstream('load visitors failed', { message: error.message });

    return { visitors: data ?? [], total: count ?? 0, page, pageSize };
  });

  /** Mark a pending registration as paid without admitting them. */
  app.patch('/visitors/:id/payment', async (request) => {
    const { id } = parseBody(idParamSchema, request.params);
    const visitor = unwrap(
      await db
        .from('visitors')
        .update({ payment_status: 'Paid' })
        .eq('id', id)
        .select('*')
        .maybeSingle(),
      'mark visitor paid',
    );
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
    const { data, error } = await db.rpc('admit_visitor', {
      p_visitor_id: id,
      p_payment_method: null,
    });
    if (error) throw upstream('admit_visitor failed', { message: error.message });

    const outcome = data as { status: string; visitor?: unknown; inside_now?: number; capacity?: number };
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
    const { data, error } = await db.rpc('exit_visitor', { p_visitor_id: id });
    if (error) throw upstream('exit_visitor failed', { message: error.message });

    const outcome = data as { status: string; visitor?: unknown; inside_now?: number; capacity?: number };
    if (outcome.status === 'not_found') throw notFound('Visitor not found');

    return {
      status: outcome.status,
      visitor: outcome.visitor ?? null,
      crowd: toCrowdMetrics(outcome.inside_now ?? 0, outcome.capacity ?? (await fetchGroundCapacity())),
    };
  });

  /** Paid visitors, oldest first — the pool the raffle draw prints from. */
  app.get('/raffle', async () => {
    const visitors = unwrap(
      await db
        .from('visitors')
        .select('id, qr_code_id, name, mobile, email, profession, ticket_price, includes_concert, created_at')
        .eq('payment_status', 'Paid')
        .order('created_at', { ascending: true }),
      'load raffle entrants',
    );
    return { visitors, total: visitors.length };
  });

  // ---- Ticket tiers -------------------------------------------------------

  /** All tiers including inactive ones. */
  app.get('/ticket-tiers', async () => ({
    tiers: unwrap(
      await db.from('ticket_tiers').select('*').order('display_order', { ascending: true }),
      'load ticket tiers',
    ),
  }));

  app.post('/ticket-tiers', async (request, reply) => {
    const payload = parseBody(tierSchema, request.body);
    const tier = unwrap(
      await db.from('ticket_tiers').insert(payload).select('*').single(),
      'create ticket tier',
    );
    return reply.code(201).send({ tier });
  });

  app.patch('/ticket-tiers/:id', async (request) => {
    const { id } = parseBody(idParamSchema, request.params);
    const payload = parseBody(tierSchema.partial(), request.body);
    const tier = unwrap(
      await db.from('ticket_tiers').update(payload).eq('id', id).select('*').maybeSingle(),
      'update ticket tier',
    );
    if (!tier) throw notFound('Ticket tier not found');
    return { tier };
  });

  app.delete('/ticket-tiers/:id', async (request, reply) => {
    const { id } = parseBody(idParamSchema, request.params);
    const { error } = await db.from('ticket_tiers').delete().eq('id', id);
    if (error) {
      throw upstream('delete ticket tier failed', { code: error.code, message: error.message });
    }
    return reply.code(204).send();
  });

  // ---- Event settings -----------------------------------------------------

  app.get('/event-settings', async () => ({
    settings: unwrap(
      await db
        .from('event_settings')
        .select('event_date, event_end_date, ground_capacity, updated_at')
        .eq('id', 1)
        .maybeSingle(),
      'load event settings',
    ),
  }));

  app.patch('/event-settings', async (request) => {
    const payload = parseBody(eventSettingsSchema, request.body);
    const settings = unwrap(
      await db
        .from('event_settings')
        .update({ ...payload, updated_at: new Date().toISOString() })
        .eq('id', 1)
        .select('event_date, event_end_date, ground_capacity, updated_at')
        .maybeSingle(),
      'update event settings',
    );
    if (!settings) throw notFound('Event settings row (id=1) is missing');
    return { settings };
  });

  // ---- Site content CRUD --------------------------------------------------
  // Table and column names are whitelisted in lib/content.ts.

  app.get('/content/:table', async (request) => {
    const { table } = parseBody(contentParamSchema, request.params);
    const entry = resolveContentTable(table);
    return {
      items: unwrap(
        await db.from(entry.table).select('*').order('display_order', { ascending: true }),
        `load ${entry.table}`,
      ),
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

    // Append to the end of the list unless the client picked a position.
    if (payload.display_order === undefined) {
      const { count } = await db.from(entry.table).select('*', { count: 'exact', head: true });
      payload.display_order = (count ?? 0) + 1;
    }

    const item = unwrap(
      await db.from(entry.table).insert(payload).select('*').single(),
      `create ${entry.table} row`,
    );
    return reply.code(201).send({ item });
  });

  app.patch('/content/:table/:id', async (request) => {
    const { table, id } = parseBody(contentItemParamSchema, request.params);
    const entry = resolveContentTable(table);
    const payload = sanitizeContentPayload(
      entry,
      (request.body ?? {}) as Record<string, unknown>,
      { partial: true },
    );
    const item = unwrap(
      await db.from(entry.table).update(payload).eq('id', id).select('*').maybeSingle(),
      `update ${entry.table} row`,
    );
    if (!item) throw notFound(`No ${entry.table} row with id ${id}`);
    return { item };
  });

  app.delete('/content/:table/:id', async (request, reply) => {
    const { table, id } = parseBody(contentItemParamSchema, request.params);
    const entry = resolveContentTable(table);
    const { error } = await db.from(entry.table).delete().eq('id', id);
    if (error) {
      throw upstream(`delete ${entry.table} row failed`, {
        code: error.code,
        message: error.message,
      });
    }
    return reply.code(204).send();
  });
};
