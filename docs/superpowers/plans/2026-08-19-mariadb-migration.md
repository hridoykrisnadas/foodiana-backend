# MariaDB Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Supabase Postgres with Hostinger MariaDB as the API's only datastore, apply migrations automatically at startup, and store uploaded photos on the server's disk.

**Architecture:** A `mysql2` connection pool wrapped in a `kysely` typed query builder replaces the supabase-js client. The three plpgsql functions become TypeScript transactions; the gate's capacity ceiling is held by a `FOR UPDATE` row lock on the `event_settings` singleton instead of a Postgres advisory lock. Kysely's `Migrator` runs pending migrations on boot before the server listens.

**Tech Stack:** Node 22, TypeScript, Fastify 5, Kysely 0.29, mysql2 3.23, MariaDB 11.8, `node:test` (built in, no new dependency).

**Spec:** `docs/superpowers/specs/2026-08-19-mariadb-migration-design.md`

## Global Constraints

Every task's requirements implicitly include this section.

- **Target MariaDB 11.8.8.** No MySQL-8-only syntax. No `uuid` column type — use `CHAR(36)`.
- **All tables and text columns must be `utf8mb4` / `utf8mb4_unicode_ci`.** The `*_bn` columns hold Bengali; the default `latin1` on an older server would corrupt them silently.
- **MariaDB has no transactional DDL.** Migrations cannot roll back. Keep each migration one coherent unit.
- **Anything needed at build or runtime goes in `dependencies`, never `devDependencies`.** Hostinger installs with `--omit=dev`. This has already caused one production outage.
- **Response shapes must stay byte-identical.** The frontend is a separate repo and is not being changed. `dob` and `event_date` must serialise as `YYYY-MM-DD` strings, not ISO datetimes.
- **Gate status strings are a fixed contract:** `not_found`, `already_inside`, `already_exited`, `capacity_full`, `admitted`, `not_entered`, `exited`. Renaming any of them breaks the scanner UI.
- **`UPLOAD_DIR` must resolve outside the app directory.** On Hostinger the app runs from `…/hbuilds/versions/<uuid>/nodejs/`, a new directory per deploy.
- Run `npm run build` before any test task — tests import from `dist/`.

---

### Task 1: Dependencies, config, and a MariaDB to develop against

Establishes the database everything else needs. Ends with a green connectivity test.

**Files:**
- Modify: `package.json`
- Modify: `src/lib/env.ts`
- Modify: `.env.example`
- Modify: `docker-compose.yml`
- Modify: `.github/workflows/ci.yml`
- Create: `tests/db-connect.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: env vars `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`, `DB_POOL_SIZE`, `UPLOAD_DIR` on the `env` export.

- [ ] **Step 1: Install the runtime dependencies**

```bash
npm install kysely@^0.29.5 mysql2@^3.23.3
```

Verify both landed in `dependencies` (not `devDependencies`) in `package.json`.

- [ ] **Step 2: Add the database settings to the env schema**

In `src/lib/env.ts`, inside `envSchema`, replace the two Supabase lines:

```ts
  SUPABASE_URL: z.string().url('SUPABASE_URL must be a valid URL'),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20, 'SUPABASE_SERVICE_ROLE_KEY looks too short'),
```

with:

```ts
  DB_HOST: z.string().min(1, 'DB_HOST is required'),
  DB_PORT: z.coerce.number().int().min(1).max(65535).default(3306),
  DB_USER: z.string().min(1, 'DB_USER is required'),
  DB_PASSWORD: z.string().default(''),
  DB_NAME: z.string().min(1, 'DB_NAME is required'),
  DB_POOL_SIZE: z.coerce.number().int().min(1).max(100).default(10),

  /**
   * Absolute path for uploaded photos. On Hostinger this MUST be outside the
   * versioned build directory (…/hbuilds/versions/<uuid>/nodejs/) or every
   * deploy silently discards every uploaded image.
   */
  UPLOAD_DIR: z.string().min(1).default('./uploads'),
```

- [ ] **Step 3: Update `.env.example`**

Replace the `# ---- Supabase ----` block with:

```
# ---- Database (MariaDB) ------------------------------------------------------
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=foodiana
DB_PASSWORD=foodiana
DB_NAME=foodiana
DB_POOL_SIZE=10

# ---- Uploads -----------------------------------------------------------------
# Absolute path in production. On Hostinger this MUST live outside the versioned
# build directory, e.g. /home/<user>/domains/api.foodianafest.com/uploads —
# anything inside the app directory is wiped by the next deploy.
UPLOAD_DIR=./uploads
```

- [ ] **Step 4: Add MariaDB to `docker-compose.yml`**

Add this service, and add `DB_*` to the `backend` service's `environment` block pointing at it:

```yaml
  db:
    image: mariadb:11.8
    environment:
      MARIADB_ROOT_PASSWORD: ${DB_ROOT_PASSWORD:-root}
      MARIADB_DATABASE: ${DB_NAME:-foodiana}
      MARIADB_USER: ${DB_USER:-foodiana}
      MARIADB_PASSWORD: ${DB_PASSWORD:-foodiana}
    command: >
      --character-set-server=utf8mb4
      --collation-server=utf8mb4_unicode_ci
    ports:
      - '${DB_PORT:-3306}:3306'
    volumes:
      - db-data:/var/lib/mysql
    healthcheck:
      test: ['CMD', 'healthcheck.sh', '--connect', '--innodb_initialized']
      interval: 10s
      timeout: 5s
      retries: 10

volumes:
  db-data:
```

In the `backend` service add `depends_on: { db: { condition: service_healthy } }` and these environment entries:

```yaml
      DB_HOST: db
      DB_PORT: '3306'
      DB_USER: ${DB_USER:-foodiana}
      DB_PASSWORD: ${DB_PASSWORD:-foodiana}
      DB_NAME: ${DB_NAME:-foodiana}
      UPLOAD_DIR: /data/uploads
```

- [ ] **Step 5: Add a MariaDB service container to CI**

In `.github/workflows/ci.yml`, add to **both** the `build` job and the `deploy-simulation` job, at the job level (a sibling of `steps:`):

```yaml
    services:
      mariadb:
        image: mariadb:11.8
        env:
          MARIADB_ROOT_PASSWORD: root
          MARIADB_DATABASE: foodiana_test
          MARIADB_USER: foodiana
          MARIADB_PASSWORD: foodiana
        ports:
          - 3306:3306
        options: >-
          --health-cmd="healthcheck.sh --connect --innodb_initialized"
          --health-interval=10s --health-timeout=5s --health-retries=10
```

Then in every step that runs the app or tests, replace the two `SUPABASE_*` env entries with:

```yaml
          DB_HOST: 127.0.0.1
          DB_PORT: '3306'
          DB_USER: foodiana
          DB_PASSWORD: foodiana
          DB_NAME: foodiana_test
          UPLOAD_DIR: /tmp/foodiana-uploads
```

- [ ] **Step 6: Write the failing connectivity test**

Create `tests/db-connect.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../dist/db/client.js';

test('connects to MariaDB and reports a version', async () => {
  const rows = await db.executeQuery({
    sql: 'SELECT VERSION() AS version',
    parameters: [],
    query: { kind: 'RawNode' },
  });
  const version = rows.rows[0].version;
  assert.match(version, /MariaDB/i, `expected MariaDB, got ${version}`);
});

test('the connection uses utf8mb4 so Bengali text survives', async () => {
  const rows = await db.executeQuery({
    sql: "SELECT @@character_set_client AS cs",
    parameters: [],
    query: { kind: 'RawNode' },
  });
  assert.equal(rows.rows[0].cs, 'utf8mb4');
});

test.after(async () => { await db.destroy(); });
```

Add to `package.json` scripts: `"test": "node --test tests/"`.

- [ ] **Step 7: Run it and watch it fail**

