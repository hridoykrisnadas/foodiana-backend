# Moving the API from Supabase Postgres to Hostinger MariaDB

**Date:** 2026-08-19
**Status:** Draft, awaiting review
**Scope:** `foodiana-backend` only. The frontend is untouched.

## Why

The API currently talks to a Supabase Postgres project. It should talk to the
MariaDB instance that comes with the Hostinger plan, apply its own migrations on
startup, and store uploaded photos on the server's disk.

Three facts make now the right moment:

1. **The Supabase project is empty.** A live check on 2026-08-19 found zero
   tables and none of the expected functions — the migrations were never applied
   to it. There is no data to migrate, so this is a clean cut rather than a
   port. After the event there would be thousands of visitor rows and this same
   change would be a data migration with a hard deadline.
2. **The frontend is already decoupled.** It reads no database and holds no
   credentials; it calls this API over HTTP. Nothing about this change reaches
   it, and `NEXT_PUBLIC_API_URL` / `CORS_ORIGINS` stay as they are.
3. **Most of the Postgres-specific schema exists for a reason that is gone.**
   Roughly 40% of the current SQL is RLS policies and `GRANT`s to `anon` /
   `authenticated` / `service_role`. Those existed when browsers queried Supabase
   directly. This API is now the sole database client, so they are deleted rather
   than translated, and the security posture is unchanged.

## Goals

- Replace Supabase Postgres with Hostinger MariaDB as the only datastore.
- Apply pending migrations automatically at startup, before serving traffic.
- Accept photo uploads and serve them from the server's disk.
- Preserve the venue capacity guarantee under concurrent gate scans.
- Keep every public route's request and response shape byte-identical, so the
  frontend needs no change.

## Non-goals

- No dual-write, no Supabase fallback, no read-through cache. Clean cut.
- No change to auth. JWT + `ADMIN_PASSWORD` / `AGENT_PASSWORD` stay as they are.
- No change to the frontend, its build, or its deployment.
- No new admin UI for image management. The upload endpoint returns a URL; the
  existing CRUD forms store it in `image_url` / `logo_url` as they do today.

## Constraints

**MariaDB 11.8.8.** Recent enough for CTEs, window functions,
`INSERT … RETURNING`, enforced `CHECK` constraints and `SELECT … FOR UPDATE`.
Not MySQL 8 — that rules out tools that emit MySQL-8 dialect DDL.

**MariaDB has no transactional DDL.** A migration that fails halfway leaves
partial state; this cannot be fixed, only mitigated. Postgres gave a stronger
guarantee and we are knowingly giving it up. Mitigation: one statement group per
migration, each recorded only on success, so a failure is diagnosable and the
retry starts from a known point.

**Hostinger deploys into versioned directories.** The running app lives at
`…/hbuilds/versions/<uuid>/nodejs/`. A new directory is created per deploy, so
**anything written inside the application directory is lost on the next deploy.**
Uploaded photos must be written outside that tree. This is the single most
important constraint on the photo feature and the easiest to get wrong, because
it fails silently and only after a later deploy.

**Hostinger installs production dependencies only.** Anything needed at build or
runtime must be in `dependencies`, never `devDependencies`. This has already
caused one production failure.

**Hostinger MySQL is not reachable remotely** without an IP allowlist, so local
development and CI need their own MariaDB.

## Approach

`mysql2` as the driver, `kysely` as the typed query builder and migration
runner. Both in `dependencies`; neither needs a codegen step, so both survive
`npm ci --omit=dev`.

Kysely over Drizzle, deliberately:

- `drizzle-kit` generates **MySQL 8 dialect** DDL. The target is MariaDB. With
  Kysely the DDL is hand-written, so dialect compatibility is a decision we make
  rather than an assumption a generator makes.
- Kysely ships a migration lock table, which is what boot-time auto-migration
  needs once `docker compose --scale backend=N` starts several instances at once.
- The gate transaction stays SQL-shaped and reviewable. That code is the part
  most worth reading carefully, and an ORM's abstraction works against it.

Rejected: hand-written SQL with no query builder. It was the initial
recommendation on the grounds of a small, nearly-finished schema, but a typed
builder catches column typos at compile time across ~25 call sites, which is
worth the dependency.

