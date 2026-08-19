import type { FastifyPluginAsync } from 'fastify';
import { db } from '../db/client.js';
import type { ContentTableName } from '../db/schema.js';

const CACHE = 'public, max-age=30, stale-while-revalidate=300';

const ordered = (table: ContentTableName) =>
  db.selectFrom(table).selectAll().orderBy('display_order', 'asc').execute();

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
      db
        .selectFrom('event_settings')
        .select(['event_date', 'event_end_date'])
        .where('id', '=', 1)
        .executeTakeFirst(),
      ordered('guests'),
      ordered('advisors'),
      ordered('management_members'),
      ordered('sponsors'),
      ordered('brand_stalls'),
    ]);

    reply.header('Cache-Control', CACHE);

    return {
      eventDate: settings?.event_date ?? null,
      eventEndDate: settings?.event_end_date ?? null,
      guests,
      advisors,
      management,
      sponsors,
      brandStalls,
    };
  });

  /** Countdown target for the landing page. */
  app.get('/event-settings', async (_request, reply) => {
    const data = await db
      .selectFrom('event_settings')
      .select(['event_date', 'event_end_date'])
      .where('id', '=', 1)
      .executeTakeFirst();

    reply.header('Cache-Control', CACHE);
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
    const tiers = await db
      .selectFrom('ticket_tiers')
      .select([
        'id',
        'day',
        'start_time',
        'end_time',
        'price',
        'includes_concert',
        'label_en',
        'label_bn',
        'is_active',
        'display_order',
      ])
      .where('is_active', '=', true)
      .orderBy('display_order', 'asc')
      .execute();

    reply.header('Cache-Control', CACHE);
    return { tiers };
  });
};
