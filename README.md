# Foodiana 2026 — API

Fastify + TypeScript JSON API for the Foodiana 2026 event: registration,
ticketing, gate control and landing-page content. It owns the database schema and
is the **only** thing that talks to the database.

The web frontend lives in a separate repository and talks to this service over
HTTP only — there is no shared code, and no build-time coupling in either
direction. The contract between them is this README's [API](#api) section plus
`CORS_ORIGINS`.

| Path | What it is |
| --- | --- |
| `src/` | The service: routes, auth, validation, database access |
| `src/migrations/` | The schema, applied automatically on boot |
| `scripts/` | CI smoke test and live deployment verification |
| `infra/nginx/` | Load balancer config for the VPS/Docker path |
| `docs/` | [Hostinger deployment guide](docs/DEPLOY-HOSTINGER.md) |

## Architecture

```
                                        ┌──────────────────────────┐
  browser ──── HTTPS ────▶  nginx  ────▶│ API replica 1            │
  (frontend, no DB creds)   (:4000)     │ API replica 2            │
                              ├────────▶│ API replica 3  ...       │
                              └────────▶│ API replica N  ...       │
                                        └────────────┬─────────────┘
                                                     │ single DB user
                                                     ▼
                                                  MariaDB
```

The browser holds **no database credentials**. Every read and write goes through
this service. That boundary is what makes the API independently scalable — add
replicas without touching the frontend.

### Why the API is safe to clone horizontally

- **Stateless auth.** Staff sign in and receive a signed JWT. Any instance can
  verify a token minted by any other — there is no session store to share.
- **Atomic gate operations.** Admission and exit run inside Postgres functions
  (`admit_visitor`, `exit_visitor`) that take an advisory lock, so the venue
  capacity ceiling holds even when several gates scan simultaneously against
  different replicas. Checking the count in application code and then updating
  would let two concurrent scans both pass a full-venue check.
- **No local cache to keep coherent.** Every request reads current state.

The one component that is *not* shared is the rate-limit counter, which lives in
each instance's memory. With N instances the effective ceiling is N × `RATE_LIMIT_MAX`.
Point `@fastify/rate-limit` at a shared Redis store if you need one global budget
(see the note in `src/server.ts`).

## Getting started

```bash
# 1. Install
npm install

# 2. Configure
cp .env.example .env
#    fill in the DB_* settings, JWT_SECRET and ADMIN_PASSWORD
#    generate a secret with:  openssl rand -base64 48

# 3. Start MariaDB (or point DB_HOST at one you already have)
docker compose up -d db

# 4. Run — migrations are applied automatically before it listens
npm run dev          # http://localhost:4000
```

There is no separate migrate step, and deliberately so: a forgotten one is what
left the previous database completely empty while every deploy reported success.

Point the frontend's `NEXT_PUBLIC_API_URL` at `http://localhost:4000`, and keep
that origin listed in `CORS_ORIGINS` here (the default already allows
`http://localhost:3000`).

| Script | What it does |
| --- | --- |
| `npm run dev` | Watch mode via tsx |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Run `dist/index.js` — exactly how Hostinger starts it |
| `npm run typecheck` | Types only, no emit |
| `npm test` | Database tests: migrations, charset, the gate under concurrency |
| `npm run check:no-database` | Assert the API still serves liveness with the database down |
| `npm run smoke` | Boot `dist/` and assert 28 end-to-end behaviours against the database |
| `npm run verify:deployment` | Check a live deployment from the outside |

## Running as a cluster

```bash
cp .env.example .env

# 3 replicas behind nginx on :4000
docker compose up --build --scale backend=3
```

Scaling is by **replica count** — `--scale backend=N`, load balanced by nginx.
The API deliberately runs one process per instance rather than forking workers
internally: a managed host's framework preset owns how the app is started, so a
plain process shape is what lets the identical entry point run on Hostinger and
here. Add capacity by adding instances.

Without Docker: `npm run build && npm start`.

