# Foodiana 2026 — API

Fastify + TypeScript JSON API for the Foodiana 2026 event: registration,
ticketing, gate control and landing-page content. It owns the database schema and
is the **only** holder of the Supabase service-role key.

The web frontend lives in a separate repository and talks to this service over
HTTP only — there is no shared code, and no build-time coupling in either
direction. The contract between them is this README's [API](#api) section plus
`CORS_ORIGINS`.

| Path | What it is |
| --- | --- |
| `src/` | The service: routes, auth, validation, Supabase client |
| `supabase/migrations/` | The database schema — this repo owns it |
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
                                                     │ service-role key
                                                     ▼
                                              Supabase Postgres
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
#    fill in SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, JWT_SECRET, ADMIN_PASSWORD
#    generate a secret with:  openssl rand -base64 48

# 3. Apply the database migrations (adds the gate functions, revokes anon access)
supabase db push

# 4. Run
npm run dev          # http://localhost:4000
```

Point the frontend's `NEXT_PUBLIC_API_URL` at `http://localhost:4000`, and keep
that origin listed in `CORS_ORIGINS` here (the default already allows
`http://localhost:3000`).

| Script | What it does |
| --- | --- |
| `npm run dev` | Watch mode via tsx |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Run `dist/index.js` — exactly how Hostinger starts it |
| `npm run typecheck` | Types only, no emit |
| `npm run smoke` | Boot `dist/` and assert 24 behaviours needing no database |
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
| `GET`  | `/health/ready` | Readiness — verifies the database; 503 when it is not reachable |

The two probes are exempt from rate limiting so a load balancer can poll them
freely. `/` is not — it is public and unauthenticated, and nothing needs to poll
it.

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

`:table` is one of `guests`, `advisors`, `management_members`, `sponsors`,
`brand_stalls`. Both the table names and every writable column are whitelisted in
`src/lib/content.ts`. Because the service-role key bypasses RLS, that registry is
the only thing preventing arbitrary writes through the generic CRUD routes — do
not widen it elsewhere.

## Database

Migrations live in `supabase/migrations` — this service owns the schema, since it
is the sole database client. Run them with the Supabase CLI from the repository
root.

`20260818120000_backend_service_layer.sql` is the cutover migration. It:

1. **Drops every `anon_*` RLS policy.** Previously anyone with the public anon key
   could INSERT, UPDATE or DELETE any row — including marking their own ticket
   paid or flipping their own `entry_status`. With RLS enabled and no policies,
   `anon` and `authenticated` are denied everything; only `service_role` (which
   bypasses RLS) can read or write.
2. Adds `get_visitor_metrics()` so the dashboard's counts are one round trip.
3. Adds `admit_visitor()` and `exit_visitor()`, the atomic gate operations.
4. Adds indexes for the occupancy and payment-status counts the gate polls.

**Apply this migration before running the gate** — the scanner returns
`503 MIGRATION_REQUIRED` if the RPCs are missing rather than silently falling
back to a non-atomic capacity check.

## CI/CD

`.github/workflows/ci.yml` runs on Node 22 and 24: `npm ci`, typecheck, build,
then `scripts/smoke-test.mjs`. That boots `dist/index.js` exactly as Hostinger
does and asserts 24 behaviours needing no database: startup, login, role
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
