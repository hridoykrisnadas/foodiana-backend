# Deploying the API to Hostinger

Target: the **Hostinger Unlimited** web hosting plan (the plan that replaced
Business in March 2025) — 2 CPU cores, 3 GB RAM, up to 5 Node.js websites.

This repository deploys as **one Hostinger Node.js application**:

| App | Domain | Directory | Build command | Start / entry |
| --- | --- | --- | --- | --- |
| Foodiana API | `api.your-domain.com` | leave blank (repository root) | Fastify preset defaults | `npm start` |

The frontend lives in its own repository and deploys as a second, independent app.

## Two Hostinger constraints this repo is shaped around

Both were found the hard way, so they are worth stating up front.

**1. The build runs with production dependencies only.** Hostinger installs with
devDependencies skipped, so a build tool in `devDependencies` simply is not on
disk and the build dies with `sh: tsc: command not found`. Anything the *build*
needs is therefore a regular dependency — `typescript` and `@types/node` are in
`dependencies` for exactly this reason, not by accident.

**2. A framework preset owns how the app starts.** The Fastify preset rejects a
custom `Entry file` outright — *"Fastify framework does not support custom Entry
File configuration"* — and starts the app its own standard way, via `npm start`.

So the API is deliberately a plain Fastify server with nothing unusual about how
it boots: one entry point, `dist/index.js`, wired to both `main` and the `start`
script, and **no process clustering**. Anything clever in that file (an in-process
cluster primary, a custom launcher, a second entry file) is what forces you off
the preset and into hand-written deploy config.