```bash
docker compose up -d db
npm run build && npm test
```
Expected: FAIL — `Cannot find module '../dist/db/client.js'`. That module is Task 2.

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json src/lib/env.ts .env.example docker-compose.yml .github/workflows/ci.yml tests/db-connect.test.mjs
git commit -m "feat: add MariaDB config, dependencies and a database to develop against"
```

---

### Task 2: The client, the schema types, and the initial migration

**Files:**
- Create: `src/db/client.ts`
- Create: `src/db/schema.ts`
- Create: `src/migrations/001_initial_schema.ts`
- Create: `src/db/migrate.ts`
- Create: `tests/migrations.test.mjs`
- Modify: `src/index.ts`

**Interfaces:**
- Consumes: `env` from Task 1.
- Produces: `db` (a `Kysely<Database>`), the `Database` interface, `runMigrations(logger): Promise<string[]>`.

- [ ] **Step 1: Write the schema types**

Create `src/db/schema.ts`:

```ts
import type { ColumnType, Generated } from 'kysely';

/** DATETIME(3), always stored and read as UTC. */
type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;

/**
 * DATE columns. mysql2 is configured with `dateStrings: ['DATE']` so these come
 * back as 'YYYY-MM-DD', matching what the frontend already receives. Letting
 * them become Date objects would serialise as full ISO datetimes and change the
 * public API shape.
 */
type DateOnly = string;

export interface VisitorsTable {
  id: string;
  qr_code_id: string;
  name: string;
  email: string;
  mobile: string;
  dob: DateOnly;
  profession: string;
  payment_status: string;
  entry_status: boolean;
  payment_method: string | null;
  checked_in_at: Timestamp | null;
  created_at: Generated<Timestamp>;
  ticket_tier_id: string | null;
  ticket_price: number | null;
  includes_concert: boolean;
  exited_status: boolean;
  exited_at: Timestamp | null;
}

export interface EventSettingsTable {
  id: number;
  event_date: DateOnly;
  event_end_date: DateOnly | null;
  ground_capacity: number;
  updated_at: Generated<Timestamp>;
}

export interface TicketTiersTable {
  id: string;
  day: string;
  start_time: string;
  end_time: string;
  price: number;
  includes_concert: boolean;
  label_en: string | null;
  label_bn: string | null;
  is_active: boolean;
  display_order: number;
  created_at: Generated<Timestamp>;
}

export interface GuestsTable {
  id: string;
  type: string;
  name: string;
  designation: string;
  image_url: string | null;
  bio: string | null;
  name_bn: string | null;
  name_en: string | null;
  designation_bn: string | null;
  designation_en: string | null;
  bio_bn: string | null;
  bio_en: string | null;
  display_order: number;
  created_at: Generated<Timestamp>;
}

export interface AdvisorsTable {
  id: string;
  name: string;
  title: string;
  organization: string | null;
  image_url: string | null;
  name_bn: string | null;
  name_en: string | null;
  title_bn: string | null;
  title_en: string | null;
  organization_bn: string | null;
  organization_en: string | null;
  display_order: number;
  created_at: Generated<Timestamp>;
}

export interface ManagementMembersTable {
  id: string;
  name: string;
  role: string;
  contact: string | null;
  image_url: string | null;
  name_bn: string | null;
  name_en: string | null;
  role_bn: string | null;
  role_en: string | null;
  display_order: number;
  created_at: Generated<Timestamp>;
}

export interface SponsorsTable {
  id: string;
  name: string;
  category: string;
  logo_url: string | null;
  website: string | null;
  name_bn: string | null;
  name_en: string | null;
  category_bn: string | null;
  category_en: string | null;
  display_order: number;
  created_at: Generated<Timestamp>;
}

export interface BrandStallsTable {
  id: string;
  name: string;
  category: string;
  logo_url: string | null;
  name_bn: string | null;
  name_en: string | null;
  category_bn: string | null;
  category_en: string | null;
  display_order: number;
  created_at: Generated<Timestamp>;
}

export interface Database {
  visitors: VisitorsTable;
  event_settings: EventSettingsTable;
  ticket_tiers: TicketTiersTable;
  guests: GuestsTable;
  advisors: AdvisorsTable;
  management_members: ManagementMembersTable;
  sponsors: SponsorsTable;
  brand_stalls: BrandStallsTable;
}
```

- [ ] **Step 2: Write the client**

Create `src/db/client.ts`:

```ts
import { Kysely, MysqlDialect } from 'kysely';
import { createPool } from 'mysql2';
import { env } from '../lib/env.js';
import { upstream } from '../lib/errors.js';
import type { Database } from './schema.js';

/** MariaDB duplicate-key error. Replaces the Postgres 23505 checks. */
export const DUPLICATE_ENTRY = 1062;

const pool = createPool({
  host: env.DB_HOST,
  port: env.DB_PORT,
  user: env.DB_USER,
  password: env.DB_PASSWORD,
  database: env.DB_NAME,
  connectionLimit: env.DB_POOL_SIZE,
  charset: 'utf8mb4',
  // DATETIME columns are stored UTC; without this mysql2 applies the server's
  // local offset and timestamps drift.
  timezone: 'Z',
  // Keep DATE as 'YYYY-MM-DD'. Becoming a Date here would change dob and
  // event_date in every public response.
  dateStrings: ['DATE'],
  // TINYINT(1) is our boolean. mysql2 hands back 0/1 without this, which would
  // make `entry_status === true` quietly false everywhere.
  typeCast(field, next) {
    if (field.type === 'TINY' && field.length === 1) {
      const value = field.string();
      return value === null ? null : value === '1';
    }
    return next();
  },
});

export const db = new Kysely<Database>({ dialect: new MysqlDialect({ pool }) });

export function isDuplicateEntry(error: unknown): boolean {
  return (error as { errno?: number }).errno === DUPLICATE_ENTRY;
}
```

Do not add a general `dbError` wrapper. The existing global error handler in
`src/server.ts` already turns an unhandled throw into a 500, and the routes that
need a 502 call `upstream()` directly. An unused wrapper is dead code.

The `upstream` import is therefore not needed in this file — drop it.

- [ ] **Step 3: Write the initial migration**

Create `src/migrations/001_initial_schema.ts`. `ticket_tiers` must come first — `visitors` has a foreign key to it.

```ts
import { sql, type Kysely } from 'kysely';