## Architecture

```
  browser ──HTTPS──▶  Next.js frontend  ──HTTPS──▶  this API  ──▶  MariaDB
                      (no DB creds)                    │           (Hostinger)
                                                       │
                                                       └──▶  UPLOAD_DIR on disk
                                                            served at /uploads/*
```

### Components

| File | Responsibility |
| --- | --- |
| `src/db/client.ts` | mysql2 pool + Kysely instance. Replaces `src/db/supabase.ts`. |
| `src/db/schema.ts` | Hand-written `Database` interface. The single source of type truth. |
| `src/db/migrate.ts` | Kysely `Migrator`; runs on boot before `listen()`. |
| `src/migrations/*.ts` | Migrations; DDL via the `sql` tag, compiled into `dist/`. |
| `src/db/gate.ts` | `admitVisitor()` / `exitVisitor()` — replaces the plpgsql functions. |
| `src/lib/uploads.ts` | Filename generation, magic-byte type detection, disk writes. |
| `src/routes/uploads.ts` | `POST /api/admin/uploads`. |

Deleted: `src/db/supabase.ts`, `supabase/migrations/`, and
`scripts/check-boots-without-websocket.mjs` (it guards a supabase-js failure mode
that leaves with the dependency).

## Schema

Because the target database is empty, the eight historical migrations collapse
into **one initial migration describing the final state**. Replaying the
incremental `ADD COLUMN`s would be theatre — there is no database to evolve.

### Type translation

| Postgres | MariaDB | Note |
| --- | --- | --- |
| `uuid` + `gen_random_uuid()` | `CHAR(36)` | Generated in app code with `randomUUID()`. Explicit, driver-friendly, no dialect surprises. |
| `timestamptz` | `DATETIME(3)` | Stored UTC. The app never relies on server timezone. |
| `boolean` | `TINYINT(1)` | mysql2 returns 0/1; the data layer maps to real booleans so route code sees `boolean`. |
| `text` (indexed/unique) | `VARCHAR(n)` | MariaDB needs a bounded key length. `qr_code_id` becomes `VARCHAR(64) UNIQUE`. |
| `text` (free prose) | `TEXT` | `bio`, `bio_bn`, `bio_en`. |
| `jsonb` return values | — | Built in TypeScript. No JSON columns are needed. |
| `CHECK (x IN (…))` | `CHECK (x IN (…))` | MariaDB 11.8 enforces these. Kept. |
| RLS policies, role `GRANT`s | — | Deleted. The API is the only client. |

### Tables

`visitors`, `event_settings`, `guests`, `advisors`, `management_members`,
`sponsors`, `brand_stalls`, `ticket_tiers` — same names, same columns, including
the bilingual `*_bn` / `*_en` columns and the ticketing columns
(`ticket_tier_id`, `ticket_price`, `includes_concert`, `exited_status`,
`exited_at`, `ground_capacity`).

Indexes carried over: the occupancy and payment-status indexes the gate polls,
plus `qr_code_id UNIQUE`.

`event_settings` remains a singleton enforced by `id INT PRIMARY KEY CHECK (id = 1)`,
seeded with one row.

## The gate

This is the part that must not be got wrong. `admit_visitor` currently takes
`pg_advisory_xact_lock` so two gates scanning simultaneously cannot both pass a
full-venue check. Checking occupancy and then updating without serialisation
would let both scans through at capacity − 1.

MariaDB has `GET_LOCK()`, but it is **session-scoped**: with a connection pool a
crashed or recycled connection can strand the lock. Instead the admission
transaction takes a row lock on the `event_settings` singleton — the row it
already has to read for `ground_capacity`:

