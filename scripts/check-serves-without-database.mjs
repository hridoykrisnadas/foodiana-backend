#!/usr/bin/env node

/**
 * Regression guard: an unreachable database must not take the whole API down.
 *
 * The boot-time migration originally called process.exit(1) on failure, on the
 * reasoning that a half-migrated database should never serve traffic. The cost
 * only became clear in production: the process died before it listened, so
 * `/health` and `/` were unreachable too and the platform served its own blank
 * 503 page. There was no way to ask the service what was wrong — the API looked
 * identical to a crashed one, a DNS problem, or an expired certificate.
 *
 * The rule now is: liveness always answers, readiness tells the truth. This
 * asserts both against a database that does not exist.
 *
 * Run after `npm run build`.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.env.NODB_PORT || 4599);
const BASE = `http://127.0.0.1:${PORT}`;

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

const server = spawn(process.execPath, [path.join('dist', 'index.js')], {
  cwd: repoRoot,
  env: {
    ...process.env,
    PORT: String(PORT),
    // Deliberately pointed at nothing.
    DB_HOST: '127.0.0.1',
    DB_PORT: '3399',
    DB_USER: 'nobody',
    DB_PASSWORD: 'nothing',
    DB_NAME: 'does_not_exist',
    JWT_SECRET: 'ci-only-jwt-secret-at-least-32-characters-long',
    ADMIN_PASSWORD: 'ci-only-admin-password',
    UPLOAD_DIR: '/tmp/foodiana-nodb-uploads',
    LOG_LEVEL: 'silent',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let output = '';
server.stdout.on('data', (d) => { output += d; });
server.stderr.on('data', (d) => { output += d; });

async function get(pathname) {
  const response = await fetch(`${BASE}${pathname}`);
  let body = null;
  try {
    body = await response.json();
  } catch {
    /* not json */
  }
  return { status: response.status, body };
}

try {
  const deadline = Date.now() + 30_000;
  let up = false;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) {
      throw new Error(
        `the API exited with code ${server.exitCode} instead of serving without a database`,
      );
    }
    try {
      const probe = await fetch(`${BASE}/health`);
      if (probe.ok) { up = true; break; }
    } catch {
      /* not listening yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!up) throw new Error('the API never started without a database');

  const root = await get('/');
  check('GET / still answers 200', root.status === 200, `got ${root.status}`);
  check('GET / still names the service', root.body?.service === 'foodiana-backend');

  const health = await get('/health');
  check('GET /health still answers 200', health.status === 200, `got ${health.status}`);

  const ready = await get('/health/ready');
  check('GET /health/ready reports 503', ready.status === 503, `got ${ready.status}`);
  check(
    'GET /health/ready explains what failed',
    typeof ready.body?.detail === 'string' && ready.body.detail.length > 0,
    JSON.stringify(ready.body),
  );
  check(
    'GET /health/ready says what to check',
    typeof ready.body?.hint === 'string' && ready.body.hint.includes('DB_HOST'),
    JSON.stringify(ready.body?.hint),
  );

  server.kill('SIGTERM');
} catch (error) {
  failures += 1;
  console.error(`\n[no-database] ${error.message}`);
  if (output.trim()) console.error(`\n[no-database] server output:\n${output}`);
} finally {
  if (server.exitCode === null) server.kill('SIGKILL');
}

console.log(`\n[no-database] ${passes} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