const TABLE_OPTIONS = sql`ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS ticket_tiers (
      id               CHAR(36)     NOT NULL PRIMARY KEY,
      day              VARCHAR(16)  NOT NULL,
      start_time       VARCHAR(5)   NOT NULL,
      end_time         VARCHAR(5)   NOT NULL,
      price            INT          NOT NULL,
      includes_concert TINYINT(1)   NOT NULL DEFAULT 0,
      label_en         VARCHAR(120) NULL,
      label_bn         VARCHAR(120) NULL,
      is_active        TINYINT(1)   NOT NULL DEFAULT 1,
      display_order    INT          NOT NULL DEFAULT 0,
      created_at       DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      KEY idx_ticket_tiers_active (is_active, display_order)
    ) ${TABLE_OPTIONS}
  `.execute(db);

  await sql`
    CREATE TABLE IF NOT EXISTS visitors (
      id               CHAR(36)     NOT NULL PRIMARY KEY,
      qr_code_id       VARCHAR(64)  NOT NULL,
      name             VARCHAR(120) NOT NULL,
      email            VARCHAR(180) NOT NULL,
      mobile           VARCHAR(20)  NOT NULL,
      dob              DATE         NOT NULL,
      profession       VARCHAR(120) NOT NULL,
      payment_status   VARCHAR(16)  NOT NULL DEFAULT 'Pending',
      entry_status     TINYINT(1)   NOT NULL DEFAULT 0,
      payment_method   VARCHAR(16)  NULL,
      checked_in_at    DATETIME(3)  NULL,
      created_at       DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      ticket_tier_id   CHAR(36)     NULL,
      ticket_price     INT          NULL,
      includes_concert TINYINT(1)   NOT NULL DEFAULT 0,
      exited_status    TINYINT(1)   NOT NULL DEFAULT 0,
      exited_at        DATETIME(3)  NULL,
      UNIQUE KEY uq_visitors_qr_code_id (qr_code_id),
      KEY idx_visitors_occupancy (entry_status, exited_status),
      KEY idx_visitors_payment_status (payment_status),
      KEY idx_visitors_created_at (created_at),
      CONSTRAINT fk_visitors_ticket_tier
        FOREIGN KEY (ticket_tier_id) REFERENCES ticket_tiers (id)
    ) ${TABLE_OPTIONS}
  `.execute(db);

  await sql`
    CREATE TABLE IF NOT EXISTS event_settings (
      id              INT         NOT NULL PRIMARY KEY,
      event_date      DATE        NOT NULL,
      event_end_date  DATE        NULL,
      ground_capacity INT         NOT NULL DEFAULT 2000,
      updated_at      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      CONSTRAINT chk_event_settings_singleton CHECK (id = 1)
    ) ${TABLE_OPTIONS}
  `.execute(db);

  await sql`
    INSERT IGNORE INTO event_settings (id, event_date, ground_capacity)
    VALUES (1, '2026-11-05', 2000)
  `.execute(db);

  await sql`
    CREATE TABLE IF NOT EXISTS guests (
      id               CHAR(36)     NOT NULL PRIMARY KEY,
      type             VARCHAR(16)  NOT NULL DEFAULT 'SPECIAL',
      name             VARCHAR(160) NOT NULL,
      designation      VARCHAR(160) NOT NULL,
      image_url        VARCHAR(512) NULL,
      bio              TEXT         NULL,
      name_bn          VARCHAR(160) NULL,
      name_en          VARCHAR(160) NULL,
      designation_bn   VARCHAR(160) NULL,
      designation_en   VARCHAR(160) NULL,
      bio_bn           TEXT         NULL,
      bio_en           TEXT         NULL,
      display_order    INT          NOT NULL DEFAULT 0,
      created_at       DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      KEY idx_guests_display_order (display_order),
      CONSTRAINT chk_guests_type CHECK (type IN ('CHIEF', 'SPECIAL'))
    ) ${TABLE_OPTIONS}
  `.execute(db);

  await sql`
    CREATE TABLE IF NOT EXISTS advisors (
      id               CHAR(36)     NOT NULL PRIMARY KEY,
      name             VARCHAR(160) NOT NULL,
      title            VARCHAR(160) NOT NULL,
      organization     VARCHAR(160) NULL,
      image_url        VARCHAR(512) NULL,
      name_bn          VARCHAR(160) NULL,
      name_en          VARCHAR(160) NULL,
      title_bn         VARCHAR(160) NULL,
      title_en         VARCHAR(160) NULL,
      organization_bn  VARCHAR(160) NULL,
      organization_en  VARCHAR(160) NULL,
      display_order    INT          NOT NULL DEFAULT 0,
      created_at       DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      KEY idx_advisors_display_order (display_order)
    ) ${TABLE_OPTIONS}
  `.execute(db);

  await sql`
    CREATE TABLE IF NOT EXISTS management_members (
      id            CHAR(36)     NOT NULL PRIMARY KEY,
      name          VARCHAR(160) NOT NULL,
      role          VARCHAR(160) NOT NULL,
      contact       VARCHAR(160) NULL,
      image_url     VARCHAR(512) NULL,
      name_bn       VARCHAR(160) NULL,
      name_en       VARCHAR(160) NULL,
      role_bn       VARCHAR(160) NULL,
      role_en       VARCHAR(160) NULL,
      display_order INT          NOT NULL DEFAULT 0,
      created_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      KEY idx_management_members_display_order (display_order)
    ) ${TABLE_OPTIONS}
  `.execute(db);

  await sql`
    CREATE TABLE IF NOT EXISTS sponsors (
      id            CHAR(36)     NOT NULL PRIMARY KEY,
      name          VARCHAR(160) NOT NULL,
      category      VARCHAR(16)  NOT NULL DEFAULT 'PARTNER',
      logo_url      VARCHAR(512) NULL,
      website       VARCHAR(512) NULL,
      name_bn       VARCHAR(160) NULL,
      name_en       VARCHAR(160) NULL,
      category_bn   VARCHAR(64)  NULL,
      category_en   VARCHAR(64)  NULL,
      display_order INT          NOT NULL DEFAULT 0,
      created_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      KEY idx_sponsors_display_order (display_order),
      CONSTRAINT chk_sponsors_category CHECK (category IN ('TITLE', 'CO', 'PARTNER'))
    ) ${TABLE_OPTIONS}
  `.execute(db);

  await sql`
    CREATE TABLE IF NOT EXISTS brand_stalls (
      id            CHAR(36)     NOT NULL PRIMARY KEY,
      name          VARCHAR(160) NOT NULL,
      category      VARCHAR(64)  NOT NULL DEFAULT 'FOOD',
      logo_url      VARCHAR(512) NULL,
      name_bn       VARCHAR(160) NULL,
      name_en       VARCHAR(160) NULL,
      category_bn   VARCHAR(64)  NULL,
      category_en   VARCHAR(64)  NULL,
      display_order INT          NOT NULL DEFAULT 0,
      created_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      KEY idx_brand_stalls_display_order (display_order)
    ) ${TABLE_OPTIONS}
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const table of [
    'brand_stalls', 'sponsors', 'management_members', 'advisors', 'guests',
    'event_settings', 'visitors', 'ticket_tiers',
  ]) {
    await sql`DROP TABLE IF EXISTS ${sql.raw(table)}`.execute(db);
  }
}
```

- [ ] **Step 4: Write the migration runner**

Create `src/db/migrate.ts`:

```ts
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FileMigrationProvider, Migrator } from 'kysely';
import { db } from './client.js';

/**
 * Applies pending migrations. Called on boot before the server listens, so a
 * forgotten migration is structurally impossible — which is exactly the failure
 * that left the previous database completely empty.
 *
 * Kysely serialises concurrent runners through `kysely_migration_lock`, so
 * several replicas starting at once cannot race.
 *
 * Note: MariaDB has no transactional DDL. A migration that fails partway leaves
 * partial state and is recorded as unapplied, so a retry re-runs it — every
 * statement is written to tolerate that.
 */
export async function runMigrations(
  log: { info: (o: object, m: string) => void; error: (o: object, m: string) => void },
): Promise<string[]> {
  const migrationFolder = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'migrations',
  );

  const migrator = new Migrator({
    db,
    provider: new FileMigrationProvider({ fs, path, migrationFolder }),
  });

  const { error, results } = await migrator.migrateToLatest();

  for (const result of results ?? []) {
    if (result.status === 'Success') {
      log.info({ migration: result.migrationName }, 'migration applied');
    } else if (result.status === 'Error') {
      log.error({ migration: result.migrationName }, 'migration FAILED');
    }
  }

  if (error) throw error;
  return (results ?? []).map((r) => r.migrationName);
}
```

- [ ] **Step 5: Run migrations on boot**

In `src/index.ts`, inside `main()`, immediately before `await app.listen(...)`:

```ts
  try {
    const applied = await runMigrations(app.log);
    app.log.info({ count: applied.length }, 'database migrations up to date');
  } catch (error) {
    app.log.error({ err: error }, 'migrations failed — refusing to serve');
    process.exit(1);
  }
```

Add the import: `import { runMigrations } from './db/migrate.js';`

A half-migrated database must never serve traffic. Failing to start is loud and visible in Hostinger's logs; serving wrong data is not.

- [ ] **Step 6: Write the migration test**