Point your balancer's health check at `/health`, and its readiness gate at
`/health/ready` — see [API](#api).

> `docker compose` has not been executed against a live daemon in this
> environment, so treat the first run as unverified.

## API

Errors are always `{ "error": string, "code": string, "details"?: unknown }`.

### Service — no auth

| Method | Path            | Purpose                                              |
| ------ | --------------- | ---------------------------------------------------- |
| `GET`  | `/`             | Service banner: name, version and the probe paths    |
| `GET`  | `/health`       | Liveness — never touches the database                |
| `GET`  | `/health/ready` | Readiness — 503 with a `detail` and `hint` when the database is unreachable or the boot migration failed |

The two probes are exempt from rate limiting so a load balancer can poll them
freely. `/` is not — it is public and unauthenticated, and nothing needs to poll
it.

**Liveness always answers.** If the database is unreachable the service still
starts and serves `/` and `/health`, and reports the specific failure on
`/health/ready`. It used to exit instead, which made an outage impossible to
diagnose from outside: the process died before it listened, so the platform
served its own blank 503 and the API was indistinguishable from a crashed
process, a DNS problem or an expired certificate. `npm run check:no-database`
guards this.

### Public — no auth

| Method | Path                       | Purpose                                              |
| ------ | -------------------------- | ---------------------------------------------------- |
| `GET`  | `/api/public/content`      | Landing page: countdown date + all five carousels    |
| `GET`  | `/api/public/event-settings` | Countdown dates only                               |
| `GET`  | `/api/public/ticket-tiers` | Active tiers for the registration form               |
| `POST` | `/api/register`            | Create a visitor, returns the server-issued QR code  |

`POST /api/register` accepts personal details and a `ticket_tier_id` and nothing
else. The price, concert entitlement, QR code, payment status and entry status
are all decided server-side, so none of them can be forged by the client.

### Auth

| Method | Path              | Purpose                                    |
| ------ | ----------------- | ------------------------------------------ |
| `POST` | `/api/auth/login` | Password → `{ token, role, expiresIn }`    |
| `GET`  | `/api/auth/me`    | Validate the current token                 |

`ADMIN_PASSWORD` grants role `admin`. The optional `AGENT_PASSWORD` grants role
`agent`, which can work the gate but cannot reach the dashboard.

### Gate — `Authorization: Bearer <token>`, role `admin` or `agent`

| Method | Path                            | Purpose                                     |
| ------ | ------------------------------- | ------------------------------------------- |
| `GET`  | `/api/scan/crowd`               | Live occupancy vs capacity                  |
| `GET`  | `/api/scan/lookup/:qrCodeId`    | Visitor + tier + derived gate status        |
| `POST` | `/api/scan/visitor/:id/entry`   | Atomic capacity-checked admission           |
| `POST` | `/api/scan/visitor/:id/exit`    | Atomic exit                                 |

Admission returns `422 CAPACITY_FULL` when the venue is at capacity, and
`409 CONFLICT` when the visitor is already inside or has already exited.

### Admin — role `admin` only

| Method   | Path                              | Purpose                              |
| -------- | --------------------------------- | ------------------------------------ |
| `GET`    | `/api/admin/metrics`              | All headline counts + occupancy      |
| `GET`    | `/api/admin/visitors`             | Paginated list (`filter`, `search`, `page`, `pageSize`) |
| `PATCH`  | `/api/admin/visitors/:id/payment` | Mark paid                            |
| `PATCH`  | `/api/admin/visitors/:id/entry`   | Manual admission (same atomic RPC)   |
| `PATCH`  | `/api/admin/visitors/:id/exit`    | Manual exit                          |
| `GET`    | `/api/admin/raffle`               | Paid visitors, oldest first          |
| `GET`    | `/api/admin/ticket-tiers`         | All tiers including inactive         |
| `POST`   | `/api/admin/ticket-tiers`         | Create tier                          |
| `PATCH`  | `/api/admin/ticket-tiers/:id`     | Update tier                          |
| `DELETE` | `/api/admin/ticket-tiers/:id`     | Delete tier                          |
| `GET`    | `/api/admin/event-settings`       | Dates + ground capacity              |
| `PATCH`  | `/api/admin/event-settings`       | Update dates / capacity              |
| `GET`    | `/api/admin/content/:table`       | List a content collection            |
| `POST`   | `/api/admin/content/:table`       | Create a row                         |
| `PATCH`  | `/api/admin/content/:table/:id`   | Update a row                         |
| `DELETE` | `/api/admin/content/:table/:id`   | Delete a row                         |
| `POST`   | `/api/admin/uploads`              | Upload an image, returns `{ url }`   |

`POST /api/admin/uploads` takes one image (JPEG, PNG or WebP, up to 5 MB) and
returns the URL to store in `image_url` / `logo_url`. The type is decided by the
file's magic bytes, not the `Content-Type` the client claims. Uploads are served
back from `/uploads/*`.

`:table` is one of `guests`, `advisors`, `management_members`, `sponsors`,
`brand_stalls`. Both the table names and every writable column are whitelisted in
`src/lib/content.ts`. Because the service-role key bypasses RLS, that registry is
the only thing preventing arbitrary writes through the generic CRUD routes — do
not widen it elsewhere.

## Database

MariaDB. Migrations live in `src/migrations/` and are applied **on boot**, before
the server accepts a request — if they fail the process exits rather than serving
a half-migrated database.

The schema is one initial migration rather than a history of increments: no
database was ever built from the previous Supabase migrations, so there was only
a final state to create.

Two details that are load-bearing:

- **Every table is `utf8mb4` / `utf8mb4_unicode_ci`.** The `*_bn` columns hold
  Bengali, and a `latin1` default corrupts them silently rather than failing.
- **The gate's capacity ceiling is a row lock.** `admitVisitor` takes
  `SELECT ... FOR UPDATE` on the `event_settings` singleton, which serialises
  every concurrent admission. Without it, two gates scanning at once could both
  pass a check at capacity − 1. `tests/gate-concurrency.test.mjs` fires 20
  simultaneous admissions at the last free slot and asserts exactly one wins.

There is no row-level security and none is needed: this service is the only
database client, and the browser never holds a credential.

## CI/CD

`.github/workflows/ci.yml` runs on Node 22 and 24: `npm ci`, typecheck, build,
then `scripts/smoke-test.mjs`. That boots `dist/index.js` exactly as Hostinger
does and asserts 28 behaviours end to end: startup, login, role
separation, input validation, the content-table whitelist, CORS in both
directions, and graceful shutdown.

A second job reproduces Hostinger's production-only install (`npm ci --omit=dev`)
and starts the app from it, which is how `sh: tsc: command not found` once reached
a real deploy.

On green, and only on `main`, the `promote` job fast-forwards the **`production`**
branch to the verified commit. Hostinger deploys from `production`, so a failing
build cannot reach it. `production` is a deploy pointer — never commit to it
directly.

`.github/workflows/verify-deployment.yml` checks the running deployment: database
reachability, real data reads, that auth is switched on, that CORS lists the real
site origin, and — when `PRODUCTION_ADMIN_PASSWORD` is set — that the gate
migration was applied. Run it after a deploy, or let the 6-hourly schedule catch
drift.

```bash
# same checks, locally
API_URL=https://api.your-domain.com \
SITE_URL=https://your-domain.com \
ADMIN_PASSWORD=... \
npm run verify:deployment
```

## Deployment

**Hostinger (current target)** — one Node.js app deploying from `production`,
pointed at the repository root. Full walkthrough with every hPanel field, the
required environment variables, and a troubleshooting table:
**[docs/DEPLOY-HOSTINGER.md](docs/DEPLOY-HOSTINGER.md)**.

The thing that bites most often: `CORS_ORIGINS` must list every site origin the
frontend is served from, `www.` included.

**VPS / Docker (for when you outgrow shared hosting)** — `Dockerfile` plus
`docker-compose.yml` and `infra/nginx/nginx.conf` give you nginx in front of N
replicas: `docker compose up --build --scale backend=3`. No application code
changes are needed to move, because the API is stateless and the capacity ceiling
lives in Postgres.

Keep `TRUST_PROXY=true` behind any proxy or load balancer — otherwise the rate
limiter counts every request against the proxy's IP instead of the client's.
