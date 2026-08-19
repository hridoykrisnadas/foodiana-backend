import test from 'node:test';
import assert from 'node:assert/strict';
import { detectImageType } from '../dist/lib/uploads.js';

// A real 1x1 PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')]);

test('detects PNG from magic bytes', () => {
  assert.equal(detectImageType(PNG), 'png');
});

test('detects JPEG from magic bytes', () => {
  assert.equal(detectImageType(JPEG), 'jpeg');
});

test('detects WebP from magic bytes', () => {
  assert.equal(detectImageType(WEBP), 'webp');
});

/*
 * The reason this checks bytes rather than the multipart Content-Type header:
 * that header is supplied by the client, so a script announcing itself as
 * image/png would otherwise be written to a directory the server serves.
 */
test('rejects a script that claims to be an image', () => {
  assert.equal(detectImageType(Buffer.from('<?php system($_GET[0]); ?>')), null);
});

test('rejects an HTML payload', () => {
  assert.equal(detectImageType(Buffer.from('<html><script>alert(1)</script></html>')), null);
});

test('rejects an empty buffer', () => {
  assert.equal(detectImageType(Buffer.alloc(0)), null);
});

test('rejects a buffer too short to identify', () => {
  assert.equal(detectImageType(Buffer.from([0xff, 0xd8])), null);
});

test('rejects a GIF — not in the accepted set', () => {
  assert.equal(detectImageType(Buffer.from('GIF89a01234567')), null);
});