Create `tests/migrations.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db } from '../dist/db/client.js';
import { runMigrations } from '../dist/db/migrate.js';

const silent = { info() {}, error() {} };

const EXPECTED = [
  'advisors', 'brand_stalls', 'event_settings', 'guests',
  'management_members', 'sponsors', 'ticket_tiers', 'visitors',
];

test('migrating an empty database creates every table', async () => {
  await runMigrations(silent);
  const { rows } = await db.executeQuery({
    sql: 'SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE()',
    parameters: [],
    query: { kind: 'RawNode' },
  });
  const names = rows.map((r) => String(r.name).toLowerCase());
  for (const table of EXPECTED) {
    assert.ok(names.includes(table), `expected table ${table}, saw ${names.join(', ')}`);
  }
});

test('running migrations again is a no-op', async () => {
  const applied = await runMigrations(silent);
  assert.equal(applied.length, 0, 'second run should apply nothing');
});

test('event_settings is seeded with exactly one row', async () => {
  const row = await db.selectFrom('event_settings').selectAll().executeTakeFirstOrThrow();
  assert.equal(row.id, 1);
  assert.equal(row.ground_capacity, 2000);
});

test('Bengali text round-trips through utf8mb4', async () => {
  const id = randomUUID();
  await db.insertInto('guests').values({
    id, type: 'SPECIAL', name: 'পরীক্ষা', designation: 'অতিথি',
    name_bn: 'পরীক্ষা', display_order: 0,
  }).execute();
  const row = await db.selectFrom('guests').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
  assert.equal(row.name_bn, 'পরীক্ষা', 'Bengali text was mangled — check the charset');
  await db.deleteFrom('guests').where('id', '=', id).execute();
});

test.after(async () => { await db.destroy(); });
```

- [ ] **Step 7: Run the tests**

```bash
docker compose up -d db && npm run build && npm test
```
Expected: all tests in `db-connect.test.mjs` and `migrations.test.mjs` PASS.

- [ ] **Step 8: Commit**

```bash
git add src/db/client.ts src/db/schema.ts src/db/migrate.ts src/migrations/ src/index.ts tests/
git commit -m "feat: add the MariaDB client, schema types and boot-time migrations"
```

---

### Task 3: The gate — atomic admission and exit

The highest-risk task. The capacity ceiling is the one guarantee that must not regress.

**Files:**
- Create: `src/db/gate.ts`
- Create: `tests/gate-concurrency.test.mjs`

**Interfaces:**
- Consumes: `db` from Task 2.
- Produces:
  - `admitVisitor(id: string, paymentMethod?: string | null): Promise<GateOutcome>`
  - `exitVisitor(id: string): Promise<GateOutcome>`
  - `type GateOutcome = { status: 'not_found' | 'already_inside' | 'already_exited' | 'capacity_full' | 'admitted' | 'not_entered' | 'exited'; visitor?: Visitor; inside_now?: number; capacity?: number }`

The `visitor`, `inside_now` and `capacity` field names are consumed verbatim by `scan.ts` and `admin.ts`. Do not rename them.

- [ ] **Step 1: Write the failing concurrency test**

Create `tests/gate-concurrency.test.mjs`. This is the test that protects event night:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db } from '../dist/db/client.js';
import { runMigrations } from '../dist/db/migrate.js';
import { admitVisitor, exitVisitor } from '../dist/db/gate.js';

const silent = { info() {}, error() {} };

async function seedVisitor(overrides = {}) {
  const id = randomUUID();
  await db.insertInto('visitors').values({
    id,
    qr_code_id: `FDL-${id.slice(0, 6).toUpperCase()}`,
    name: 'Test', email: 't@example.com', mobile: '01700000000',
    dob: '1995-01-01', profession: 'Tester',
    payment_status: 'Pending', entry_status: false, exited_status: false,
    includes_concert: false,
    ...overrides,
  }).execute();
  return id;
}

test.before(async () => {
  await runMigrations(silent);
  await db.deleteFrom('visitors').execute();
});

test('admits a visitor and reports occupancy', async () => {
  await db.deleteFrom('visitors').execute();
  await db.updateTable('event_settings').set({ ground_capacity: 10 }).where('id', '=', 1).execute();
  const id = await seedVisitor();
  const outcome = await admitVisitor(id, 'Cash');
  assert.equal(outcome.status, 'admitted');
  assert.equal(outcome.inside_now, 1);
});

test('rejects a second admission of the same visitor', async () => {
  const id = await seedVisitor({ entry_status: true });
  assert.equal((await admitVisitor(id)).status, 'already_inside');
});

test('rejects admission of someone who already left', async () => {
  const id = await seedVisitor({ entry_status: true, exited_status: true });
  assert.equal((await admitVisitor(id)).status, 'already_exited');
});

test('reports not_found for an unknown id', async () => {
  assert.equal((await admitVisitor(randomUUID())).status, 'not_found');
});

test('exit requires a prior entry', async () => {
  const id = await seedVisitor();
  assert.equal((await exitVisitor(id)).status, 'not_entered');
});

test('exit frees a slot', async () => {
  await db.deleteFrom('visitors').execute();
  const id = await seedVisitor();
  await admitVisitor(id);
  const outcome = await exitVisitor(id);
  assert.equal(outcome.status, 'exited');
  assert.equal(outcome.inside_now, 0);
});

// The one that matters. Without the FOR UPDATE row lock, several of these
// concurrent admissions all read the same occupancy and all pass the check.
test('exactly one admission wins the last slot under concurrency', async () => {
  await db.deleteFrom('visitors').execute();
  const CAPACITY = 5;
  await db.updateTable('event_settings')
    .set({ ground_capacity: CAPACITY }).where('id', '=', 1).execute();

  // Fill to capacity - 1.
  for (let i = 0; i < CAPACITY - 1; i += 1) {
    await seedVisitor({ entry_status: true });
  }

  // 20 people scan simultaneously for a single remaining slot.
  const contenders = [];
  for (let i = 0; i < 20; i += 1) contenders.push(await seedVisitor());
  const outcomes = await Promise.all(contenders.map((id) => admitVisitor(id)));

  const admitted = outcomes.filter((o) => o.status === 'admitted');
  const full = outcomes.filter((o) => o.status === 'capacity_full');

  assert.equal(admitted.length, 1, `expected exactly 1 admission, got ${admitted.length}`);
  assert.equal(full.length, 19);

  const { count } = await db.selectFrom('visitors')
    .select((eb) => eb.fn.countAll().as('count'))
    .where('entry_status', '=', true).where('exited_status', '=', false)
    .executeTakeFirstOrThrow();
  assert.equal(Number(count), CAPACITY, 'occupancy exceeded capacity');
});

test.after(async () => { await db.destroy(); });
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npm run build && node --test tests/gate-concurrency.test.mjs
```
Expected: FAIL — `Cannot find module '../dist/db/gate.js'`.

- [ ] **Step 3: Implement the gate**

Create `src/db/gate.ts`:

```ts
import { db } from './client.js';
import type { VisitorsTable } from './schema.js';

export type Visitor = Omit<VisitorsTable, 'created_at'> & { created_at: Date };

export type GateOutcome = {
  status:
    | 'not_found' | 'already_inside' | 'already_exited'
    | 'capacity_full' | 'admitted' | 'not_entered' | 'exited';
  visitor?: Visitor;
  inside_now?: number;
  capacity?: number;
};

export const DEFAULT_CAPACITY = 2000;

/**
 * Admit a visitor, enforcing the venue capacity atomically.
 *
 * The `FOR UPDATE` on the event_settings singleton is what makes this correct:
 * it serialises every concurrent admission for the life of the transaction, so
 * two gates scanning at once cannot both pass a check at capacity - 1. It is
 * taken on a row the transaction must read anyway, and MariaDB releases it on
 * commit or rollback — unlike GET_LOCK(), which is session-scoped and can be
 * stranded by a pooled connection dying mid-scan.
 *
 * Removing `.forUpdate()` makes tests/gate-concurrency.test.mjs fail. That is
 * intentional.
 */
