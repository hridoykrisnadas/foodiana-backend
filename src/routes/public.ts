import type { FastifyPluginAsync } from 'fastify';
import { db, unwrap } from '../db/supabase.js';
import { CONTENT_TABLES } from '../lib/content.js';

const ORDERED = { column: 'display_order', ascending: true } as const;

const selectOrdered = (table: string) =>
  db.from(table).select('*').order(ORDERED.column, { ascending: ORDERED.ascending });

/**
 * Unauthenticated read-only endpoints backing the public landing page and the
 * registration form. Everything here is cacheable and safe to serve to anyone.
 */
export const publicRoutes: FastifyPluginAsync = async (app) => {
  /**
   * Single call for the landing page. Replaces the six separate table reads the
   * browser used to make, which also removes the waterfall on first paint.
   */
  app.get('/content', async (_request, reply) => {
    const [settings, guests, advisors, management, sponsors, brandStalls] = await Promise.all([
      db.from('event_settings').select('event_date, event_end_date').eq('id', 1).maybeSingle(),
      selectOrdered(CONTENT_TABLES.guests!.table),
      selectOrdered(CONTENT_TABLES.advisors!.table),
      selectOrdered(CONTENT_TABLES.management_members!.table),
      selectOrdered(CONTENT_TABLES.sponsors!.table),
      selectOrdered(CONTENT_TABLES.brand_stalls!.table),
    ]);

    reply.header('Cache-Control', 'public, max-age=30, stale-while-revalidate=300');

    return {
      eventDate: settings.data?.event_date ?? null,
      eventEndDate: settings.data?.event_end_date ?? null,
      guests: unwrap(guests, 'load guests'),
      advisors: unwrap(advisors, 'load advisors'),
      management: unwrap(management, 'load management members'),
      sponsors: unwrap(sponsors, 'load sponsors'),
      brandStalls: unwrap(brandStalls, 'load brand stalls'),
    };
  });

  /** Countdown target for the landing page. */
  app.get('/event-settings', async (_request, reply) => {
    const result = await db
      .from('event_settings')
      .select('event_date, event_end_date')
      .eq('id', 1)
      .maybeSingle();
    const data = unwrap(result, 'load event settings');
    reply.header('Cache-Control', 'public, max-age=30, stale-while-revalidate=300');
    return {
      eventDate: data?.event_date ?? null,
      eventEndDate: data?.event_end_date ?? null,
    };
  });

  /**
   * Only active tiers are exposed publicly — the admin dashboard uses its own
   * endpoint to see drafts and retired tiers.
   */
  app.get('/ticket-tiers', async (_request, reply) => {
    const result = await db
      .from('ticket_tiers')
      .select(
        'id, day, start_time, end_time, price, includes_concert, label_en, label_bn, is_active, display_order',
      )
      .eq('is_active', true)
      .order('display_order', { ascending: true });
    reply.header('Cache-Control', 'public, max-age=30, stale-while-revalidate=300');
    return { tiers: unwrap(result, 'load ticket tiers') };
  });
};
