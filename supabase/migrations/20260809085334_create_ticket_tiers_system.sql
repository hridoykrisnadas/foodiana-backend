-- Ticket tiers for time-based pricing and capacity management

CREATE TABLE IF NOT EXISTS ticket_tiers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  day text NOT NULL, -- 'Thursday', 'Friday', 'Saturday'
  start_time text NOT NULL, -- '11:00'
  end_time text NOT NULL, -- '23:59'
  price integer NOT NULL, -- in Taka
  includes_concert boolean NOT NULL DEFAULT false,
  label_en text,
  label_bn text,
  is_active boolean NOT NULL DEFAULT true,
  display_order integer NOT NULL DEFAULT 0,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE ticket_tiers ENABLE ROW LEVEL SECURITY;

CREATE POLICY "anon_select_ticket_tiers" ON ticket_tiers FOR SELECT
  TO anon, authenticated USING (true);
CREATE POLICY "anon_insert_ticket_tiers" ON ticket_tiers FOR INSERT
  TO anon, authenticated WITH CHECK (true);
CREATE POLICY "anon_update_ticket_tiers" ON ticket_tiers FOR UPDATE
  TO anon, authenticated USING (true) WITH CHECK (true);
CREATE POLICY "anon_delete_ticket_tiers" ON ticket_tiers FOR DELETE
  TO anon, authenticated USING (true);

-- Add ticket tier + entry tracking columns to visitors
ALTER TABLE visitors
  ADD COLUMN IF NOT EXISTS ticket_tier_id uuid REFERENCES ticket_tiers(id),
  ADD COLUMN IF NOT EXISTS ticket_price integer,
  ADD COLUMN IF NOT EXISTS includes_concert boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS exited_status boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS exited_at timestamptz;

-- Add ground capacity to event_settings
ALTER TABLE event_settings
  ADD COLUMN IF NOT EXISTS ground_capacity integer NOT NULL DEFAULT 2000;

-- Seed default ticket tiers
INSERT INTO ticket_tiers (day, start_time, end_time, price, includes_concert, label_en, label_bn, display_order) VALUES
  ('Thursday', '11:00', '17:00', 100, false, 'Thursday Day Pass', 'বৃহস্পতিবার দিবাল পাস', 1),
  ('Thursday', '17:00', '23:59', 200, true, 'Thursday Evening + Concert', 'বৃহস্পতিবার সন্ধ্যা + কনসার্ট', 2),
  ('Friday', '11:00', '17:00', 100, false, 'Friday Day Pass', 'শুক্রবার দিবাল পাস', 3),
  ('Friday', '17:00', '23:59', 250, true, 'Friday Evening + Concert', 'শুক্রবার সন্ধ্যা + কনসার্ট', 4),
  ('Saturday', '11:00', '17:00', 100, false, 'Saturday Day Pass', 'শনিবার দিবাল পাস', 5),
  ('Saturday', '17:00', '23:59', 350, true, 'Saturday Evening + Concert', 'শনিবার সন্ধ্যা + কনসার্ট', 6)
ON CONFLICT DO NOTHING;