export async function admitVisitor(
  id: string,
  paymentMethod?: string | null,
): Promise<GateOutcome> {
  return db.transaction().execute(async (trx) => {
    const settings = await trx
      .selectFrom('event_settings')
      .select('ground_capacity')
      .where('id', '=', 1)
      .forUpdate()
      .executeTakeFirst();

    const capacity = Number(settings?.ground_capacity ?? DEFAULT_CAPACITY) || DEFAULT_CAPACITY;

    const visitor = await trx
      .selectFrom('visitors').selectAll().where('id', '=', id)
      .forUpdate().executeTakeFirst();

    if (!visitor) return { status: 'not_found' };
    if (visitor.exited_status) return { status: 'already_exited', visitor, capacity };
    if (visitor.entry_status) return { status: 'already_inside', visitor, capacity };

    const { inside } = await trx
      .selectFrom('visitors')
      .select((eb) => eb.fn.countAll().as('inside'))
      .where('entry_status', '=', true)
      .where('exited_status', '=', false)
      .executeTakeFirstOrThrow();

    const insideNow = Number(inside);
    if (insideNow >= capacity) {
      return { status: 'capacity_full', visitor, inside_now: insideNow, capacity };
    }

    const now = new Date();
    await trx.updateTable('visitors')
      .set({
        entry_status: true,
        checked_in_at: now,
        payment_status: 'Paid',
        ...(paymentMethod ? { payment_method: paymentMethod } : {}),
      })
      .where('id', '=', id)
      .execute();

    const updated = await trx.selectFrom('visitors').selectAll()
      .where('id', '=', id).executeTakeFirstOrThrow();

    return { status: 'admitted', visitor: updated, inside_now: insideNow + 1, capacity };
  });
}

/** Record a visitor leaving. Same locking discipline, no capacity check. */
export async function exitVisitor(id: string): Promise<GateOutcome> {
  return db.transaction().execute(async (trx) => {
    const settings = await trx
      .selectFrom('event_settings').select('ground_capacity')
      .where('id', '=', 1).forUpdate().executeTakeFirst();

    const capacity = Number(settings?.ground_capacity ?? DEFAULT_CAPACITY) || DEFAULT_CAPACITY;

    const visitor = await trx
      .selectFrom('visitors').selectAll().where('id', '=', id)
      .forUpdate().executeTakeFirst();

    if (!visitor) return { status: 'not_found' };
    if (visitor.exited_status) return { status: 'already_exited', visitor, capacity };
    if (!visitor.entry_status) return { status: 'not_entered', visitor, capacity };

    await trx.updateTable('visitors')
      .set({ exited_status: true, exited_at: new Date() })
      .where('id', '=', id).execute();

    const { inside } = await trx
      .selectFrom('visitors')
      .select((eb) => eb.fn.countAll().as('inside'))
      .where('entry_status', '=', true).where('exited_status', '=', false)
      .executeTakeFirstOrThrow();

    const updated = await trx.selectFrom('visitors').selectAll()
      .where('id', '=', id).executeTakeFirstOrThrow();

    return { status: 'exited', visitor: updated, inside_now: Number(inside), capacity };
  });
}
```

- [ ] **Step 4: Run the tests**

```bash
npm run build && node --test tests/gate-concurrency.test.mjs
```
Expected: all PASS, including the concurrency test.

- [ ] **Step 5: Prove the test actually tests something**

Temporarily delete `.forUpdate()` from the `event_settings` query in `admitVisitor`, rebuild, and re-run:

```bash
npm run build && node --test tests/gate-concurrency.test.mjs
```
Expected: the concurrency test **FAILS** with more than one admission. If it still passes, the test is not exercising the race and must be strengthened before continuing.

Then restore `.forUpdate()`, rebuild, and confirm it passes again.

- [ ] **Step 6: Commit**

```bash
git add src/db/gate.ts tests/gate-concurrency.test.mjs
git commit -m "feat: port the atomic gate to MariaDB row locking"
```

---

### Task 4: Port health, metrics, public and register routes

**Files:**
- Modify: `src/routes/health.ts`
- Modify: `src/lib/metrics.ts`
- Modify: `src/routes/public.ts`
- Modify: `src/routes/register.ts`

**Interfaces:**
- Consumes: `db` (Task 2), `isDuplicateEntry` (Task 2).
- Produces: no signature changes. `fetchVisitorMetrics()`, `fetchGroundCapacity()`, `fetchCrowdMetrics()`, `toCrowdMetrics()` keep their exact current signatures and return types.

- [ ] **Step 1: Port the readiness probe in `src/routes/health.ts`**

`/health/ready` must keep its contract exactly: 200 when the database answers,
503 with a `detail` when it does not. Replace the import and the single query:

```ts
import { sql } from 'kysely';
import { db } from '../db/client.js';
```

```ts
  app.get('/health/ready', { config: { rateLimit: false } }, async (_request, reply) => {
    try {
      await sql`SELECT 1`.execute(db);
    } catch (error) {
      return reply.code(503).send({
        status: 'unavailable',
        pid: process.pid,
        database: 'unreachable',
        detail: (error as Error).message,
      });
    }
    return { status: 'ok', pid: process.pid, database: 'reachable' };
  });
```

`SELECT 1` rather than a table read: the probe should report connectivity, not
schema state. Migrations run on boot, so a missing table means the process never
started — it cannot be observed here.

- [ ] **Step 2: Rewrite `src/lib/metrics.ts`**

Delete the `get_visitor_metrics` RPC path and its fallback entirely — with the counting done here there is only one path. Keep `VisitorMetrics`, `CrowdMetrics`, `DEFAULT_CAPACITY` and `toCrowdMetrics` exactly as they are, and replace the two fetchers.

Use a raw `sql` fragment for the aggregate. One round trip, standard SQL, and no
dependence on the query builder's `CASE` helpers:

```ts
import { sql } from 'kysely';
import { db } from '../db/client.js';

export async function fetchVisitorMetrics(): Promise<VisitorMetrics> {
  const { rows } = await sql<{
    total: number | string;
    paid: number | string;
    checked_in: number | string;
    exited: number | string;
    inside_now: number | string;
  }>`
    SELECT
      COUNT(*)                                                          AS total,
      SUM(payment_status = 'Paid')                                      AS paid,
      SUM(entry_status = 1)                                             AS checked_in,
      SUM(exited_status = 1)                                            AS exited,
      SUM(entry_status = 1 AND exited_status = 0)                       AS inside_now
    FROM visitors
  `.execute(db);

  const row = rows[0];
  // SUM() over zero rows is NULL, not 0.
  const total = Number(row?.total ?? 0);
  const paid = Number(row?.paid ?? 0);
  return {
    total,
    paid,
    pending: total - paid,
    checkedIn: Number(row?.checked_in ?? 0),
    exited: Number(row?.exited ?? 0),
    insideNow: Number(row?.inside_now ?? 0),
  };
}

export async function fetchGroundCapacity(): Promise<number> {
  try {
    const row = await db.selectFrom('event_settings')
      .select('ground_capacity').where('id', '=', 1).executeTakeFirst();
    const capacity = Number(row?.ground_capacity);
    return Number.isFinite(capacity) && capacity > 0 ? capacity : DEFAULT_CAPACITY;
  } catch {
    return DEFAULT_CAPACITY;
  }
}

export async function fetchCrowdMetrics(): Promise<CrowdMetrics> {
  const [inside, capacity] = await Promise.all([
    db.selectFrom('visitors')
      .select((eb) => eb.fn.countAll().as('inside'))
      .where('entry_status', '=', true).where('exited_status', '=', false)
      .executeTakeFirstOrThrow(),
    fetchGroundCapacity(),
  ]);
  return toCrowdMetrics(Number(inside.inside), capacity);
}
```

Remove the now-unused imports of `UNDEFINED_FUNCTION`, `unwrapCount` and `upstream`.

- [ ] **Step 3: Rewrite `src/routes/public.ts`**

Keep every `Cache-Control` header and response key exactly as they are. Replace the body:

```ts
import type { FastifyPluginAsync } from 'fastify';
import { db } from '../db/client.js';