Capacity is added by running more instances instead — see
[Scaling](#scaling-on-this-plan-and-when-to-leave-it). That is safe because the API
is stateless: JWT auth, no in-process session or cache, and the venue capacity
ceiling enforced inside Postgres.

## Why the directory field stays blank

A Hostinger Node.js app expects `package.json` at the directory it is given, and
runs `npm install` and the build command **inside that folder**. Because the API
is the whole repository, `package.json` is already at the root — so leave the
directory / project root field blank and there is nothing to configure.

(This used to be a real problem: when the API lived in a `backend/` folder of a
monorepo, the directory field had to name that subfolder, and Hostinger's older
Git integration offered only a server-side "deploy directory" that does not change
where `package.json` is looked for. Splitting the repositories removed that class
of failure.)

## One-time setup

### 1. Point the app at the `production` branch

CI promotes `main` to `production` only after the API typechecks, builds and
passes its smoke test, so `production` always holds a verified commit. Connect
Hostinger to **`production`**, not `main` — connecting to `main` would deploy
every push, including broken ones.

### 2. Create the API app

hPanel → **Websites** → **Add Website** → **Deploy Web App** → GitHub.

| Field | Value |
| --- | --- |
| Repository | this repo (`foodiana-backend`) |
| Branch | `production` |
| Directory / project root | leave blank (repository root) |
| Framework preset | **Fastify** |
| Package manager | npm |
| Build command | `npm run build` (the preset's default) |
| Output directory | leave blank |
| Entry file | leave blank |
| Node version | 22.x |
| Domain | `api.your-domain.com` |

Environment variables:

```
NODE_ENV=production
LOG_LEVEL=info
TRUST_PROXY=true

SUPABASE_URL=https://<project>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<service-role key>

JWT_SECRET=<openssl rand -base64 48>
JWT_EXPIRES_IN=8h
ADMIN_PASSWORD=<strong password>
AGENT_PASSWORD=<optional, gate-only password>

CORS_ORIGINS=https://your-domain.com,https://www.your-domain.com

RATE_LIMIT_MAX=300
REGISTER_RATE_LIMIT_MAX=10
```

Notes:

- **Pick the Fastify preset and leave the build/entry fields at their defaults.**
  This is a conventional Fastify app: `npm run build` compiles TypeScript to
  `dist/`, and `npm start` runs `dist/index.js`, which listens on `PORT`. Nothing
  custom to fill in.
- **Do not set `PORT`.** Hostinger assigns it; the API reads it from the
  environment and binds `0.0.0.0`.
- **`CORS_ORIGINS` must list every real site origin**, `www.` included. A missing
  origin looks like every browser request failing while `curl` still works. This is
  the one setting that has to be kept in step with the frontend repository.
- **Leave "Entry file" and "Output directory" blank.** The Fastify preset does not
  support them and fails with *"Fastify framework does not support custom Entry
  File configuration"* if set. `package.json` already gives the preset what it
  needs: `main` and `start` both point at `dist/index.js`.

### 3. Apply the database migrations

The gate depends on Postgres functions added by
`supabase/migrations/20260818120000_backend_service_layer.sql`. Hostinger does not
run migrations, so do it once from your machine:

```bash
supabase db push
```

Until that runs, the scanner returns `503 MIGRATION_REQUIRED` rather than falling
back to a non-atomic capacity check.

### 4. Enable SSL

hPanel → **Security** → **SSL** for `api.your-domain.com`. The site is served over
HTTPS, so the API must be too or the browser blocks every request as mixed content.

## Deploy flow

```
 push to main
      │
      ▼
 ┌───────────────────────────────┐
 │ CI: build (node 20, 22)       │
 │   npm ci                      │
 │   typecheck                   │
 │   build                       │
 │   smoke test (24 checks)      │
 ├───────────────────────────────┤
 │ CI: Hostinger install sim     │
 │   npm ci --omit=dev → start   │
 └───────────────┬───────────────┘
                 │ green
                 ▼
    git push main → production
                 │
                 ▼
      Hostinger API app
      npm install → build → restart
                 │
                 ▼
      Verify deployment workflow
```

The frontend deploys from its own repository on its own pipeline — neither can
block or break the other.

## After the first deploy

Set two repository variables so verification knows where to look — GitHub →
Settings → Secrets and variables → Actions → **Variables**:

| Variable | Value |
| --- | --- |
| `PRODUCTION_API_URL` | `https://api.your-domain.com` |
| `PRODUCTION_SITE_URL` | `https://your-domain.com` (used only to assert CORS allows it) |

Optionally add a **secret** `PRODUCTION_ADMIN_PASSWORD` (same value as the app's
`ADMIN_PASSWORD`). When present, verification also signs in and calls
`/api/admin/metrics`, which proves the migration was applied.

Then run **Actions → Verify deployment → Run workflow**, or locally:

```bash
API_URL=https://api.your-domain.com \
SITE_URL=https://your-domain.com \
ADMIN_PASSWORD=... \
node scripts/verify-deployment.mjs
```

Also worth doing once: GitHub → Settings → Branches → protect `main` and require
the **Build** and **Hostinger install simulation** checks. Without that, nothing
stops you merging a red PR.

## Scaling on this plan, and when to leave it

The Unlimited plan is a single managed instance per app: no Docker, no nginx, no
horizontal replicas. Scaling is vertical only:

1. Upgrade to **Cloud Startup** (4 cores, 4 GB, 10 Node.js apps).
2. Move the API to a **Hostinger VPS (KVM)** and use the `docker-compose.yml` and
   `infra/nginx/nginx.conf` in this repo: `docker compose up --build --scale backend=3`.

Option 2 is what this service was designed for, and needs no application code
changes: the API is stateless (JWT auth, no in-process session or cache) and the
venue capacity ceiling is enforced inside Postgres, so replicas are safe to add.
The one caveat is that the rate-limit counter is per process — point
`@fastify/rate-limit` at Redis if you need one global budget across replicas.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| App exits at boot, logs list missing variables | An env var is unset. The message names each one. |
| `npm install` fails or installs nothing | The app's directory is not the repository root, so it cannot see `package.json`. Clear the field. |
| `Fastify framework does not support custom Entry File configuration` | Clear the Entry file and Output directory fields. The preset uses `npm start` / `main`, which already point at `dist/index.js`. |
| `sh: tsc: command not found` during build | Hostinger installs production dependencies only, so anything the build needs must be in `dependencies`, not `devDependencies`. `typescript` and `@types/node` are already there — if you add another build-time tool, put it in `dependencies` too. |
| `unable to determine transport target for "pino-pretty"` | `NODE_ENV` is not `production` on a production-only install. Set `NODE_ENV=production` (the code degrades to JSON logs rather than crashing). |
| Build succeeds but the app will not start | An env var is missing — the log names each one. Check `NODE_ENV=production` is set. |
| Site loads, every API call fails in the browser, `curl` works | `CORS_ORIGINS` is missing the site origin — check `www.`. |
| Scanner returns `503 MIGRATION_REQUIRED` | `supabase db push` has not been run. |
| Mixed-content errors | SSL not issued on `api.` yet. |
| `429` during normal use | `RATE_LIMIT_MAX` is per process; raise it. |
