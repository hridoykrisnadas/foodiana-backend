/*
# Update visitors RLS to allow anon updates

1. Security Changes
- Drop the authenticated-only UPDATE policy.
- Create a new UPDATE policy allowing anon + authenticated to update visitor records.
- This is required because the agent gate scanner and admin dashboard both update payment_status and entry_status without Supabase auth sign-in (prototype). Access control is enforced at the app UI level (admin password gate, dedicated /agent/scan route).
- SELECT and INSERT policies remain unchanged (already allow anon + authenticated).

2. Important Notes
1. In a production deployment, admin and agent actions should go through Supabase auth or a SECURITY DEFINER function with proper role checks.
2. For this prototype, the admin dashboard is protected by a client-side password gate, and the agent scanner is on a dedicated route.
*/

DROP POLICY IF EXISTS "auth_update_visitors" ON visitors;

CREATE POLICY "anon_update_visitors" ON visitors FOR UPDATE
  TO anon, authenticated USING (true) WITH CHECK (true);
