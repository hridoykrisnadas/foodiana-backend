/*
# Create brand_stalls table for the Stalls slider on the landing page

1. New Table
- `brand_stalls` — Brands that have booked stalls at the festival
  - id, name, category, logo_url, display_order, created_at

2. Security
- RLS enabled. SELECT for anon+authenticated (public reads). INSERT/UPDATE/DELETE for anon+authenticated (admin manages).

3. Seed Data
- Inserts a few default brand entries so the stalls slider has content immediately.
*/

CREATE TABLE IF NOT EXISTS brand_stalls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  category text NOT NULL DEFAULT 'FOOD',
  logo_url text,
  display_order int NOT NULL DEFAULT 0,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE brand_stalls ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_select_brand_stalls" ON brand_stalls;
CREATE POLICY "anon_select_brand_stalls" ON brand_stalls FOR SELECT
  TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "anon_insert_brand_stalls" ON brand_stalls;
CREATE POLICY "anon_insert_brand_stalls" ON brand_stalls FOR INSERT
  TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "anon_update_brand_stalls" ON brand_stalls;
CREATE POLICY "anon_update_brand_stalls" ON brand_stalls FOR UPDATE
  TO anon, authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "anon_delete_brand_stalls" ON brand_stalls;
CREATE POLICY "anon_delete_brand_stalls" ON brand_stalls FOR DELETE
  TO anon, authenticated USING (true);

-- Seed data
INSERT INTO brand_stalls (name, category, display_order) VALUES
  ('Spice Route', 'FOOD', 1),
  ('Green Kitchen', 'VEGETARIAN', 2),
  ('Global Bites', 'INTERNATIONAL', 3),
  ('Heritage Sweets', 'FOOD', 4),
  ('Street Eats', 'STREET FOOD', 5),
  ('Earth Goods', 'SUSTAINABILITY', 6)
ON CONFLICT DO NOTHING;
