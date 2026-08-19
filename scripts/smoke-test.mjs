#!/usr/bin/env node

/**
 * Boots the built API against placeholder credentials and asserts the behaviour
 * that does not depend on a database: it starts, authenticates, enforces roles,
 * validates input, applies CORS and shuts down cleanly.
 *
 * The backend is started exactly the way Hostinger starts it — `npm start` (`dist/index.js`)
 * from the repository root — so this exercises the real entry point, not a test-only
 * wrapper.
 *
 * Endpoints that touch Postgres are expected to fail with 502 here — that is the
 * correct answer when the Supabase URL is a placeholder, and still proves the
 * route, the auth guard and the validation in front of it all ran.
 */

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.env.SMOKE_PORT || 4555);
const BASE = `http://127.0.0.1:${PORT}`;
const ORIGIN = process.env.CORS_ORIGINS?.split(',')[0]?.trim() || 'https://ci.example';

let failures = 0;
let passes = 0;

function check(name, condition, detail = '') {
  if (condition) {
    passes += 1;
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function req(pathname, options = {}) {
  const response = await fetch(`${BASE}${pathname}`, options);
  let body = null;
  try {
    body = await response.json();
  } catch {
    /* empty body (204) */
  }
  return { status: response.status, body, headers: response.headers };
}

async function waitForServer(child, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited early with code ${child.exitCode}`);
    try {
      const response = await fetch(`${BASE}/health`);
      if (response.ok) return;
    } catch {
      /* not listening yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`server did not become healthy within ${timeoutMs}ms`);
}

// backend/ is the repository root here, so dist/ sits directly under it.
const server = spawn(process.execPath, [path.join('dist', 'index.js')], {
  cwd: repoRoot,
  env: { ...process.env, PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let serverOutput = '';
server.stdout.on('data', (d) => { serverOutput += d; });
server.stderr.on('data', (d) => { serverOutput += d; });

try {
  console.log(`[smoke] booting API on ${BASE}`);
  await waitForServer(server);
  console.log('[smoke] server is up\n');

  // --- service root ---------------------------------------------------------
  const root = await req('/');
  check('GET / returns 200', root.status === 200, `got ${root.status}`);
  check('GET / names the service', root.body?.service === 'foodiana-backend', `got ${root.body?.service}`);
  check('GET / reports a version', typeof root.body?.version === 'string' && root.body.version.length > 0);
  check(
    'GET / links both health probes',
    root.body?.health?.live === '/health' && root.body?.health?.ready === '/health/ready',
    JSON.stringify(root.body?.health),
  );

  // --- liveness -------------------------------------------------------------
  const health = await req('/health');
  check('GET /health returns 200', health.status === 200, `got ${health.status}`);
  check('GET /health reports a pid', typeof health.body?.pid === 'number');

  // Readiness must fail loudly with placeholder credentials rather than lie.
  const ready = await req('/health/ready');
  check('GET /health/ready reports the database unreachable', ready.status === 503, `got ${ready.status}`);

  // --- auth -----------------------------------------------------------------
  const badLogin = await req('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'definitely-not-the-password' }),
  });
  check('wrong password is rejected', badLogin.status === 401, `got ${badLogin.status}`);

  const login = await req('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: process.env.ADMIN_PASSWORD }),
  });
  check('correct password returns a token', login.status === 200 && !!login.body?.token, `got ${login.status}`);
  check('token carries the admin role', login.body?.role === 'admin', `got ${login.body?.role}`);

  const adminAuth = { authorization: `Bearer ${login.body?.token}` };

  const me = await req('/api/auth/me', { headers: adminAuth });
  check('GET /api/auth/me accepts the token', me.status === 200, `got ${me.status}`);

  // --- authorisation --------------------------------------------------------
  const noToken = await req('/api/admin/metrics');
  check('admin route rejects a missing token', noToken.status === 401, `got ${noToken.status}`);

  const badToken = await req('/api/admin/metrics', { headers: { authorization: 'Bearer not.a.jwt' } });
  check('admin route rejects a malformed token', badToken.status === 401, `got ${badToken.status}`);

  if (process.env.AGENT_PASSWORD) {
    const agentLogin = await req('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: process.env.AGENT_PASSWORD }),
    });
    check('agent password returns the agent role', agentLogin.body?.role === 'agent', `got ${agentLogin.body?.role}`);

    const agentOnAdmin = await req('/api/admin/metrics', {
      headers: { authorization: `Bearer ${agentLogin.body?.token}` },
    });
    check('agent token cannot reach admin routes', agentOnAdmin.status === 403, `got ${agentOnAdmin.status}`);

    const agentOnScan = await req('/api/scan/crowd', {
      headers: { authorization: `Bearer ${agentLogin.body?.token}` },
    });
    check('agent token can reach the gate', agentOnScan.status === 502, `got ${agentOnScan.status}`);
  }

  // --- validation -----------------------------------------------------------
  const badRegister = await req('/api/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'x', email: 'nope', mobile: '1', dob: 'bad', profession: '', ticket_tier_id: 'no' }),
  });
  check('registration rejects an invalid body', badRegister.status === 400, `got ${badRegister.status}`);
  check('validation errors name the fields', Array.isArray(badRegister.body?.details) && badRegister.body.details.length >= 5);

  const badTable = await req('/api/admin/content/pg_catalog', { headers: adminAuth });
  check('content CRUD rejects a non-whitelisted table', badTable.status === 400, `got ${badTable.status}`);

  const badColumn = await req('/api/admin/content/guests', {
    method: 'POST',
    headers: { ...adminAuth, 'content-type': 'application/json' },
    body: JSON.stringify({ name_bn: 'Test', is_superuser: true }),
  });
  check('content CRUD rejects a non-whitelisted column', badColumn.status === 400, `got ${badColumn.status}`);

  // --- routing --------------------------------------------------------------
  const missing = await req('/api/does-not-exist');
  check('unknown route returns a structured 404', missing.status === 404 && missing.body?.code === 'ROUTE_NOT_FOUND');

  // --- CORS -----------------------------------------------------------------
  const allowed = await req('/health', { headers: { origin: ORIGIN } });
  check(
    `CORS allows the configured origin (${ORIGIN})`,
    allowed.headers.get('access-control-allow-origin') === ORIGIN,
    `got ${allowed.headers.get('access-control-allow-origin')}`,
  );

  const denied = await req('/health', { headers: { origin: 'https://not-allowed.example' } });
  check('CORS rejects an unlisted origin', denied.status === 403, `got ${denied.status}`);

  // --- graceful shutdown ----------------------------------------------------
  server.kill('SIGTERM');
  const [code, signal] = await once(server, 'exit');
  check('SIGTERM shuts the server down cleanly', code === 0 || signal === 'SIGTERM', `code=${code} signal=${signal}`);
} catch (error) {
  failures += 1;
  console.error(`\n[smoke] ${error.message}`);
  if (serverOutput.trim()) console.error(`\n[smoke] server output:\n${serverOutput}`);
} finally {
  if (server.exitCode === null) server.kill('SIGKILL');
}

console.log(`\n[smoke] ${passes} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
