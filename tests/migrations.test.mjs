import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { db } from '../dist/db/client.js';
import { runMigrations } from '../dist/db/migrate.js';

const silent = { info() {}, error() {} };

const EXPECTED = [
  'advisors',
  'brand_stalls',
  'event_settings',
  'guests',
  'management_members',
  'sponsors',
  'ticket_tiers',
  'visitors',
];

test('connects to MariaDB', async () => {
  const { rows } = await sql`SELECT VERSION() AS version`.execute(db);
  assert.match(String(rows[0].version), /MariaDB/i, `expected MariaDB, got ${rows[0].version}`);
});

test('migrating an empty database creates every table', async () => {
  await runMigrations(silent);
  const { rows } = await sql`
    SELECT table_name AS name FROM information_schema.tables
    WHERE table_schema = DATABASE()
  `.execute(db);
  const names = rows.map((r) => String(r.name).toLowerCase());
  for (const table of EXPECTED) {
    assert.ok(names.includes(table), `expected table ${table}, saw ${names.join(', ')}`);
  }
});

test('running migrations again applies nothing', async () => {
  const applied = await runMigrations(silent);
  assert.equal(applied.length, 0, 'second run should be a no-op');
});

test('event_settings is seeded with exactly one row', async () => {
  const rows = await db.selectFrom('event_settings').selectAll().execute();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 1);
  assert.equal(rows[0].ground_capacity, 2000);
});

test('the singleton CHECK constraint rejects a second settings row', async () => {
  await assert.rejects(
    () => sql`INSERT INTO event_settings (id, event_date) VALUES (2, '2026-11-05')`.execute(db),
    'MariaDB should refuse id = 2',
  );
});

// The columns holding Bengali are the reason every table is utf8mb4. A latin1
// default would not error here — it would quietly store mojibake.
test('Bengali text round-trips intact', async () => {
  const id = randomUUID();
  await db
    .insertInto('guests')
    .values({
      id,
      type: 'SPECIAL',
      name: 'পরীক্ষা',
      designation: 'অতিথি',
      name_bn: 'পরীক্ষা',
      designation_bn: 'অতিথি',
      display_order: 0,
    })
    .execute();

  const row = await db
    .selectFrom('guests')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirstOrThrow();

  assert.equal(row.name_bn, 'পরীক্ষা', 'Bengali was mangled — check the table charset');
  assert.equal(row.designation_bn, 'অতিথি');

  await db.deleteFrom('guests').where('id', '=', id).execute();
});

test('booleans come back as real booleans, not 0/1', async () => {
  const id = randomUUID();
  await db
    .insertInto('ticket_tiers')
    .values({
      id,
      day: 'Thursday',
      start_time: '11:00',
      end_time: '23:59',
      price: 500,
      includes_concert: true,
      is_active: false,
      display_order: 0,
    })
    .execute();

  const row = await db
    .selectFrom('ticket_tiers')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirstOrThrow();

  assert.equal(row.includes_concert, true, 'TINYINT(1) did not become a boolean');
  assert.equal(row.is_active, false);

  await db.deleteFrom('ticket_tiers').where('id', '=', id).execute();
});

test('a DATE column stays a YYYY-MM-DD string', async () => {
  const row = await db
    .selectFrom('event_settings')
    .select('event_date')
    .where('id', '=', 1)
    .executeTakeFirstOrThrow();
  assert.match(
    String(row.event_date),
    /^\d{4}-\d{2}-\d{2}$/,
    'event_date must stay a plain date string or the public API shape changes',
  );
});

test.after(async () => {
  await db.destroy();
});
