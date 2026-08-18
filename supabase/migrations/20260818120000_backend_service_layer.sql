/*
# Backend service layer: lock down direct client access, add atomic gate functions

## Context
All database access now goes through the Fastify backend using the service-role
key, which bypasses RLS. The browser no longer holds Supabase credentials at all.

## 1. Revoke anon/authenticated access
Every `anon_*` policy created by the earlier migrations is dropped. With RLS
enabled and no policies present, the `anon` and `authenticated` roles are denied
on every table; only `service_role` (which bypasses RLS) can read or write.

This closes the previous posture, where anyone holding the public anon key could
INSERT, UPDATE or DELETE any row in any table — including marking their own
ticket paid or flipping their own entry_status.

## 2. get_visitor_metrics()
Returns every dashboard headline count in one round trip, counted inside
Postgres instead of five separate HTTP count queries from the API.

## 3. admit_visitor(uuid, text) / exit_visitor(uuid)
Atomic gate operations. Both take a transaction-scoped advisory lock so the
ground-capacity ceiling holds when several gates scan simultaneously against
several backend replicas.

Reading the count and then updating in application code is a race: two scans
that both observe `inside_now = capacity - 1` would both be admitted, putting
the venue over capacity. Doing the check and the write in one locked transaction
makes that impossible.

## 4. Notes
- These functions are SECURITY DEFINER with a pinned search_path, and EXECUTE is
  granted only to service_role.
- Re-running this migration is safe.
*/

-- ---------------------------------------------------------------------------
-- 1. Revoke direct anon / authenticated access on every table
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS "anon_select_visitors" ON visitors;
DROP POLICY IF EXISTS "anon_insert_visitors" ON visitors;
DROP POLICY IF EXISTS "anon_update_visitors" ON visitors;
DROP POLICY IF EXISTS "auth_update_visitors" ON visitors;

DROP POLICY IF EXISTS "anon_select_event_settings" ON event_settings;
DROP POLICY IF EXISTS "anon_update_event_settings" ON event_settings;

DROP POLICY IF EXISTS "anon_select_guests" ON guests;
DROP POLICY IF EXISTS "anon_insert_guests" ON guests;
DROP POLICY IF EXISTS "anon_update_guests" ON guests;
DROP POLICY IF EXISTS "anon_delete_guests" ON guests;

DROP POLICY IF EXISTS "anon_select_advisors" ON advisors;
DROP POLICY IF EXISTS "anon_insert_advisors" ON advisors;
DROP POLICY IF EXISTS "anon_update_advisors" ON advisors;
DROP POLICY IF EXISTS "anon_delete_advisors" ON advisors;

DROP POLICY IF EXISTS "anon_select_management" ON management_members;
DROP POLICY IF EXISTS "anon_insert_management" ON management_members;
DROP POLICY IF EXISTS "anon_update_management" ON management_members;
DROP POLICY IF EXISTS "anon_delete_management" ON management_members;

DROP POLICY IF EXISTS "anon_select_sponsors" ON sponsors;
DROP POLICY IF EXISTS "anon_insert_sponsors" ON sponsors;
DROP POLICY IF EXISTS "anon_update_sponsors" ON sponsors;
DROP POLICY IF EXISTS "anon_delete_sponsors" ON sponsors;

DROP POLICY IF EXISTS "anon_select_brand_stalls" ON brand_stalls;
DROP POLICY IF EXISTS "anon_insert_brand_stalls" ON brand_stalls;
DROP POLICY IF EXISTS "anon_update_brand_stalls" ON brand_stalls;
DROP POLICY IF EXISTS "anon_delete_brand_stalls" ON brand_stalls;

DROP POLICY IF EXISTS "anon_select_ticket_tiers" ON ticket_tiers;
DROP POLICY IF EXISTS "anon_insert_ticket_tiers" ON ticket_tiers;
DROP POLICY IF EXISTS "anon_update_ticket_tiers" ON ticket_tiers;
DROP POLICY IF EXISTS "anon_delete_ticket_tiers" ON ticket_tiers;

-- RLS stays ON with zero policies => deny-all for anon and authenticated.
ALTER TABLE visitors            ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_settings      ENABLE ROW LEVEL SECURITY;
ALTER TABLE guests              ENABLE ROW LEVEL SECURITY;
ALTER TABLE advisors            ENABLE ROW LEVEL SECURITY;
ALTER TABLE management_members  ENABLE ROW LEVEL SECURITY;
ALTER TABLE sponsors            ENABLE ROW LEVEL SECURITY;
ALTER TABLE brand_stalls        ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_tiers        ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- 2. Supporting indexes for the counts the dashboard and gate run constantly
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_visitors_occupancy
  ON visitors (entry_status, exited_status);
CREATE INDEX IF NOT EXISTS idx_visitors_payment_status
  ON visitors (payment_status);
