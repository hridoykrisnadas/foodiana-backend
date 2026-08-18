/*
# Add bilingual (BN/EN) columns to CRUD tables

1. Purpose
   All CRUD forms for Guests, Advisors, Management, Sponsors, and Brand Stalls
   must support separate Bengali and English input fields. This migration adds
   `_bn` and `_en` columns for every text field that previously had a single
   language-agnostic column, and backfills them from the existing values so no
   data is lost.

2. Tables modified
   - guests:        name_bn, name_en, designation_bn, designation_en, bio_bn, bio_en
   - advisors:      name_bn, name_en, title_bn, title_en, organization_bn, organization_en
   - management_members: name_bn, name_en, role_bn, role_en
   - sponsors:      name_bn, name_en, category_bn, category_en
   - brand_stalls:  name_bn, name_en, category_bn, category_en

3. Backfill
   Each new column is populated from its original counterpart (e.g. name -> name_bn)
   so existing rows remain usable. Original columns are kept (not dropped) to avoid
   data loss; the app will read from the _bn/_en columns going forward.

4. Security
   No RLS policy changes — existing policies already allow anon+authenticated CRUD.
   New columns inherit the table's existing RLS posture automatically.
*/

-- guests
ALTER TABLE guests ADD COLUMN IF NOT EXISTS name_bn text;
ALTER TABLE guests ADD COLUMN IF NOT EXISTS name_en text;
ALTER TABLE guests ADD COLUMN IF NOT EXISTS designation_bn text;
ALTER TABLE guests ADD COLUMN IF NOT EXISTS designation_en text;
ALTER TABLE guests ADD COLUMN IF NOT EXISTS bio_bn text;
ALTER TABLE guests ADD COLUMN IF NOT EXISTS bio_en text;
UPDATE guests SET name_bn = COALESCE(name_bn, name) WHERE name_bn IS NULL;
UPDATE guests SET name_en = COALESCE(name_en, name) WHERE name_en IS NULL;
UPDATE guests SET designation_bn = COALESCE(designation_bn, designation) WHERE designation_bn IS NULL;
UPDATE guests SET designation_en = COALESCE(designation_en, designation) WHERE designation_en IS NULL;
UPDATE guests SET bio_bn = COALESCE(bio_bn, bio) WHERE bio_bn IS NULL;
UPDATE guests SET bio_en = COALESCE(bio_en, bio) WHERE bio_en IS NULL;

-- advisors
ALTER TABLE advisors ADD COLUMN IF NOT EXISTS name_bn text;
ALTER TABLE advisors ADD COLUMN IF NOT EXISTS name_en text;
ALTER TABLE advisors ADD COLUMN IF NOT EXISTS title_bn text;
ALTER TABLE advisors ADD COLUMN IF NOT EXISTS title_en text;
ALTER TABLE advisors ADD COLUMN IF NOT EXISTS organization_bn text;
ALTER TABLE advisors ADD COLUMN IF NOT EXISTS organization_en text;
UPDATE advisors SET name_bn = COALESCE(name_bn, name) WHERE name_bn IS NULL;
UPDATE advisors SET name_en = COALESCE(name_en, name) WHERE name_en IS NULL;
UPDATE advisors SET title_bn = COALESCE(title_bn, title) WHERE title_bn IS NULL;
UPDATE advisors SET title_en = COALESCE(title_en, title) WHERE title_en IS NULL;
UPDATE advisors SET organization_bn = COALESCE(organization_bn, organization) WHERE organization_bn IS NULL;
UPDATE advisors SET organization_en = COALESCE(organization_en, organization) WHERE organization_en IS NULL;

-- management_members
ALTER TABLE management_members ADD COLUMN IF NOT EXISTS name_bn text;
ALTER TABLE management_members ADD COLUMN IF NOT EXISTS name_en text;
ALTER TABLE management_members ADD COLUMN IF NOT EXISTS role_bn text;
ALTER TABLE management_members ADD COLUMN IF NOT EXISTS role_en text;
UPDATE management_members SET name_bn = COALESCE(name_bn, name) WHERE name_bn IS NULL;
UPDATE management_members SET name_en = COALESCE(name_en, name) WHERE name_en IS NULL;
UPDATE management_members SET role_bn = COALESCE(role_bn, role) WHERE role_bn IS NULL;
UPDATE management_members SET role_en = COALESCE(role_en, role) WHERE role_en IS NULL;

-- sponsors
ALTER TABLE sponsors ADD COLUMN IF NOT EXISTS name_bn text;
ALTER TABLE sponsors ADD COLUMN IF NOT EXISTS name_en text;
ALTER TABLE sponsors ADD COLUMN IF NOT EXISTS category_bn text;
ALTER TABLE sponsors ADD COLUMN IF NOT EXISTS category_en text;
UPDATE sponsors SET name_bn = COALESCE(name_bn, name) WHERE name_bn IS NULL;
UPDATE sponsors SET name_en = COALESCE(name_en, name) WHERE name_en IS NULL;
UPDATE sponsors SET category_bn = COALESCE(category_bn, category) WHERE category_bn IS NULL;
UPDATE sponsors SET category_en = COALESCE(category_en, category) WHERE category_en IS NULL;

-- brand_stalls
ALTER TABLE brand_stalls ADD COLUMN IF NOT EXISTS name_bn text;
ALTER TABLE brand_stalls ADD COLUMN IF NOT EXISTS name_en text;
ALTER TABLE brand_stalls ADD COLUMN IF NOT EXISTS category_bn text;
ALTER TABLE brand_stalls ADD COLUMN IF NOT EXISTS category_en text;
UPDATE brand_stalls SET name_bn = COALESCE(name_bn, name) WHERE name_bn IS NULL;
UPDATE brand_stalls SET name_en = COALESCE(name_en, name) WHERE name_en IS NULL;
UPDATE brand_stalls SET category_bn = COALESCE(category_bn, category) WHERE category_bn IS NULL;
UPDATE brand_stalls SET category_en = COALESCE(category_en, category) WHERE category_en IS NULL;
