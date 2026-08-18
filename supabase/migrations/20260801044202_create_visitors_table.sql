/*
# Create visitors table for Foodiana 2026 festival registration

1. New Tables
- `visitors`
  - `id` (uuid, primary key) — unique visitor identifier
  - `qr_code_id` (text, unique, not null) — short human-readable code shown on QR, format FDL-XXXXXX
  - `name` (text, not null) — visitor full name
  - `email` (text, not null) — visitor email
  - `mobile` (text, not null) — visitor mobile number
  - `dob` (date, not null) — visitor date of birth
  - `profession` (text, not null) — visitor profession
  - `payment_status` (text, not null, default 'Pending') — 'Pending' or 'Paid'
  - `entry_status` (boolean, not null, default false) — whether visitor has entered the venue
  - `payment_method` (text, nullable) — 'Cash' or 'bKash', recorded when agent marks paid
  - `checked_in_at` (timestamptz, nullable) — timestamp of entry verification
  - `created_at` (timestamptz, default now()) — registration timestamp

2. Security
- Enable RLS on `visitors`.
- Allow anon + authenticated to INSERT (public registration).
- Allow anon + authenticated to SELECT (needed so registration success screen and agent scan can look up visitor by qr_code_id).
- Restrict UPDATE to authenticated only (agents/admins mark payment and entry status). This is a soft gate — the admin sign-in is enforced in the app UI; the DB allows authenticated writes.
- No DELETE policy (visitors cannot be deleted from the app).

3. Important Notes
1. The app has no public sign-in; registration is open to all visitors.
2. Admin/agent actions (mark paid, allow entry) require an authenticated Supabase session. The app enforces this with an admin sign-in screen.
3. qr_code_id is generated client-side as FDL-<6 random alphanumeric chars> and checked for uniqueness before insert.
4. payment_status and entry_status are never set directly by the visitor — they default to 'Pending' and false.
*/

CREATE TABLE IF NOT EXISTS visitors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  qr_code_id text UNIQUE NOT NULL,
  name text NOT NULL,
  email text NOT NULL,
  mobile text NOT NULL,
  dob date NOT NULL,
  profession text NOT NULL,
  payment_status text NOT NULL DEFAULT 'Pending',
  entry_status boolean NOT NULL DEFAULT false,
  payment_method text,
  checked_in_at timestamptz,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE visitors ENABLE ROW LEVEL SECURITY;

-- SELECT: allow anon + authenticated (registration lookup + agent scan lookup)
DROP POLICY IF EXISTS "anon_select_visitors" ON visitors;
CREATE POLICY "anon_select_visitors" ON visitors FOR SELECT
  TO anon, authenticated USING (true);

-- INSERT: allow anon + authenticated (public registration)
DROP POLICY IF EXISTS "anon_insert_visitors" ON visitors;
CREATE POLICY "anon_insert_visitors" ON visitors FOR INSERT
  TO anon, authenticated WITH CHECK (true);

-- UPDATE: authenticated only (agents/admins update payment + entry status)
DROP POLICY IF EXISTS "auth_update_visitors" ON visitors;
CREATE POLICY "auth_update_visitors" ON visitors FOR UPDATE
  TO authenticated USING (true) WITH CHECK (true);

-- Index for fast QR code lookup
CREATE INDEX IF NOT EXISTS idx_visitors_qr_code_id ON visitors (qr_code_id);
