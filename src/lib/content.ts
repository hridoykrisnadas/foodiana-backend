import { badRequest, notFound } from './errors.js';

/**
 * Registry of the tables the admin content CRUD endpoints may touch.
 *
 * Both the table name and every writable column are whitelisted here. The
 * service-role key bypasses RLS, so this registry is the only thing standing
 * between `PATCH /api/admin/content/:table/:id` and arbitrary writes to any
 * table in the database. Nothing outside this file may widen it.
 */
export type ContentTable = {
  /** Real Postgres table name. */
  table: string;
  /** Columns a client is allowed to insert or update. */
  writable: readonly string[];
  /** Columns that must be non-empty on insert. */
  required: readonly string[];
  /** Legacy single-language columns kept in sync from their `_bn` counterpart. */
  legacyMirror?: Readonly<Record<string, string>>;
};

const IMAGE_FIELDS = ['image_url'] as const;

export const CONTENT_TABLES: Readonly<Record<string, ContentTable>> = {
  guests: {
    table: 'guests',
    writable: [
      'type',
      'name_bn',
      'name_en',
      'designation_bn',
      'designation_en',
      'bio_bn',
      'bio_en',
      'display_order',
      ...IMAGE_FIELDS,
    ],
    required: ['name_bn'],
    // `name` and `designation` are NOT NULL from the original schema.
    legacyMirror: { name: 'name_bn', designation: 'designation_bn' },
  },
  advisors: {
    table: 'advisors',
    writable: [
      'name_bn',
      'name_en',
      'title_bn',
      'title_en',
      'organization_bn',
      'organization_en',
      'display_order',
      ...IMAGE_FIELDS,
    ],
    required: ['name_bn'],
    legacyMirror: { name: 'name_bn', title: 'title_bn' },
  },
  management_members: {
    table: 'management_members',
    writable: [
      'name_bn',
      'name_en',
      'role_bn',
      'role_en',
      'contact',
      'display_order',
      ...IMAGE_FIELDS,
    ],
    required: ['name_bn'],
    legacyMirror: { name: 'name_bn', role: 'role_bn' },
  },
  sponsors: {
    table: 'sponsors',
    writable: [
      'name_bn',
      'name_en',
      'category',
      'category_bn',
      'category_en',
      'logo_url',
      'website',
      'display_order',
    ],
    required: ['name_bn'],
    legacyMirror: { name: 'name_bn' },
  },
  brand_stalls: {
    table: 'brand_stalls',
    writable: [
      'name_bn',
      'name_en',
      'category_bn',
      'category_en',
      'logo_url',
      'display_order',
    ],
    required: ['name_bn'],
    legacyMirror: { name: 'name_bn' },
  },
};

export const CONTENT_TABLE_NAMES = Object.keys(CONTENT_TABLES);

export function resolveContentTable(name: string): ContentTable {
  const entry = CONTENT_TABLES[name];
  if (!entry) {
    throw notFound(
      `Unknown content collection "${name}". Allowed: ${CONTENT_TABLE_NAMES.join(', ')}`,
    );
  }
  return entry;
}

/**
 * Strip a client payload down to the whitelisted columns, normalising empty
 * strings to null and mirroring the legacy NOT NULL columns.
 */
export function sanitizeContentPayload(
  entry: ContentTable,
  body: Record<string, unknown>,
  { partial }: { partial: boolean },
): Record<string, unknown> {
  const payload: Record<string, unknown> = {};

  for (const column of entry.writable) {
    if (!(column in body)) continue;
    const raw = body[column];
    if (column === 'display_order') {
      const parsedOrder = Number(raw);
      if (!Number.isFinite(parsedOrder)) {
        throw badRequest('display_order must be a number');
      }
      payload[column] = Math.trunc(parsedOrder);
      continue;
    }
    payload[column] = typeof raw === 'string' && raw.trim() === '' ? null : raw;
  }

  const rejected = Object.keys(body).filter(
    (key) => !entry.writable.includes(key) && key !== 'id',
  );
  if (rejected.length > 0) {
    throw badRequest(`Unknown field(s) for ${entry.table}: ${rejected.join(', ')}`);
  }

  if (!partial) {
    for (const column of entry.required) {
      if (payload[column] === undefined || payload[column] === null) {
        throw badRequest(`${column} is required`);
      }
    }
  }

  // Keep the pre-bilingual NOT NULL columns populated so inserts don't fail.
  for (const [legacy, source] of Object.entries(entry.legacyMirror ?? {})) {
    if (payload[source] !== undefined && payload[source] !== null) {
      payload[legacy] = payload[source];
    } else if (!partial) {
      payload[legacy] = payload[source] ?? '—';
    }
  }

  if (Object.keys(payload).length === 0) {
    throw badRequest('No writable fields supplied');
  }

  return payload;
}
