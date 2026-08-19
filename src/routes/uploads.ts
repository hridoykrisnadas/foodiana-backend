import type { FastifyPluginAsync } from 'fastify';
import { requireRole } from '../lib/auth.js';
import { badRequest } from '../lib/errors.js';
import { detectImageType, saveUpload } from '../lib/uploads.js';

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

/**
 * Image upload for the admin dashboard. The returned URL is what goes into a
 * content row's `image_url` / `logo_url`.
 */
export const uploadRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requireRole('admin'));

  app.post('/', async (request, reply) => {
    const file = await request.file({ limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } });
    if (!file) throw badRequest('Expected one file field');

    const buffer = await file.toBuffer();

    // Type comes from the bytes, never from the client's Content-Type.
    const kind = detectImageType(buffer);
    if (!kind) throw badRequest('Only JPEG, PNG and WebP images are accepted');

    const { url } = await saveUpload(buffer, kind);
    request.log.info({ url, bytes: buffer.length, kind }, 'image uploaded');
    return reply.code(201).send({ url });
  });
};
