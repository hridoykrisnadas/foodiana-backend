import { sql, type Kysely } from 'kysely';

/**
 * The whole schema in one migration.
 *
 * This replaces eight incremental Supabase migrations. Replaying their history
 * would be theatre: no database was ever created from them, so there is nothing
 * to evolve — only a final state to build.
 *
 * utf8mb4 is not optional. The *_bn columns hold Bengali, and a latin1 default
 * corrupts them silently rather than failing.
 */
const TABLE_OPTIONS = sql`ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`;

export async function up(db: Kysely<unknown>): Promise<void> {
  // First: visitors has a foreign key to this table.
  await sql`
    CREATE TABLE IF NOT EXISTS ticket_tiers (
      id               CHAR(36)     NOT NULL PRIMARY KEY,
      day              VARCHAR(16)  NOT NULL,
      start_time       VARCHAR(5)   NOT NULL,
      end_time         VARCHAR(5)   NOT NULL,
      price            INT          NOT NULL,
      includes_concert TINYINT(1)   NOT NULL DEFAULT 0,
      label_en         VARCHAR(120) NULL,
      label_bn         VARCHAR(120) NULL,
      is_active        TINYINT(1)   NOT NULL DEFAULT 1,
      display_order    INT          NOT NULL DEFAULT 0,
      created_at       DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      KEY idx_ticket_tiers_active (is_active, display_order)
    ) ${TABLE_OPTIONS}
  `.execute(db);

  await sql`
    CREATE TABLE IF NOT EXISTS visitors (
      id               CHAR(36)     NOT NULL PRIMARY KEY,
      qr_code_id       VARCHAR(64)  NOT NULL,
      name             VARCHAR(120) NOT NULL,
      email            VARCHAR(180) NOT NULL,
      mobile           VARCHAR(20)  NOT NULL,
      dob              DATE         NOT NULL,
      profession       VARCHAR(120) NOT NULL,
      payment_status   VARCHAR(16)  NOT NULL DEFAULT 'Pending',
      entry_status     TINYINT(1)   NOT NULL DEFAULT 0,
      payment_method   VARCHAR(16)  NULL,
      checked_in_at    DATETIME(3)  NULL,
      created_at       DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      ticket_tier_id   CHAR(36)     NULL,
      ticket_price     INT          NULL,
      includes_concert TINYINT(1)   NOT NULL DEFAULT 0,
      exited_status    TINYINT(1)   NOT NULL DEFAULT 0,
      exited_at        DATETIME(3)  NULL,
      UNIQUE KEY uq_visitors_qr_code_id (qr_code_id),
      KEY idx_visitors_occupancy (entry_status, exited_status),
      KEY idx_visitors_payment_status (payment_status),
      KEY idx_visitors_created_at (created_at),
      CONSTRAINT fk_visitors_ticket_tier
        FOREIGN KEY (ticket_tier_id) REFERENCES ticket_tiers (id)
    ) ${TABLE_OPTIONS}
  `.execute(db);

  await sql`
    CREATE TABLE IF NOT EXISTS event_settings (
      id              INT         NOT NULL PRIMARY KEY,
      event_date      DATE        NOT NULL,
      event_end_date  DATE        NULL,
      ground_capacity INT         NOT NULL DEFAULT 2000,
      updated_at      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      CONSTRAINT chk_event_settings_singleton CHECK (id = 1)
    ) ${TABLE_OPTIONS}
  `.execute(db);

  // The gate locks this row to serialise admissions, so it must exist.
  await sql`
    INSERT IGNORE INTO event_settings (id, event_date, ground_capacity)
    VALUES (1, '2026-11-05', 2000)
  `.execute(db);

  await sql`
    CREATE TABLE IF NOT EXISTS guests (
      id             CHAR(36)     NOT NULL PRIMARY KEY,
      type           VARCHAR(16)  NOT NULL DEFAULT 'SPECIAL',
      name           VARCHAR(160) NOT NULL,
      designation    VARCHAR(160) NOT NULL,
      image_url      VARCHAR(512) NULL,
      bio            TEXT         NULL,
      name_bn        VARCHAR(160) NULL,
      name_en        VARCHAR(160) NULL,
      designation_bn VARCHAR(160) NULL,
      designation_en VARCHAR(160) NULL,
      bio_bn         TEXT         NULL,
      bio_en         TEXT         NULL,
      display_order  INT          NOT NULL DEFAULT 0,
      created_at     DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      KEY idx_guests_display_order (display_order),
      CONSTRAINT chk_guests_type CHECK (type IN ('CHIEF', 'SPECIAL'))
    ) ${TABLE_OPTIONS}
  `.execute(db);

  await sql`
    CREATE TABLE IF NOT EXISTS advisors (
      id              CHAR(36)     NOT NULL PRIMARY KEY,
      name            VARCHAR(160) NOT NULL,
      title           VARCHAR(160) NOT NULL,
      organization    VARCHAR(160) NULL,
      image_url       VARCHAR(512) NULL,
      name_bn         VARCHAR(160) NULL,
      name_en         VARCHAR(160) NULL,
      title_bn        VARCHAR(160) NULL,
      title_en        VARCHAR(160) NULL,
      organization_bn VARCHAR(160) NULL,
      organization_en VARCHAR(160) NULL,
      display_order   INT          NOT NULL DEFAULT 0,
      created_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      KEY idx_advisors_display_order (display_order)
    ) ${TABLE_OPTIONS}
  `.execute(db);

  await sql`
    CREATE TABLE IF NOT EXISTS management_members (
      id            CHAR(36)     NOT NULL PRIMARY KEY,
      name          VARCHAR(160) NOT NULL,
      role          VARCHAR(160) NOT NULL,
      contact       VARCHAR(160) NULL,
      image_url     VARCHAR(512) NULL,
      name_bn       VARCHAR(160) NULL,
      name_en       VARCHAR(160) NULL,
      role_bn       VARCHAR(160) NULL,
      role_en       VARCHAR(160) NULL,
      display_order INT          NOT NULL DEFAULT 0,
      created_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      KEY idx_management_members_display_order (display_order)
    ) ${TABLE_OPTIONS}
  `.execute(db);

  await sql`
    CREATE TABLE IF NOT EXISTS sponsors (
      id            CHAR(36)     NOT NULL PRIMARY KEY,
      name          VARCHAR(160) NOT NULL,
      category      VARCHAR(16)  NOT NULL DEFAULT 'PARTNER',
      logo_url      VARCHAR(512) NULL,
      website       VARCHAR(512) NULL,
      name_bn       VARCHAR(160) NULL,
      name_en       VARCHAR(160) NULL,
      category_bn   VARCHAR(64)  NULL,
      category_en   VARCHAR(64)  NULL,
      display_order INT          NOT NULL DEFAULT 0,
      created_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      KEY idx_sponsors_display_order (display_order),
      CONSTRAINT chk_sponsors_category CHECK (category IN ('TITLE', 'CO', 'PARTNER'))
    ) ${TABLE_OPTIONS}
  `.execute(db);

  await sql`
    CREATE TABLE IF NOT EXISTS brand_stalls (
      id            CHAR(36)     NOT NULL PRIMARY KEY,
      name          VARCHAR(160) NOT NULL,
      category      VARCHAR(64)  NOT NULL DEFAULT 'FOOD',
      logo_url      VARCHAR(512) NULL,
      name_bn       VARCHAR(160) NULL,
      name_en       VARCHAR(160) NULL,
      category_bn   VARCHAR(64)  NULL,
      category_en   VARCHAR(64)  NULL,
      display_order INT          NOT NULL DEFAULT 0,
      created_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      KEY idx_brand_stalls_display_order (display_order)
    ) ${TABLE_OPTIONS}
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const table of [
    'brand_stalls',
    'sponsors',
    'management_members',
    'advisors',
    'guests',
    'event_settings',
    'visitors',
    'ticket_tiers',
  ]) {
    await sql`DROP TABLE IF EXISTS ${sql.raw(table)}`.execute(db);
  }
}