```ts
export async function admitVisitor(id: string, paymentMethod?: string) {
  return db.transaction().execute(async (trx) => {
    // Serialises every admission for the life of this transaction.
    // Released automatically on commit or rollback — no leak if a connection dies.
    const settings = await trx.selectFrom('event_settings')
      .select('ground_capacity').where('id', '=', 1)
      .forUpdate().executeTakeFirst();

    const visitor = await trx.selectFrom('visitors')
      .selectAll().where('id', '=', id).forUpdate().executeTakeFirst();

    if (!visitor)               return { status: 'not_found' } as const;
    if (visitor.exited_status)  return { status: 'already_exited', visitor } as const;
    if (visitor.entry_status)   return { status: 'already_inside', visitor } as const;

    const { inside } = await trx.selectFrom('visitors')
      .select((eb) => eb.fn.countAll().as('inside'))
      .where('entry_status', '=', true).where('exited_status', '=', false)
      .executeTakeFirstOrThrow();

    const capacity = settings?.ground_capacity ?? 2000;
    if (Number(inside) >= capacity) {
      return { status: 'capacity_full', capacity, inside: Number(inside) } as const;
    }

    await trx.updateTable('visitors')
      .set({ entry_status: true, checked_in_at: new Date(), payment_method: paymentMethod })
      .where('id', '=', id).execute();

    return { status: 'admitted', capacity, inside: Number(inside) + 1 } as const;
  });
}
```

The returned statuses are the same discriminated set the routes already branch
on, so `scan.ts` and `admin.ts` change only where they called `db.rpc(...)`.

`exitVisitor()` follows the same shape without the capacity check.

**The full status contract, which must not drift:**

| Status | Returned by | Meaning |
| --- | --- | --- |
| `not_found` | both | No visitor with that id |
| `already_inside` | admit | Visitor has already been admitted |
| `already_exited` | both | Visitor has already left |
| `capacity_full` | admit | Occupancy is at `ground_capacity` |
| `admitted` | admit | Success |
| `not_entered` | exit | Cannot exit someone who was never admitted |
| `exited` | exit | Success |

These strings are the API contract between the gate functions and the routes,
and in turn drive the scanner UI's messages. They are asserted by the smoke
suite so a rename cannot pass silently.

**Isolation level:** MariaDB's default `REPEATABLE READ` is sufficient here
because the `FOR UPDATE` on the settings row serialises the whole critical
section. This will be asserted by test, not assumed.

## Migrations

Kysely's `Migrator` with a file provider pointed at the compiled
`dist/migrations/`. It records applied migrations in `kysely_migration` and
serialises concurrent runners via `kysely_migration_lock`.

Run from `src/index.ts` **before** `app.listen()`:

- Success → log the names applied, then listen.
- Failure → log the error and `process.exit(1)`. A half-migrated database must
  never serve traffic; failing to start is the safer outcome and is visible in
  Hostinger's logs.

This makes a forgotten migration structurally impossible, which is the failure
that produced the empty database in the first place.

## Photo uploads

**Endpoint:** `POST /api/admin/uploads`, admin role only, `@fastify/multipart`.

- 5 MB limit, one file per request.
- Type determined by **magic bytes**, not the client's `Content-Type` header,
  which is attacker-controlled. Accepted: JPEG, PNG, WebP.
- Filename is `randomUUID()` plus the extension implied by the detected type.
  The client's filename is never used in the path.
- Returns `{ "url": "/uploads/<name>" }`, which the existing CRUD forms store in
  `image_url` / `logo_url`.

**Storage:** `UPLOAD_DIR`, absolute, created at boot if missing. On Hostinger it
must sit outside `hbuilds/versions/<uuid>/` — for example
`/home/<user>/domains/api.foodianafest.com/uploads`. If it points inside the app
directory, uploads survive until the next deploy and then vanish. The deployment
guide will call this out explicitly, and boot will log the resolved absolute path
so the mistake is visible immediately rather than after the next deploy.

**Serving:** `@fastify/static` at `/uploads/*`, read-only, directory listing off,
long `Cache-Control` (filenames are immutable). `helmet` already sends
`X-Content-Type-Options: nosniff`; `Content-Type` is set from the detected type,
never from what was uploaded.

**Deletion:** out of scope. Replacing an image leaves the old file on disk.
Called out as accepted debt rather than left unsaid.

## Configuration

