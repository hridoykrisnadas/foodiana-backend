#!/usr/bin/env node

/**
 * Regression guard: the API must boot on a runtime with no global WebSocket.
 *
 * supabase-js builds a RealtimeClient inside createClient, and RealtimeClient
 * resolves a WebSocket constructor while constructing — even though this service
 * never opens a realtime channel. Before this was pinned down, that lookup threw
 * at import time on Node < 22, so the process died before listening and the whole
 * API was down. It reached production once already.
 *
 * Testing the invariant directly ("boots with no global WebSocket") rather than
 * testing a Node version means this keeps working as the supported floor moves,
 * and catches any *other* dependency that starts needing a browser global at
 * import time.
 *
 * Run after `npm run build`.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.env.NOWS_PORT || 4577);
const BASE = `http://127.0.0.1:${PORT}`;

// Deleting the global in a preload is a faithful stand-in for Node < 22, and far
// cheaper than installing an old Node just to prove the point.
const server = spawn(
  process.execPath,
  ['--import', 'data:text/javascript,delete globalThis.WebSocket', path.join('dist', 'index.js')],
  {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: String(PORT),
      SUPABASE_URL: process.env.SUPABASE_URL || 'https://ci-placeholder.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY:
        process.env.SUPABASE_SERVICE_ROLE_KEY || 'ci-placeholder-service-role-key-not-real',
      JWT_SECRET: process.env.JWT_SECRET || 'ci-only-jwt-secret-at-least-32-characters-long',
      ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || 'ci-only-admin-password',
      LOG_LEVEL: 'silent',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);

let output = '';
server.stdout.on('data', (d) => { output += d; });
server.stderr.on('data', (d) => { output += d; });

const deadline = Date.now() + 30_000;
let healthy = false;

while (Date.now() < deadline) {
  if (server.exitCode !== null) break;
  try {
    const response = await fetch(`${BASE}/health`);
    if (response.ok) { healthy = true; break; }
  } catch {
    /* not listening yet */
  }
  await new Promise((resolve) => setTimeout(resolve, 250));
}

if (server.exitCode === null) server.kill('SIGTERM');

if (healthy) {
  console.log('[no-websocket] ok — the API boots and serves /health with no global WebSocket');
  process.exit(0);
}

console.error('[no-websocket] FAIL — the API did not start without a global WebSocket');
if (output.trim()) console.error(`\n[no-websocket] server output:\n${output}`);
process.exit(1);