CREATE INDEX IF NOT EXISTS idx_visitors_created_at
  ON visitors (created_at DESC);

-- ---------------------------------------------------------------------------
-- 3. get_visitor_metrics()
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION get_visitor_metrics()
RETURNS TABLE (
  total      bigint,
  paid       bigint,
  checked_in bigint,
  exited     bigint,
  inside_now bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    count(*)                                                              AS total,
    count(*) FILTER (WHERE payment_status = 'Paid')                       AS paid,
    count(*) FILTER (WHERE entry_status)                                  AS checked_in,
    count(*) FILTER (WHERE exited_status)                                 AS exited,
    count(*) FILTER (WHERE entry_status AND NOT exited_status)             AS inside_now
  FROM visitors;
$$;

-- ---------------------------------------------------------------------------
-- 4. admit_visitor() — capacity check and admission in one atomic step
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION admit_visitor(
  p_visitor_id     uuid,
  p_payment_method text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_capacity int;
  v_inside   bigint;
  v_visitor  visitors;
BEGIN
  -- Serialise all gate admissions for the duration of this transaction so the
  -- capacity check below cannot be overtaken by a concurrent scan. Released
  -- automatically on commit or rollback.
  PERFORM pg_advisory_xact_lock(hashtext('foodiana:gate:admit'));

  SELECT coalesce(ground_capacity, 2000) INTO v_capacity
    FROM event_settings WHERE id = 1;
  v_capacity := coalesce(v_capacity, 2000);

  SELECT * INTO v_visitor FROM visitors WHERE id = p_visitor_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;

  IF v_visitor.exited_status THEN
    RETURN jsonb_build_object(
      'status', 'already_exited',
      'visitor', to_jsonb(v_visitor),
      'capacity', v_capacity
    );
  END IF;

  IF v_visitor.entry_status THEN
    RETURN jsonb_build_object(
      'status', 'already_inside',
      'visitor', to_jsonb(v_visitor),
      'capacity', v_capacity
    );
  END IF;

  SELECT count(*) INTO v_inside
    FROM visitors WHERE entry_status AND NOT exited_status;

  IF v_inside >= v_capacity THEN
    RETURN jsonb_build_object(
      'status', 'capacity_full',
      'inside_now', v_inside,
      'capacity', v_capacity
    );
  END IF;

  UPDATE visitors
     SET payment_status = 'Paid',
         payment_method = coalesce(p_payment_method, payment_method),
         entry_status   = true,
         checked_in_at  = now()
   WHERE id = p_visitor_id
  RETURNING * INTO v_visitor;

  RETURN jsonb_build_object(
    'status',     'admitted',
    'visitor',    to_jsonb(v_visitor),
    'inside_now', v_inside + 1,
    'capacity',   v_capacity
  );
END;
$$;

-- ---------------------------------------------------------------------------
-- 5. exit_visitor() — atomic exit, frees a capacity slot
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION exit_visitor(p_visitor_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_capacity int;
  v_inside   bigint;
  v_visitor  visitors;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('foodiana:gate:admit'));

  SELECT coalesce(ground_capacity, 2000) INTO v_capacity
    FROM event_settings WHERE id = 1;
  v_capacity := coalesce(v_capacity, 2000);

  SELECT * INTO v_visitor FROM visitors WHERE id = p_visitor_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;

  IF NOT v_visitor.entry_status THEN
    RETURN jsonb_build_object(
      'status', 'not_entered',
      'visitor', to_jsonb(v_visitor),
      'capacity', v_capacity
    );
  END IF;

  IF v_visitor.exited_status THEN
    SELECT count(*) INTO v_inside
      FROM visitors WHERE entry_status AND NOT exited_status;
    RETURN jsonb_build_object(
      'status', 'already_exited',
      'visitor', to_jsonb(v_visitor),
      'inside_now', v_inside,
      'capacity', v_capacity
    );
  END IF;

  UPDATE visitors
     SET exited_status = true,
         exited_at     = now()
   WHERE id = p_visitor_id
  RETURNING * INTO v_visitor;

  SELECT count(*) INTO v_inside
    FROM visitors WHERE entry_status AND NOT exited_status;

  RETURN jsonb_build_object(
    'status',     'exited',
    'visitor',    to_jsonb(v_visitor),
    'inside_now', v_inside,
    'capacity',   v_capacity
  );
END;
$$;

-- ---------------------------------------------------------------------------
-- 6. Only the backend may call these
-- ---------------------------------------------------------------------------

REVOKE ALL ON FUNCTION get_visitor_metrics()            FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION admit_visitor(uuid, text)        FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION exit_visitor(uuid)               FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION get_visitor_metrics()         TO service_role;
GRANT EXECUTE ON FUNCTION admit_visitor(uuid, text)     TO service_role;
GRANT EXECUTE ON FUNCTION exit_visitor(uuid)            TO service_role;
