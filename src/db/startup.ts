/**
 * Records whether the boot-time migration succeeded.
 *
 * The API used to exit when migrations failed, on the reasoning that a
 * half-migrated database must never serve traffic. In practice that made an
 * outage undiagnosable: the process died before it listened, so `/health` and
 * `/` were unreachable too and the platform served its own blank 503. There was
 * no way to ask the service what was wrong.
 *
 * Serving is now the default, and the failure is reported instead: liveness and
 * the service banner stay up, `/health/ready` returns 503 naming the exact
 * error, and data routes fail on their own queries. Nothing can read or write a
 * table that does not exist, so the original safety concern is preserved by the
 * database itself.
 */
let migrationError: Error | null = null;

export function recordMigrationFailure(error: unknown): void {
  migrationError = error instanceof Error ? error : new Error(String(error));
}

export function getMigrationFailure(): Error | null {
  return migrationError;
}
