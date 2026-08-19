import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// Kysely 0.29 exposes the migration API on a subpath, not the package root.
import { FileMigrationProvider, Migrator, type MigrationResult } from 'kysely/migration';
import { db } from './client.js';

type MigrationLogger = {
  info: (obj: object, msg: string) => void;
  error: (obj: object, msg: string) => void;
};

/**
 * Applies pending migrations. Called on boot before the server listens, so a
 * forgotten migration is structurally impossible — which is exactly the failure
 * that left the previous database completely empty while every deploy reported
 * success.
 *
 * Kysely serialises concurrent runners for MySQL/MariaDB, so several replicas
 * starting at once cannot race each other.
 *
 * Note: MariaDB has no transactional DDL. A migration that fails partway leaves
 * partial state and stays recorded as unapplied, so the next boot re-runs it —
 * which is why every statement here is written to tolerate being repeated.
 */
export async function runMigrations(log: MigrationLogger): Promise<string[]> {
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

  return (results ?? [])
    .filter((r: MigrationResult) => r.status === 'Success')
    .map((r: MigrationResult) => r.migrationName);
}
