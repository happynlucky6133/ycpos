-- YCPos Supabase security hardening
-- Run in Supabase SQL Editor before production launch.
-- This script tightens grants. It does not delete business data.

BEGIN;

-- 1) Legacy plaintext users table should not be used by formal YCPos.
-- Keep the table for historical backup, but block browser/API access.
DO $$
BEGIN
  IF to_regclass('public.users') IS NOT NULL THEN
    ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
    REVOKE ALL ON TABLE public.users FROM anon;
    REVOKE ALL ON TABLE public.users FROM authenticated;
  END IF;
END;
$$;

-- 2) Anonymous users should not access YCPos business tables directly.
REVOKE ALL ON TABLE public.staff_profiles FROM anon;
REVOKE ALL ON TABLE public.products FROM anon;
REVOKE ALL ON TABLE public.suppliers FROM anon;
REVOKE ALL ON TABLE public.customers FROM anon;
REVOKE ALL ON TABLE public.stock_ins FROM anon;
REVOKE ALL ON TABLE public.stock_in_details FROM anon;
REVOKE ALL ON TABLE public.purchase_orders FROM anon;
REVOKE ALL ON TABLE public.po_details FROM anon;
REVOKE ALL ON TABLE public.processing_logs FROM anon;
REVOKE ALL ON TABLE public.audit_logs FROM anon;
REVOKE ALL ON TABLE public.autocount_sync_queue FROM anon;

-- 3) Authenticated users may read through RLS, but direct table writes should go through RPC only.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.staff_profiles FROM authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.products FROM authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.suppliers FROM authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.customers FROM authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.stock_ins FROM authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.stock_in_details FROM authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.purchase_orders FROM authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.po_details FROM authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.processing_logs FROM authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.audit_logs FROM authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.autocount_sync_queue FROM authenticated;

-- Keep authenticated SELECT because the app reads these tables directly and RLS filters by role.
GRANT SELECT ON TABLE public.staff_profiles TO authenticated;
GRANT SELECT ON TABLE public.products TO authenticated;
GRANT SELECT ON TABLE public.suppliers TO authenticated;
GRANT SELECT ON TABLE public.customers TO authenticated;
GRANT SELECT ON TABLE public.stock_ins TO authenticated;
GRANT SELECT ON TABLE public.stock_in_details TO authenticated;
GRANT SELECT ON TABLE public.purchase_orders TO authenticated;
GRANT SELECT ON TABLE public.po_details TO authenticated;
GRANT SELECT ON TABLE public.processing_logs TO authenticated;
GRANT SELECT ON TABLE public.audit_logs TO authenticated;
GRANT SELECT ON TABLE public.autocount_sync_queue TO authenticated;

-- 4) RPC functions should not be executable by anonymous users.
-- Revoke broadly to cover old/new function signatures.
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM anon;

-- 5) Logged-in users may execute app RPC functions.
-- Function bodies still enforce role checks through require_role().
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO authenticated;

-- Do not expose direct audit writes to the browser. App writes audit only inside SECURITY DEFINER RPCs.
DO $$
BEGIN
  IF to_regprocedure('public.write_audit(text,text,text)') IS NOT NULL THEN
    REVOKE EXECUTE ON FUNCTION public.write_audit(TEXT, TEXT, TEXT) FROM authenticated;
  END IF;
END;
$$;

COMMIT;