const CACHE = 'public, max-age=30, stale-while-revalidate=300';

const ordered = (table: 'guests' | 'advisors' | 'management_members' | 'sponsors' | 'brand_stalls') =>
  db.selectFrom(table).selectAll().orderBy('display_order', 'asc').execute();

export const publicRoutes: FastifyPluginAsync = async (app) => {
  app.get('/content', async (_request, reply) => {
    const [settings, guests, advisors, management, sponsors, brandStalls] = await Promise.all([
      db.selectFrom('event_settings')
        .select(['event_date', 'event_end_date']).where('id', '=', 1).executeTakeFirst(),
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
      guests, advisors, management, sponsors, brandStalls,
    };
  });

  app.get('/event-settings', async (_request, reply) => {
    const data = await db.selectFrom('event_settings')
      .select(['event_date', 'event_end_date']).where('id', '=', 1).executeTakeFirst();
    reply.header('Cache-Control', CACHE);
    return {
      eventDate: data?.event_date ?? null,
      eventEndDate: data?.event_end_date ?? null,
    };
  });

  app.get('/ticket-tiers', async (_request, reply) => {
    const tiers = await db.selectFrom('ticket_tiers')
      .select([
        'id', 'day', 'start_time', 'end_time', 'price',
        'includes_concert', 'label_en', 'label_bn', 'is_active', 'display_order',
      ])
      .where('is_active', '=', true)
      .orderBy('display_order', 'asc')
      .execute();
    reply.header('Cache-Control', CACHE);
    return { tiers };
  });
};
```

- [ ] **Step 4: Rewrite the insert in `src/routes/register.ts`**

Keep `generateQrId`, `registrationSchema`, the rate-limit config, the retry loop and the 201 response shape. Replace the imports and the two database calls:

```ts
import { randomInt, randomUUID } from 'node:crypto';
import { db, isDuplicateEntry } from '../db/client.js';
```

The tier lookup:

```ts
      const tier = await db.selectFrom('ticket_tiers')
        .select(['id', 'price', 'includes_concert', 'label_en', 'label_bn', 'is_active'])
        .where('id', '=', body.ticket_tier_id)
        .executeTakeFirst();
```

The insert, inside the existing retry loop. MariaDB has no `INSERT … RETURNING` in Kysely's MySQL dialect, so the id is generated here — which is also what makes the retry loop straightforward:

```ts
        const qrCodeId = generateQrId();
        const id = randomUUID();
        try {
          await db.insertInto('visitors').values({
            id,
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
          }).execute();
        } catch (error) {
          if (isDuplicateEntry(error)) {
            request.log.warn({ attempt, qrCodeId }, 'qr code collision, retrying');
            continue;
          }
          throw upstream('Registration failed', { message: (error as Error).message });
        }

        request.log.info({ qrCodeId, tierId: tier.id }, 'visitor registered');
        return reply.code(201).send({
          qr_code_id: qrCodeId,
          name: body.name,
          price: tier.price,
          includes_concert: tier.includes_concert,
          label_en: tier.label_en,
          label_bn: tier.label_bn,
        });
```

- [ ] **Step 5: Typecheck and build**

```bash
npm run typecheck && npm run build
```
Expected: clean. Any error naming `supabase` means a call site was missed.

- [ ] **Step 6: Run the full test suite**

```bash
npm test
```
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/routes/health.ts src/lib/metrics.ts src/routes/public.ts src/routes/register.ts
git commit -m "feat: port health, metrics, public and register routes to MariaDB"
```

---

### Task 5: Port the scan and admin routes

**Files:**
- Modify: `src/routes/scan.ts`
- Modify: `src/routes/admin.ts`

**Interfaces:**
- Consumes: `admitVisitor`, `exitVisitor`, `GateOutcome` (Task 3); `db` (Task 2).
- Produces: no new exports. `deriveStatus` keeps its current signature and its four return values (`already_exited`, `entered`, `paid`, `pending`) — these are the *lookup* statuses and are deliberately a different set from the gate outcomes.

- [ ] **Step 1: Rewrite the gate calls in `src/routes/scan.ts`**

Delete `callGateRpc`, `RpcOutcome`, `MIGRATION_HINT` and the `ApiError`/`UNDEFINED_FUNCTION` imports. The `MIGRATION_REQUIRED` 503 goes away entirely: migrations now run on boot, so the gate functions cannot be missing.

Replace imports:

```ts
import { db } from '../db/client.js';
import { admitVisitor, exitVisitor } from '../db/gate.js';
```

The lookup:

```ts
    const visitor = await db.selectFrom('visitors')
      .select([
        'id', 'qr_code_id', 'name', 'mobile', 'profession', 'payment_status',
        'payment_method', 'entry_status', 'checked_in_at', 'ticket_tier_id',
        'ticket_price', 'includes_concert', 'exited_status', 'exited_at',
      ])
      .where('qr_code_id', '=', normalized)
      .executeTakeFirst();

    if (!visitor) throw notFound(`No visitor found for code ${normalized}`);

    const tier = visitor.ticket_tier_id
      ? await db.selectFrom('ticket_tiers')
          .select(['id', 'day', 'start_time', 'end_time', 'price', 'includes_concert', 'label_en', 'label_bn'])
          .where('id', '=', visitor.ticket_tier_id)
          .executeTakeFirst() ?? null
      : null;

    return { visitor, tier, status: deriveStatus(visitor) };
```

Then replace the two RPC calls, leaving both `switch` statements exactly as they are:

```ts
    const outcome = await admitVisitor(id, paymentMethod ?? null);
```
```ts
    const outcome = await exitVisitor(id);
```

- [ ] **Step 2: Rewrite `src/routes/admin.ts` queries**

Replace the import of `db, unwrap` with:

```ts
import { db } from '../db/client.js';
import { admitVisitor, exitVisitor } from '../db/gate.js';
```

Delete `escapeSearchTerm` — it escaped PostgREST `or`/`ilike` metacharacters that no longer exist. Kysely parameterises `like` values, so only the SQL wildcards need escaping:

```ts
/** Escape LIKE wildcards in a user-supplied search term. */
function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (m) => `\\${m}`);
}
```

The visitor list — note `total` must come from a separate count, since MariaDB has no `count: 'exact'` companion:

```ts
    let base = db.selectFrom('visitors');
    if (filter === 'paid') base = base.where('payment_status', '=', 'Paid');
    else if (filter === 'pending') base = base.where('payment_status', '=', 'Pending');
    else if (filter === 'entered') base = base.where('entry_status', '=', true);
    else if (filter === 'inside') base = base.where('entry_status', '=', true).where('exited_status', '=', false);
    else if (filter === 'exited') base = base.where('exited_status', '=', true);

    if (search) {
      const term = `%${escapeLike(search)}%`;
      base = base.where((eb) => eb.or([
        eb('name', 'like', term),
        eb('mobile', 'like', term),
        eb('email', 'like', term),
        eb('qr_code_id', 'like', term),
      ]));
    }

    const [visitors, counted] = await Promise.all([
      base.selectAll().orderBy('created_at', 'desc').limit(pageSize).offset(page * pageSize).execute(),
      base.select((eb) => eb.fn.countAll().as('total')).executeTakeFirstOrThrow(),
    ]);

    return { visitors, total: Number(counted.total), page, pageSize };
```

Mark paid:

```ts
    await db.updateTable('visitors').set({ payment_status: 'Paid' }).where('id', '=', id).execute();
    const visitor = await db.selectFrom('visitors').selectAll().where('id', '=', id).executeTakeFirst();
    if (!visitor) throw notFound('Visitor not found');
```

Manual entry and exit — replace the two `db.rpc` blocks with the shared gate functions so the dashboard and the scanner enforce the identical ceiling:

```ts
    const outcome = await admitVisitor(id, null);
    if (outcome.status === 'not_found') throw notFound('Visitor not found');
    return {
      status: outcome.status,
      visitor: outcome.visitor ?? null,
      crowd: toCrowdMetrics(outcome.inside_now ?? 0, outcome.capacity ?? 0),
    };
```
```ts
    const outcome = await exitVisitor(id);
    if (outcome.status === 'not_found') throw notFound('Visitor not found');
    return {
      status: outcome.status,
      visitor: outcome.visitor ?? null,
      crowd: toCrowdMetrics(outcome.inside_now ?? 0, outcome.capacity ?? (await fetchGroundCapacity())),
    };
```

Raffle:

```ts
    const visitors = await db.selectFrom('visitors')
      .select(['id', 'qr_code_id', 'name', 'mobile', 'email', 'profession', 'ticket_price', 'includes_concert', 'created_at'])
      .where('payment_status', '=', 'Paid')
      .orderBy('created_at', 'asc')
      .execute();
    return { visitors, total: visitors.length };
```

Ticket tiers — create needs an explicit id:

```ts
  app.get('/ticket-tiers', async () => ({
    tiers: await db.selectFrom('ticket_tiers').selectAll().orderBy('display_order', 'asc').execute(),
  }));

  app.post('/ticket-tiers', async (request, reply) => {
    const payload = parseBody(tierSchema, request.body);
    const id = randomUUID();
    await db.insertInto('ticket_tiers').values({ id, ...payload }).execute();
    const tier = await db.selectFrom('ticket_tiers').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
    return reply.code(201).send({ tier });
  });

  app.patch('/ticket-tiers/:id', async (request) => {
    const { id } = parseBody(idParamSchema, request.params);
    const payload = parseBody(tierSchema.partial(), request.body);
    await db.updateTable('ticket_tiers').set(payload).where('id', '=', id).execute();
    const tier = await db.selectFrom('ticket_tiers').selectAll().where('id', '=', id).executeTakeFirst();
    if (!tier) throw notFound('Ticket tier not found');
    return { tier };
  });

  app.delete('/ticket-tiers/:id', async (request, reply) => {
    const { id } = parseBody(idParamSchema, request.params);
    await db.deleteFrom('ticket_tiers').where('id', '=', id).execute();
    return reply.code(204).send();
  });
```

Add `import { randomUUID } from 'node:crypto';` at the top.

Event settings:

```ts
  app.get('/event-settings', async () => ({
    settings: await db.selectFrom('event_settings')
      .select(['event_date', 'event_end_date', 'ground_capacity', 'updated_at'])
      .where('id', '=', 1).executeTakeFirst(),
  }));

  app.patch('/event-settings', async (request) => {
    const payload = parseBody(eventSettingsSchema, request.body);
    await db.updateTable('event_settings')
      .set({ ...payload, updated_at: new Date() }).where('id', '=', 1).execute();
    const settings = await db.selectFrom('event_settings')
      .select(['event_date', 'event_end_date', 'ground_capacity', 'updated_at'])
      .where('id', '=', 1).executeTakeFirst();
    if (!settings) throw notFound('Event settings row (id=1) is missing');
    return { settings };
  });
```

Content CRUD. `entry.table` is a validated key of `CONTENT_TABLES`, so casting it to a Kysely table name is safe — the zod enum in `contentParamSchema` already rejects anything else:

```ts
  type ContentTableName = 'guests' | 'advisors' | 'management_members' | 'sponsors' | 'brand_stalls';

  app.get('/content/:table', async (request) => {
    const { table } = parseBody(contentParamSchema, request.params);
    const entry = resolveContentTable(table);
    return {
      items: await db.selectFrom(entry.table as ContentTableName)
        .selectAll().orderBy('display_order', 'asc').execute(),
    };
  });

  app.post('/content/:table', async (request, reply) => {
    const { table } = parseBody(contentParamSchema, request.params);
    const entry = resolveContentTable(table);
    const payload = sanitizeContentPayload(entry, (request.body ?? {}) as Record<string, unknown>, { partial: false });
    const name = entry.table as ContentTableName;

    if (payload.display_order === undefined) {
      const { count } = await db.selectFrom(name)
        .select((eb) => eb.fn.countAll().as('count')).executeTakeFirstOrThrow();
      payload.display_order = Number(count) + 1;
    }

    const id = randomUUID();
    await db.insertInto(name).values({ id, ...payload } as never).execute();
    const item = await db.selectFrom(name).selectAll().where('id', '=', id).executeTakeFirstOrThrow();
    return reply.code(201).send({ item });
  });

  app.patch('/content/:table/:id', async (request) => {
    const { table, id } = parseBody(contentItemParamSchema, request.params);
    const entry = resolveContentTable(table);
    const name = entry.table as ContentTableName;
    const payload = sanitizeContentPayload(entry, (request.body ?? {}) as Record<string, unknown>, { partial: true });
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
```

- [ ] **Step 3: Update the stale comment in `src/lib/content.ts`**

The docblock says the whitelist is the only thing standing between the endpoint and arbitrary writes "because the service-role key bypasses RLS". That reasoning is gone; the guarantee is not. Replace that sentence with:

```
 * The API connects as a single database user with full rights to this schema, so
 * this registry is the only thing standing between
 * `PATCH /api/admin/content/:table/:id` and arbitrary writes to any table.
 * Nothing outside this file may widen it.
```

Also change `Real Postgres table name.` to `Real table name.`

- [ ] **Step 4: Typecheck, build, test**

```bash
npm run typecheck && npm run build && npm test
```
Expected: clean, all tests pass.

- [ ] **Step 5: Run the smoke suite against a real database**

```bash
docker compose up -d db
DB_HOST=127.0.0.1 DB_PORT=3306 DB_USER=foodiana DB_PASSWORD=foodiana DB_NAME=foodiana \
JWT_SECRET=local-only-jwt-secret-at-least-32-characters \
ADMIN_PASSWORD=local-admin-password AGENT_PASSWORD=local-agent-password \
CORS_ORIGINS=https://ci.example LOG_LEVEL=silent \
npm run smoke
```

Several checks will now behave differently: the ones that previously expected `502` because the database was unreachable will now get real answers. Update those assertions in `scripts/smoke-test.mjs` to the correct expectations — for example `GET /health/ready` should now be **200**, and `agent token can reach the gate` should expect **200** rather than 502. Do not weaken any assertion to make it pass; each change must reflect genuinely correct behaviour.

- [ ] **Step 6: Commit**

```bash
git add src/routes/scan.ts src/routes/admin.ts src/lib/content.ts scripts/smoke-test.mjs
git commit -m "feat: port the scan and admin routes to MariaDB"
```

---

### Task 6: Photo uploads

Independently shippable — everything above works without it.

**Files:**
- Create: `src/lib/uploads.ts`
- Create: `src/routes/uploads.ts`
- Modify: `src/server.ts`
- Create: `tests/uploads.test.mjs`

**Interfaces:**
- Consumes: `env.UPLOAD_DIR` (Task 1), `requireRole` from `src/lib/auth.js`.
- Produces: `detectImageType(buffer): 'jpeg' | 'png' | 'webp' | null`, `saveUpload(buffer, kind): Promise<{ filename: string; url: string }>`, and `POST /api/admin/uploads` returning `{ url: string }`.

- [ ] **Step 1: Install the plugins**

```bash
npm install @fastify/multipart@^10.1.1 @fastify/static@^10.1.3
```

Both must be in `dependencies`.

- [ ] **Step 2: Write the failing test**

Create `tests/uploads.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { detectImageType } from '../dist/lib/uploads.js';

// 1x1 PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const WEBP = Buffer.concat([
  Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'),
]);

test('detects PNG from magic bytes', () => {
  assert.equal(detectImageType(PNG), 'png');
});

test('detects JPEG from magic bytes', () => {
  assert.equal(detectImageType(JPEG), 'jpeg');
});

test('detects WebP from magic bytes', () => {
  assert.equal(detectImageType(WEBP), 'webp');
});

test('rejects a non-image even when it claims to be one', () => {
  assert.equal(detectImageType(Buffer.from('<?php system($_GET[0]); ?>')), null);
});

test('rejects an empty buffer', () => {
  assert.equal(detectImageType(Buffer.alloc(0)), null);
});
```

- [ ] **Step 3: Run it and watch it fail**

```bash
npm run build && node --test tests/uploads.test.mjs
```
Expected: FAIL — `Cannot find module '../dist/lib/uploads.js'`.

- [ ] **Step 4: Implement the upload helper**

Create `src/lib/uploads.ts`:

```ts
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { env } from './env.js';

export type ImageKind = 'jpeg' | 'png' | 'webp';

const EXTENSIONS: Record<ImageKind, string> = { jpeg: '.jpg', png: '.png', webp: '.webp' };

/**
 * Identify an image by its magic bytes.
 *
 * The multipart Content-Type header is supplied by the client and is therefore
 * worthless as a security control — a PHP script announcing itself as image/png
 * would pass. Sniffing the actual bytes is what stops that.
 */
export function detectImageType(buffer: Buffer): ImageKind | null {
  if (buffer.length < 12) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpeg';
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'png';
  }
  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF'
      && buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'webp';
  }
  return null;
}

/** Resolve UPLOAD_DIR once, absolutely, so logs show exactly where files land. */
export const uploadDir = path.resolve(env.UPLOAD_DIR);

export async function ensureUploadDir(): Promise<string> {
  await mkdir(uploadDir, { recursive: true });
  return uploadDir;
}

/**
 * Write an upload under a generated name. The client's filename is never used
 * in the path — it is attacker-controlled and a source of traversal bugs.
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
```

- [ ] **Step 5: Run the test**

```bash
npm run build && node --test tests/uploads.test.mjs
```
Expected: PASS.

- [ ] **Step 6: Add the route**

Create `src/routes/uploads.ts`:

```ts
import type { FastifyPluginAsync } from 'fastify';
import { requireRole } from '../lib/auth.js';
import { badRequest } from '../lib/errors.js';
import { detectImageType, saveUpload } from '../lib/uploads.js';

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

export const uploadRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requireRole('admin'));

  app.post('/', async (request, reply) => {
    const file = await request.file({ limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } });
    if (!file) throw badRequest('Expected one file field');

    const buffer = await file.toBuffer();
    const kind = detectImageType(buffer);
    if (!kind) {
      throw badRequest('Only JPEG, PNG and WebP images are accepted');
    }

    const { url } = await saveUpload(buffer, kind);
    request.log.info({ url, bytes: buffer.length, kind }, 'image uploaded');
    return reply.code(201).send({ url });
  });
};
```

- [ ] **Step 7: Register multipart, static serving and the route**

In `src/server.ts`, alongside the other plugin registrations:

```ts
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { ensureUploadDir, uploadDir } from './lib/uploads.js';
import { uploadRoutes, MAX_UPLOAD_BYTES } from './routes/uploads.js';
```

```ts
  await app.register(multipart, { limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } });

  await ensureUploadDir();
  app.log.info({ uploadDir }, 'serving uploads from this absolute path');

  await app.register(fastifyStatic, {
    root: uploadDir,
    prefix: '/uploads/',
    index: false,
    list: false,
    // Filenames are random and immutable, so they can be cached hard.
    cacheControl: true,
    maxAge: '30d',
  });
```

and with the other route registrations:

```ts
  await app.register(uploadRoutes, { prefix: '/api/admin/uploads' });
```

Logging the resolved absolute path at boot is what makes a misconfigured `UPLOAD_DIR` visible immediately, rather than after the next deploy has silently discarded every image.

- [ ] **Step 8: Add smoke checks**

In `scripts/smoke-test.mjs`, after the existing admin checks:

```js
  const uploadNoAuth = await req('/api/admin/uploads', { method: 'POST' });
  check('upload rejects a missing token', uploadNoAuth.status === 401, `got ${uploadNoAuth.status}`);
```

- [ ] **Step 9: Build, test, smoke**

```bash
npm run typecheck && npm run build && npm test && npm run smoke
```
Expected: all pass.

- [ ] **Step 10: Commit**

```bash
git add package.json package-lock.json src/lib/uploads.ts src/routes/uploads.ts src/server.ts tests/uploads.test.mjs scripts/smoke-test.mjs
git commit -m "feat: accept photo uploads and serve them from disk"
```

---

### Task 7: Remove Supabase and rewrite the documentation

**Files:**
- Delete: `src/db/supabase.ts`, `supabase/migrations/`, `scripts/check-boots-without-websocket.mjs`
- Modify: `package.json`, `.github/workflows/ci.yml`, `README.md`, `docs/DEPLOY-HOSTINGER.md`, `scripts/verify-deployment.mjs`

- [ ] **Step 1: Confirm nothing still imports supabase**

```bash
grep -rn "supabase" src/ scripts/ tests/ || echo "clean"
```
Expected: `clean`. Fix any hit before continuing.

- [ ] **Step 2: Remove the dependency and the dead files**

```bash
npm uninstall @supabase/supabase-js
git rm -r supabase/migrations
git rm src/db/supabase.ts scripts/check-boots-without-websocket.mjs
```

The no-websocket guard exists only to catch a supabase-js failure mode. With the dependency gone it guards nothing, so it leaves with it.

- [ ] **Step 3: Drop the guard from CI and package.json**

Remove the `Boots without a global WebSocket` step from `.github/workflows/ci.yml` and the `check:no-websocket` script from `package.json`. Add a test step to the `build` job, after Build:

```yaml
      - name: Test
        run: npm test
        env:
          DB_HOST: 127.0.0.1
          DB_PORT: '3306'
          DB_USER: foodiana
          DB_PASSWORD: foodiana
          DB_NAME: foodiana_test
          UPLOAD_DIR: /tmp/foodiana-uploads
```

- [ ] **Step 4: Update `scripts/verify-deployment.mjs`**

The migration check no longer means "did someone run `supabase db push`" — migrations run on boot, so a missing table means the boot migration failed. Change the failure hint:

```js
      fail('database schema is not applied', 'the boot migration failed — check the application logs');
```

- [ ] **Step 5: Rewrite the docs**

In `README.md`: replace the Supabase references in **Getting started** (`cp .env.example .env`, `docker compose up -d db`, `npm run dev` — no `supabase db push` step at all), the **Database** section (MariaDB, migrations in `src/migrations/`, applied automatically on boot), and the **API** table (add `POST /api/admin/uploads` to the Admin group). Add `npm test` to the scripts table.

In `docs/DEPLOY-HOSTINGER.md`: replace the `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` environment block with the seven `DB_*` and `UPLOAD_DIR` variables, delete the "Apply the database migrations" section entirely, and add a troubleshooting row:

| Symptom | Cause |
| --- | --- |
| Uploaded images disappear after a deploy | `UPLOAD_DIR` points inside the versioned build directory. Move it outside `…/hbuilds/versions/…` — the boot log prints the resolved path. |

- [ ] **Step 6: Full verification**

```bash
npm run typecheck && npm run build && npm test && npm run smoke
grep -rn "supabase" src/ scripts/ tests/ docs/ README.md || echo "no supabase references remain"
```

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "chore: remove Supabase and document the MariaDB setup"
```

---

## Post-implementation

Deployment needs these, none of which block implementation:

1. Create the MariaDB database and user in hPanel; set `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` on the API app and remove the two `SUPABASE_*` variables.
2. Set `UPLOAD_DIR` to a path outside the versioned build directory, e.g. `/home/<user>/domains/api.foodianafest.com/uploads`.
3. Still outstanding from earlier and unrelated to this work: `JWT_SECRET` and `ADMIN_PASSWORD` are edited placeholders, and `CORS_ORIGINS` is missing the `www.` origin.
