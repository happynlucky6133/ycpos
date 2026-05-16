-- YCPos Supabase pre-launch security check
-- Read-only. Run in Supabase SQL Editor before going live.
-- Review every result set. Rows marked WARN / REVIEW need attention.

-- 1) RLS status for YCPos business tables.
SELECT
  '01_rls_status' AS check_name,
  n.nspname AS schema_name,
  c.relname AS table_name,
  CASE WHEN c.relrowsecurity THEN 'OK' ELSE 'WARN_RLS_DISABLED' END AS status,
  c.relforcerowsecurity AS force_rls
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relkind = 'r'
  AND c.relname IN (
    'staff_profiles',
    'products',
    'suppliers',
    'customers',
    'stock_ins',
    'stock_in_details',
    'purchase_orders',
    'po_details',
    'processing_logs',
    'audit_logs',
    'autocount_sync_queue',
    'users'
  )
ORDER BY c.relname;

-- 2) Tables in public schema with RLS disabled.
-- Some legacy tables may appear here. Any active business table should not.
SELECT
  '02_public_tables_without_rls' AS check_name,
  n.nspname AS schema_name,
  c.relname AS table_name,
  'WARN_RLS_DISABLED' AS status
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relkind = 'r'
  AND c.relrowsecurity = false
ORDER BY c.relname;

-- 3) All YCPos RLS policies.
SELECT
  '03_rls_policies' AS check_name,
  schemaname,
  tablename,
  policyname,
  cmd,
  roles,
  qual AS using_expression,
  with_check AS with_check_expression
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename IN (
    'staff_profiles',
    'products',
    'suppliers',
    'customers',
    'stock_ins',
    'stock_in_details',
    'purchase_orders',
    'po_details',
    'processing_logs',
    'audit_logs',
    'autocount_sync_queue',
    'users'
  )
ORDER BY tablename, policyname;

-- 4) Policies that look broadly public.
-- REVIEW does not always mean wrong, but inspect carefully.
SELECT
  '04_broad_policies_review' AS check_name,
  schemaname,
  tablename,
  policyname,
  cmd,
  roles,
  qual AS using_expression,
  with_check AS with_check_expression,
  'REVIEW_BROAD_POLICY' AS status
FROM pg_policies
WHERE schemaname = 'public'
  AND (
    roles::text ILIKE '%anon%'
    OR roles::text ILIKE '%public%'
    OR COALESCE(qual, '') IN ('true', '(true)')
    OR COALESCE(with_check, '') IN ('true', '(true)')
  )
ORDER BY tablename, policyname;

-- 5) Direct table privileges granted to anon/authenticated.
-- SELECT for authenticated can be acceptable only when RLS is correct.
-- INSERT/UPDATE/DELETE on business tables should usually be REVIEW unless intentionally needed.
SELECT
  '05_table_grants_review' AS check_name,
  table_schema,
  table_name,
  grantee,
  privilege_type,
  CASE
    WHEN grantee = 'anon' THEN 'WARN_ANON_TABLE_GRANT'
    WHEN privilege_type IN ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER') THEN 'REVIEW_WRITE_GRANT'
    ELSE 'REVIEW'
  END AS status
FROM information_schema.table_privileges
WHERE table_schema = 'public'
  AND grantee IN ('anon', 'authenticated')
  AND table_name IN (
    'staff_profiles',
    'products',
    'suppliers',
    'customers',
    'stock_ins',
    'stock_in_details',
    'purchase_orders',
    'po_details',
    'processing_logs',
    'audit_logs',
    'autocount_sync_queue',
    'users'
  )
ORDER BY table_name, grantee, privilege_type;

