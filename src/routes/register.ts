import type { FastifyPluginAsync } from 'fastify';
import { randomInt } from 'node:crypto';
import { z } from 'zod';
import { db, UNIQUE_VIOLATION, unwrap } from '../db/supabase.js';
import { env } from '../lib/env.js';
import { badRequest, upstream } from '../lib/errors.js';
import { parseBody } from '../lib/validate.js';

/** Ambiguous glyphs (0/O, 1/I) are excluded so codes survive being read aloud at the gate. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;
const MAX_INSERT_ATTEMPTS = 6;

function generateQrId(): string {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i += 1) {
    code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  }
  return `FDL-${code}`;
}

const registrationSchema = z.object({
  name: z.string().trim().min(2, 'Name must be at least 2 characters').max(120),
  email: z.string().trim().max(180).toLowerCase().pipe(z.email('A valid email is required')),
  mobile: z
    .string()
    .trim()
    .min(10, 'Mobile number must be at least 10 digits')
    .max(20)
    .regex(/^[0-9+\-\s()]+$/, 'Mobile number contains invalid characters'),
  dob: z.iso.date('Date of birth must be YYYY-MM-DD'),
  profession: z.string().trim().min(2, 'Profession is required').max(120),
  ticket_tier_id: z.uuid('A ticket tier must be selected'),
});

export const registerRoutes: FastifyPluginAsync = async (app) => {
  /**
   * Public registration. The client supplies personal details and a tier id and
   * nothing else — price, concert entitlement, QR code, payment status and entry
   * status are all decided here, so none of them can be tampered with.
   */
  app.post(
    '/',
    {
      config: {
        rateLimit: {
          max: env.REGISTER_RATE_LIMIT_MAX,
          timeWindow: env.REGISTER_RATE_LIMIT_WINDOW,
        },
      },
    },
    async (request, reply) => {
      const body = parseBody(registrationSchema, request.body);

      const tierResult = await db
        .from('ticket_tiers')
        .select('id, price, includes_concert, label_en, label_bn, is_active')
        .eq('id', body.ticket_tier_id)
        .maybeSingle();
      const tier = unwrap(tierResult, 'load ticket tier');

      if (!tier) throw badRequest('The selected ticket tier does not exist');
      if (!tier.is_active) throw badRequest('The selected ticket tier is no longer on sale');

      // The unique index on qr_code_id is the arbiter, so concurrent workers
      // cannot hand out the same code — a collision just costs one retry.
      for (let attempt = 1; attempt <= MAX_INSERT_ATTEMPTS; attempt += 1) {
        const qrCodeId = generateQrId();
        const { data, error } = await db
          .from('visitors')
          .insert({
            qr_code_id: qrCodeId,
            name: body.name,
            email: body.email,
            mobile: body.mobile,
            dob: body.dob,
            profession: body.profession,
            payment_status: 'Pending',
            entry_status: false,
            exited_status: false,
            ticket_tier_id: tier.id,
            ticket_price: tier.price,
            includes_concert: tier.includes_concert,
          })
          .select('id, qr_code_id, name, ticket_price, includes_concert')
          .single();

        if (!error && data) {
          request.log.info({ qrCodeId: data.qr_code_id, tierId: tier.id }, 'visitor registered');
          return reply.code(201).send({
            qr_code_id: data.qr_code_id,
            name: data.name,
            price: data.ticket_price,
            includes_concert: data.includes_concert,
            label_en: tier.label_en,
            label_bn: tier.label_bn,
          });
        }

        if (error?.code === UNIQUE_VIOLATION) {
          request.log.warn({ attempt, qrCodeId }, 'qr code collision, retrying');
          continue;
        }

        throw upstream('Registration failed', { code: error?.code, message: error?.message });
      }

      throw upstream(
        `Could not allocate a unique QR code after ${MAX_INSERT_ATTEMPTS} attempts`,
      );
    },
  );
};