Removed: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`.

Added, all validated by the existing zod schema so a missing value fails fast at
boot with a message naming it:

| Variable | Purpose |
| --- | --- |
| `DB_HOST` | MariaDB host (`localhost` on Hostinger) |
| `DB_PORT` | Default 3306 |
| `DB_USER` | Database user |
| `DB_PASSWORD` | Database password |
| `DB_NAME` | Database name |
| `DB_POOL_SIZE` | Default 10 |
| `UPLOAD_DIR` | Absolute path for uploaded photos |

## Error handling

The existing `upstream()` helper and the `{ error, code, details? }` response
shape are unchanged. The mapping layer moves from Postgrest error codes to
MariaDB `errno`:

| Condition | Today | After |
| --- | --- | --- |
| Unique violation | Postgres `23505` | MariaDB `1062` (`ER_DUP_ENTRY`) → same 409 path |
| Missing table/function | Postgrest `PGRST205` / `42883` | `1146` (`ER_NO_SUCH_TABLE`) → 502, though auto-migration should make it unreachable |
| Connection failure | supabase-js network error | `ECONNREFUSED` / `ER_ACCESS_DENIED_ERROR` → 502 |

`/health/ready` keeps its contract: a trivial query, 200 when the database
answers, 503 with a detail when it does not.

## Testing

Today's smoke test asserts 502s against placeholder Supabase credentials — it
proves routing and validation ran, but never that a query is correct. Running a
real database in CI is a genuine upgrade.

1. **CI gains a MariaDB 11.8 service container.** The smoke suite runs against a
   real database and asserts real reads and writes, not upstream failures.
2. **A concurrency test for the capacity ceiling.** Seed capacity − 1 admitted
   visitors, fire N simultaneous admissions, assert exactly one succeeds and the
   rest get `capacity_full`. This is the test that protects event night, and it
   is impossible to write without a real database. It must fail if the
   `forUpdate()` is removed — that will be verified by removing it.
3. **A migration test.** Run the migrator against an empty database, assert every
   expected table and index exists; run it twice, assert the second run is a
   no-op.
4. **An upload test.** Post a valid PNG, assert a URL comes back and the file is
   served at it. Post a file whose `Content-Type` lies about its magic bytes,
   assert rejection.
5. The existing auth, role-separation, validation, whitelist and CORS checks
   carry over unchanged.

`docker-compose.yml` gains a MariaDB service so local runs match CI.

## Deployment changes

- hPanel: create the MariaDB database and user, set the seven new env vars,
  remove the two Supabase ones.
- `UPLOAD_DIR` must point outside the versioned build directory.
- First deploy after this change runs the migrations automatically on boot;
  nothing manual.
- `docs/DEPLOY-HOSTINGER.md` and `README.md` rewritten for MariaDB, dropping the
  `supabase db push` step entirely.

## Risks

| Risk | Mitigation |
| --- | --- |
| Capacity ceiling breaks under concurrency | The concurrency test above, verified to fail when the row lock is removed. |
| A migration fails halfway (no transactional DDL) | Small migrations, recorded only on success. Accepted and documented, not solved. |
| `UPLOAD_DIR` misconfigured inside the versioned directory | Boot logs the resolved absolute path; deployment guide calls it out. |
| Hostinger MariaDB unreachable from the app | `/health/ready` reports it; boot fails loudly with the connection error. |
| Behaviour drift in route responses | Response shapes are asserted by the existing smoke checks, which stay. |

## Sequencing

1. Data layer: `client.ts`, `schema.ts`, the consolidated initial migration, the
   boot-time migrator. Prove it against a local MariaDB.
2. Gate: `gate.ts` plus the concurrency test. Highest-risk piece, done while
   there is the most room to be careful.
3. Routes: port `public`, `register`, `scan`, `admin`, `metrics` off supabase-js.
4. Uploads: endpoint, static serving, tests.
5. CI and compose: MariaDB service containers; delete the no-websocket guard.
6. Docs and deployment: README, deploy guide, env changes.
7. Remove `@supabase/supabase-js` and `supabase/migrations/`.

Each step keeps the build green; the cut-over is complete only at step 7.

## Open questions

1. What are the Hostinger MariaDB credentials and database name? Needed for
   deployment, not for implementation — local and CI use their own instance.
2. Is `www.foodianafest.com` served? It affects `CORS_ORIGINS`, which is
   currently missing it. Unrelated to this change but still outstanding.
3. Should uploaded images be resized or re-encoded on upload? Assumed **no** for
   now — "nothing extra" was the stated requirement, and a 5 MB cap bounds the
   damage. Adding `sharp` later is straightforward but it is a native dependency,
   which carries its own Hostinger install risk.
