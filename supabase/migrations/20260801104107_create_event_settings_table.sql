/*
# Create event_settings table for adjustable countdown date

1. New Tables
- `event_settings`
  - `id` (int, primary key, always 1) — singleton row for global settings
  - `event_date` (date, not null) — target date for the frontend countdown timer
  - `event_end_date` (date, nullable) — end date of the event
  - `updated_at` (timestamptz, default now()) — last modification timestamp

2. Security
- Enable RLS on `event_settings`.
- Allow anon + authenticated to SELECT (frontend reads countdown date).
- Allow anon + authenticated to UPDATE (admin updates the date from the dashboard).

3. Important Notes
1. Only one row should exist (id=1). The migration inserts a default row with event_date = 2026-11-05.
2. The admin dashboard updates this row to change the countdown target.
*/

CREATE TABLE IF NOT EXISTS event_settings (
  id int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  event_date date NOT NULL,
  event_end_date date,
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE event_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_select_event_settings" ON event_settings;
CREATE POLICY "anon_select_event_settings" ON event_settings FOR SELECT
  TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "anon_update_event_settings" ON event_settings;
CREATE POLICY "anon_update_event_settings" ON event_settings FOR UPDATE
  TO anon, authenticated USING (true) WITH CHECK (true);

-- Insert default row if not exists
INSERT INTO event_settings (id, event_date, event_end_date)
SELECT 1, '2026-11-05', '2026-11-07'
WHERE NOT EXISTS (SELECT 1 FROM event_settings WHERE id = 1);