-- 6) YCPos RPC functions and execution grants.
SELECT
  '06_rpc_function_grants' AS check_name,
  n.nspname AS schema_name,
  p.proname AS function_name,
  pg_get_function_identity_arguments(p.oid) AS arguments,
  r.rolname AS grantee,
  CASE
    WHEN r.rolname = 'anon' THEN 'WARN_ANON_CAN_EXECUTE'
    WHEN r.rolname = 'authenticated' THEN 'OK_AUTHENTICATED_CAN_EXECUTE'
    ELSE 'REVIEW'
  END AS status
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
JOIN pg_roles r ON has_function_privilege(r.oid, p.oid, 'EXECUTE')
WHERE n.nspname = 'public'
  AND p.proname IN (
    'app_role',
    'app_display_name',
    'require_role',
    'write_audit',
    'create_staff_profile',
    'create_stock_in',
    'create_product',
    'create_supplier',
    'create_customer',
    'process_fruit_loss',
    'create_sales_order',
    'change_sales_order_status',
    'get_orders_app'
  )
  AND r.rolname IN ('anon', 'authenticated')
ORDER BY p.proname, r.rolname;

-- 7) SECURITY DEFINER function review.
-- SECURITY DEFINER is expected for YCPos RPC, but search_path should be fixed.
SELECT
  '07_security_definer_review' AS check_name,
  n.nspname AS schema_name,
  p.proname AS function_name,
  pg_get_function_identity_arguments(p.oid) AS arguments,
  CASE WHEN p.prosecdef THEN 'SECURITY_DEFINER' ELSE 'SECURITY_INVOKER' END AS security_mode,
  COALESCE(array_to_string(p.proconfig, ', '), '') AS function_settings,
  CASE
    WHEN p.prosecdef AND COALESCE(array_to_string(p.proconfig, ', '), '') NOT ILIKE '%search_path%' THEN 'WARN_MISSING_FIXED_SEARCH_PATH'
    WHEN p.prosecdef THEN 'OK_REVIEW_BODY'
    ELSE 'OK'
  END AS status
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN (
    'app_role',
    'app_display_name',
    'require_role',
    'write_audit',
    'create_staff_profile',
    'create_stock_in',
    'create_product',
    'create_supplier',
    'create_customer',
    'process_fruit_loss',
    'create_sales_order',
    'change_sales_order_status',
    'get_orders_app'
  )
ORDER BY p.proname;

-- 8) Legacy plaintext users table check.
-- Formal YCPos should use Supabase Auth + staff_profiles, not public.users.
SELECT
  '08_legacy_users_table' AS check_name,
  CASE
    WHEN to_regclass('public.users') IS NULL THEN 'OK_NO_LEGACY_USERS_TABLE'
    ELSE 'WARN_LEGACY_USERS_TABLE_EXISTS'
  END AS status,
  COALESCE((SELECT COUNT(*)::text FROM public.users), '0') AS row_count_if_exists;

-- 9) Staff profile role sanity.
SELECT
  '09_staff_profiles_role_sanity' AS check_name,
  "Role",
  COUNT(*) AS staff_count,
  CASE
    WHEN "Role" IN ('admin', 'sales', 'purchase', 'warehouse') THEN 'OK'
    ELSE 'WARN_INVALID_ROLE'
  END AS status
FROM staff_profiles
GROUP BY "Role"
ORDER BY "Role";

-- 10) Inactive staff accounts.
SELECT
  '10_inactive_staff_accounts' AS check_name,
  id,
  "DisplayName",
  "Role",
  "Active",
  CASE WHEN "Active" = false THEN 'REVIEW_INACTIVE' ELSE 'OK' END AS status
FROM staff_profiles
WHERE "Active" = false
ORDER BY "DisplayName";

-- 11) Auth users without staff profile.
-- These users can exist, but they cannot use YCPos until a staff_profiles row is created.
SELECT
  '11_auth_users_without_staff_profile' AS check_name,
  u.id,
  u.email,
  u.created_at,
  CASE WHEN sp.id IS NULL THEN 'REVIEW_NO_STAFF_PROFILE' ELSE 'OK' END AS status
FROM auth.users u
LEFT JOIN staff_profiles sp ON sp.id = u.id
WHERE sp.id IS NULL
ORDER BY u.created_at DESC;
