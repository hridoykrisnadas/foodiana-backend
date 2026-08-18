/*
# Create guests, advisors, management_members, and sponsors tables

1. New Tables
- `guests` — Chief Guest & Special Guests (PM, diplomats, delegates)
  - id, type ('CHIEF' | 'SPECIAL'), name, designation, image_url, bio, display_order, created_at
- `advisors` — Advisory team
  - id, name, title, organization, image_url, display_order, created_at
- `management_members` — Event management team
  - id, name, role, contact, image_url, display_order, created_at
- `sponsors` — Sponsors and brand partners
  - id, name, category ('TITLE' | 'CO' | 'PARTNER'), logo_url, website, display_order, created_at

2. Security
- All tables: RLS enabled.
- SELECT: anon + authenticated (public reads on landing page).
- INSERT/UPDATE/DELETE: anon + authenticated (admin manages via dashboard; access control enforced at app UI level by admin password gate).
- display_order for custom ordering in carousels.

3. Seed Data
- Inserts default rows for each table so the landing page carousels have content immediately.
*/

-- Guests
CREATE TABLE IF NOT EXISTS guests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type text NOT NULL DEFAULT 'SPECIAL' CHECK (type IN ('CHIEF', 'SPECIAL')),
  name text NOT NULL,
  designation text NOT NULL,
  image_url text,
  bio text,
  display_order int NOT NULL DEFAULT 0,
  created_at timestamptz DEFAULT now()
);
ALTER TABLE guests ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anon_select_guests" ON guests;
CREATE POLICY "anon_select_guests" ON guests FOR SELECT TO anon, authenticated USING (true);
DROP POLICY IF EXISTS "anon_insert_guests" ON guests;
CREATE POLICY "anon_insert_guests" ON guests FOR INSERT TO anon, authenticated WITH CHECK (true);
DROP POLICY IF EXISTS "anon_update_guests" ON guests;
CREATE POLICY "anon_update_guests" ON guests FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "anon_delete_guests" ON guests;
CREATE POLICY "anon_delete_guests" ON guests FOR DELETE TO anon, authenticated USING (true);

-- Advisors
CREATE TABLE IF NOT EXISTS advisors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  title text NOT NULL,
  organization text,
  image_url text,
  display_order int NOT NULL DEFAULT 0,
  created_at timestamptz DEFAULT now()
);
ALTER TABLE advisors ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anon_select_advisors" ON advisors;
CREATE POLICY "anon_select_advisors" ON advisors FOR SELECT TO anon, authenticated USING (true);
DROP POLICY IF EXISTS "anon_insert_advisors" ON advisors;
CREATE POLICY "anon_insert_advisors" ON advisors FOR INSERT TO anon, authenticated WITH CHECK (true);
DROP POLICY IF EXISTS "anon_update_advisors" ON advisors;
CREATE POLICY "anon_update_advisors" ON advisors FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "anon_delete_advisors" ON advisors;
CREATE POLICY "anon_delete_advisors" ON advisors FOR DELETE TO anon, authenticated USING (true);

-- Management Members
CREATE TABLE IF NOT EXISTS management_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  role text NOT NULL,
  contact text,
  image_url text,
  display_order int NOT NULL DEFAULT 0,
  created_at timestamptz DEFAULT now()
);
ALTER TABLE management_members ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anon_select_management" ON management_members;
CREATE POLICY "anon_select_management" ON management_members FOR SELECT TO anon, authenticated USING (true);
DROP POLICY IF EXISTS "anon_insert_management" ON management_members;
CREATE POLICY "anon_insert_management" ON management_members FOR INSERT TO anon, authenticated WITH CHECK (true);
DROP POLICY IF EXISTS "anon_update_management" ON management_members;
CREATE POLICY "anon_update_management" ON management_members FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "anon_delete_management" ON management_members;
CREATE POLICY "anon_delete_management" ON management_members FOR DELETE TO anon, authenticated USING (true);

-- Sponsors
CREATE TABLE IF NOT EXISTS sponsors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  category text NOT NULL DEFAULT 'PARTNER' CHECK (category IN ('TITLE', 'CO', 'PARTNER')),
  logo_url text,
  website text,
  display_order int NOT NULL DEFAULT 0,
  created_at timestamptz DEFAULT now()
);
ALTER TABLE sponsors ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anon_select_sponsors" ON sponsors;
CREATE POLICY "anon_select_sponsors" ON sponsors FOR SELECT TO anon, authenticated USING (true);
DROP POLICY IF EXISTS "anon_insert_sponsors" ON sponsors;
CREATE POLICY "anon_insert_sponsors" ON sponsors FOR INSERT TO anon, authenticated WITH CHECK (true);
DROP POLICY IF EXISTS "anon_update_sponsors" ON sponsors;
CREATE POLICY "anon_update_sponsors" ON sponsors FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "anon_delete_sponsors" ON sponsors;
CREATE POLICY "anon_delete_sponsors" ON sponsors FOR DELETE TO anon, authenticated USING (true);

-- Seed: Guests
INSERT INTO guests (type, name, designation, bio, display_order) VALUES
  ('CHIEF', 'মাননীয় প্রধানমন্ত্রী', 'বাংলাদেশ সরকার', 'প্রধান অতিথি', 1),
  ('SPECIAL', 'বিদেশি রাষ্ট্রদূত', 'কূটনৈতিক মিশন', 'বিশেষ অতিথি', 2),
  ('SPECIAL', 'সম্মানিত মন্ত্রী', 'বাংলাদেশ সরকার', 'বিশেষ অতিথি', 3),
  ('SPECIAL', 'সেলিব্রিটি অতিথি', 'বিনোদন জগৎ', 'বিশেষ অতিথি', 4)
ON CONFLICT DO NOTHING;

-- Seed: Advisors
INSERT INTO advisors (name, title, organization, display_order) VALUES
  ('উপদেষ্টা ১', 'প্রধান উপদেষ্টা', 'ফুডিয়ানা কমিটি', 1),
  ('উপদেষ্টা ২', 'সাংস্কৃতিক উপদেষ্টা', 'সংস্কৃতি মন্ত্রণালয়', 2),
  ('উপদেষ্টা ৩', 'পরিবেশ উপদেষ্টা', 'পরিবেশ অধিদপ্তর', 3),
  ('উপদেষ্টা ৪', 'রন্ধনশিল্প উপদেষ্টা', 'শেফ অ্যাসোসিয়েশন', 4)
ON CONFLICT DO NOTHING;

-- Seed: Management
INSERT INTO management_members (name, role, contact, display_order) VALUES
  ('ব্যবস্থাপনা ১', 'ইভেন্ট পরিচালক', '+8801700000001', 1),
  ('ব্যবস্থাপনা ২', 'অপারেশন লিড', '+8801700000002', 2),
  ('ব্যবস্থাপনা ৩', 'প্রোগ্রাম কো-অর্ডিনেটর', '+8801700000003', 3),
  ('ব্যবস্থাপনা ৪', 'পাবলিক রিলেশনস', '+8801700000004', 4)
ON CONFLICT DO NOTHING;

-- Seed: Sponsors
INSERT INTO sponsors (name, category, website, display_order) VALUES
  ('মেগা কর্পোরেশন', 'TITLE', 'https://example.com', 1),
  ('প্রাইম ব্যাংক', 'CO', 'https://example.com', 2),
  ('চ্যানেল বিডি', 'PARTNER', 'https://example.com', 3),
  ('ফাস্টপে', 'PARTNER', 'https://example.com', 4),
  ('মুভইট', 'PARTNER', 'https://example.com', 5)
ON CONFLICT DO NOTHING;
