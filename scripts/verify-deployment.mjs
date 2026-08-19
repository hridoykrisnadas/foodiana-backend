#!/usr/bin/env node

/**
 * Verifies a live API deployment from the outside.
 *
 * Unlike the CI smoke test, this runs against real infrastructure, so it can
 * check the things that only fail in production: the database credentials
 * actually work, auth is switched on, CORS lists the real site origin, and — if
 * a staff password is supplied — that the schema is in place.
 *
 * The site is only ever used as a CORS origin here. Whether the frontend itself
 * is serving correctly is verified in the frontend repository.
 *
 * Usage:
 *   API_URL=https://api.foodiana.com node scripts/verify-deployment.mjs
 * Optional:
 *   SITE_URL=https://foodiana.com   also asserts CORS allows that origin
 *   ADMIN_PASSWORD=...              also verifies the database functions from the migration
 */

const SITE_URL = (process.env.SITE_URL || '').replace(/\/+$/, '');
const API_URL = (process.env.API_URL || '').replace(/\/+$/, '');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';

if (!API_URL) {
  console.error('[verify] API_URL is required (e.g. https://api.foodiana.com)');
  process.exit(1);
}

let failures = 0;
let warnings = 0;
let passes = 0;

function pass(name) { passes += 1; console.log(`  ok    ${name}`); }
function fail(name, detail) { failures += 1; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
function warn(name, detail) { warnings += 1; console.warn(`  warn  ${name}${detail ? ` — ${detail}` : ''}`); }

async function get(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal, redirect: 'follow' });
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: response.status, text, json, headers: response.headers };
  } catch (error) {
    return { status: 0, text: '', json: null, headers: new Headers(), error };
  } finally {
    clearTimeout(timer);
  }
}

console.log(`[verify] API  ${API_URL}`);
if (SITE_URL) console.log(`[verify] site origin ${SITE_URL} (CORS check only)`);
console.log('');

// --- 1. API is alive --------------------------------------------------------
const health = await get(`${API_URL}/health`);
if (health.status === 200 && health.json?.status === 'ok') {
  pass('API /health is 200');
} else if (health.status === 0) {
  // Nothing else can be judged if the host is unreachable, and reporting
  // "admin routes are not protected" here would be actively misleading.
  fail('API is unreachable', health.error?.message || 'no response');
  console.error(
    `\n[verify] Cannot reach ${API_URL} at all — skipping the remaining checks.\n` +
      '  Check the Hostinger app is Running, the subdomain resolves, and SSL is issued.',
  );
  console.log(`\n[verify] ${passes} passed, ${warnings} warnings, ${failures} failed`);
  process.exit(1);
} else {
  fail('API /health', `status ${health.status}`);
}

// --- 2. API can reach the database -----------------------------------------
// This is the check that catches wrong or missing database credentials.
const ready = await get(`${API_URL}/health/ready`);
if (ready.status === 200) pass('API /health/ready — database reachable');
else fail('API /health/ready — database unreachable', ready.json?.detail || `status ${ready.status}`);

// --- 3. Real data reads work end to end ------------------------------------
const tiers = await get(`${API_URL}/api/public/ticket-tiers`);
if (tiers.status === 200 && Array.isArray(tiers.json?.tiers)) {
  if (tiers.json.tiers.length > 0) pass(`public ticket tiers load (${tiers.json.tiers.length} active)`);
  else warn('public ticket tiers load but none are active', 'registration will show no options');
} else {
  fail('public ticket tiers', `status ${tiers.status}`);
}

const content = await get(`${API_URL}/api/public/content`);
if (content.status === 200 && content.json && 'guests' in content.json) pass('public landing content loads');
else fail('public landing content', `status ${content.status}`);

// --- 4. Auth is switched on -------------------------------------------------
const unauth = await get(`${API_URL}/api/admin/metrics`);
if (unauth.status === 401) pass('admin routes require a token');
else fail('admin routes are not protected', `expected 401, got ${unauth.status}`);

const unauthScan = await get(`${API_URL}/api/scan/crowd`);
if (unauthScan.status === 401) pass('gate routes require a token');
else fail('gate routes are not protected', `expected 401, got ${unauthScan.status}`);

// --- 5. CORS is restricted -------------------------------------------------
const badOrigin = await get(`${API_URL}/health`, { headers: { origin: 'https://not-allowed.example' } });
if (badOrigin.status === 403) pass('CORS rejects an unlisted origin');
else if (badOrigin.headers.get('access-control-allow-origin') === '*') fail('CORS is wide open', 'ACAO is *');
else warn('CORS did not reject an unlisted origin', `status ${badOrigin.status}`);

if (SITE_URL) {
  const allowedOrigin = await get(`${API_URL}/health`, { headers: { origin: SITE_URL } });
  if (allowedOrigin.headers.get('access-control-allow-origin') === SITE_URL) {
    pass(`CORS allows the site origin (${SITE_URL})`);
  } else {
    fail('CORS does not allow the site origin', `add ${SITE_URL} to CORS_ORIGINS on this API app`);
  }
} else {
  warn('skipped the site-origin CORS check', 'set SITE_URL to verify the real frontend can call this API');
}

// --- 6. The gate migration is applied --------------------------------------
// get_visitor_metrics() only exists after 20260818120000_backend_service_layer.sql,
// so a successful /api/admin/metrics proves the migration landed.
if (ADMIN_PASSWORD) {
  const login = await get(`${API_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: ADMIN_PASSWORD }),
  });

  if (login.status === 200 && login.json?.token) {
    pass('staff login succeeds');
    const metrics = await get(`${API_URL}/api/admin/metrics`, {
      headers: { authorization: `Bearer ${login.json.token}` },
    });
    if (metrics.status === 200 && typeof metrics.json?.metrics?.total === 'number') {
      pass(`admin metrics load — gate migration is applied (${metrics.json.metrics.total} visitors)`);
    } else if (metrics.json?.code === 'MIGRATION_REQUIRED') {
      fail('database schema is not applied', 'the boot migration failed — check the application logs');
    } else {
      fail('admin metrics', `status ${metrics.status} ${metrics.json?.error || ''}`);
    }
  } else {
    fail('staff login failed', `status ${login.status} — is ADMIN_PASSWORD in sync with the API app?`);
  }
} else {
  warn('skipped the migration check', 'set ADMIN_PASSWORD to verify the gate database functions');
}

console.log(`\n[verify] ${passes} passed, ${warnings} warnings, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
