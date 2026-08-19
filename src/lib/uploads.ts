import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { env } from './env.js';

export type ImageKind = 'jpeg' | 'png' | 'webp';

const EXTENSIONS: Record<ImageKind, string> = {
  jpeg: '.jpg',
  png: '.png',
  webp: '.webp',
};

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Identify an image by its magic bytes.
 *
 * The multipart Content-Type header is supplied by the client and is therefore
 * worthless as a security control — a PHP script announcing itself as image/png
 * would pass. Sniffing the actual bytes is what stops that reaching a directory
 * the server hands back over HTTP.
 */
export function detectImageType(buffer: Buffer): ImageKind | null {
  if (buffer.length < 12) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpeg';
  if (buffer.subarray(0, 8).equals(PNG_MAGIC)) return 'png';
  if (
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'webp';
  }
  return null;
}

/**
 * Resolved once, absolutely, so the boot log can show exactly where files land.
 *
 * On Hostinger this must sit outside the versioned build directory
 * (.../hbuilds/versions/<uuid>/nodejs/). A path inside it works perfectly until
 * the next deploy creates a new version directory and every uploaded image is
 * gone — a failure that is invisible until long after the mistake.
 */
export const uploadDir = path.resolve(env.UPLOAD_DIR);

export async function ensureUploadDir(): Promise<string> {
  await mkdir(uploadDir, { recursive: true });
  return uploadDir;
}

/**
 * Write an upload under a generated name. The client's filename is never used in
 * the path — it is attacker-controlled and the usual source of traversal bugs.
 */
export async function saveUpload(
  buffer: Buffer,
  kind: ImageKind,
): Promise<{ filename: string; url: string }> {
  await ensureUploadDir();
  const filename = `${randomUUID()}${EXTENSIONS[kind]}`;
  await writeFile(path.join(uploadDir, filename), buffer);
  return { filename, url: `/uploads/${filename}` };
}
