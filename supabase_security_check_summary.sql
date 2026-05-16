-- YCPos Supabase pre-launch security check summary
-- Read-only. Run in Supabase SQL Editor.
-- This version returns one combined result table with only WARN / REVIEW items.
-- If it returns zero rows, the main security checks did not find obvious launch blockers.

WITH tracked_tables(table_name) AS (
  VALUES
    ('staff_profiles'),
    ('products'),
    ('suppliers'),
    ('customers'),
    ('stock_ins'),
    ('stock_in_details'),
    ('purchase_orders'),
    ('po_details'),
    ('processing_logs'),
    ('audit_logs'),
    ('autocount_sync_queue'),
    ('users')
),
tracked_functions(function_name) AS (
  VALUES
    ('app_role'),
    ('app_display_name'),
    ('require_role'),
    ('write_audit'),
    ('create_staff_profile'),
    ('create_stock_in'),
    ('create_product'),
    ('create_supplier'),
    ('create_customer'),
    ('process_fruit_loss'),
    ('create_sales_order'),
    ('change_sales_order_status'),
    ('get_orders_app')
)

SELECT
  '01_rls_status' AS check_name,
  c.relname AS object_name,
  'WARN_RLS_DISABLED' AS status,
  'Tracked business table does not have RLS enabled.' AS detail
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN tracked_tables t ON t.table_name = c.relname
WHERE n.nspname = 'public'
  AND c.relkind = 'r'
  AND c.relrowsecurity = false

UNION ALL

SELECT
  '02_public_tables_without_rls' AS check_name,
  c.relname AS object_name,
  'WARN_RLS_DISABLED' AS status,
  'Public table has RLS disabled. Review if this table is active business data.' AS detail
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relkind = 'r'
  AND c.relrowsecurity = false

UNION ALL

SELECT
  '03_broad_policies' AS check_name,
  tablename || '.' || policyname AS object_name,
  'REVIEW_BROAD_POLICY' AS status,
  'Policy grants anon/public or uses true checks. Inspect manually.' AS detail
FROM pg_policies
WHERE schemaname = 'public'
  AND (
    roles::text ILIKE '%anon%'
    OR roles::text ILIKE '%public%'
    OR COALESCE(qual, '') IN ('true', '(true)')
    OR COALESCE(with_check, '') IN ('true', '(true)')
  )

UNION ALL

SELECT
  '04_table_grants' AS check_name,
  table_name || ' -> ' || grantee || ' ' || privilege_type AS object_name,
  CASE
    WHEN grantee = 'anon' THEN 'WARN_ANON_TABLE_GRANT'
    WHEN privilege_type IN ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER') THEN 'REVIEW_WRITE_GRANT'
    ELSE 'REVIEW_TABLE_GRANT'
  END AS status,
  'Direct table grant found. It may be acceptable only when RLS is correct.' AS detail
FROM information_schema.table_privileges
WHERE table_schema = 'public'
  AND grantee IN ('anon', 'authenticated')
  AND table_name IN (SELECT table_name FROM tracked_tables)
  AND (
    grantee = 'anon'
    OR privilege_type IN ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER')
  )

UNION ALL

SELECT
  '05_rpc_anon_execute' AS check_name,
  p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS object_name,
  'WARN_ANON_CAN_EXECUTE' AS status,
  'Anonymous users can execute this RPC function. Usually YCPos functions should require authenticated users.' AS detail
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
JOIN tracked_functions tf ON tf.function_name = p.proname
JOIN pg_roles r ON r.rolname = 'anon' AND has_function_privilege(r.oid, p.oid, 'EXECUTE')
WHERE n.nspname = 'public'

UNION ALL

SELECT
  '06_security_definer_search_path' AS check_name,
  p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS object_name,
  'WARN_MISSING_FIXED_SEARCH_PATH' AS status,
  'SECURITY DEFINER function should set search_path explicitly.' AS detail
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
JOIN tracked_functions tf ON tf.function_name = p.proname
WHERE n.nspname = 'public'
  AND p.prosecdef
  AND COALESCE(array_to_string(p.proconfig, ', '), '') NOT ILIKE '%search_path%'

UNION ALL

SELECT
  '07_legacy_users_table' AS check_name,
  'public.users' AS object_name,
  'WARN_LEGACY_USERS_TABLE_EXISTS' AS status,
  'Formal YCPos should use Supabase Auth + staff_profiles, not the old plaintext users table.' AS detail
WHERE to_regclass('public.users') IS NOT NULL

UNION ALL

SELECT
  '08_invalid_staff_roles' AS check_name,
  COALESCE("DisplayName", id::text) AS object_name,
  'WARN_INVALID_ROLE' AS status,
  'staff_profiles contains a role outside admin/sales/purchase/warehouse: ' || COALESCE("Role", 'NULL') AS detail
FROM staff_profiles
WHERE "Role" NOT IN ('admin', 'sales', 'purchase', 'warehouse')

UNION ALL

SELECT
  '09_inactive_staff_accounts' AS check_name,
  COALESCE("DisplayName", id::text) AS object_name,
  'REVIEW_INACTIVE_STAFF' AS status,
  'Inactive staff profile exists. This can be normal if intentionally disabled.' AS detail
FROM staff_profiles
WHERE "Active" = false

UNION ALL

SELECT
  '10_auth_users_without_staff_profile' AS check_name,
  COALESCE(u.email, u.id::text) AS object_name,
  'REVIEW_NO_STAFF_PROFILE' AS status,
  'Auth user exists but cannot use YCPos until staff_profiles row is created.' AS detail
FROM auth.users u
LEFT JOIN staff_profiles sp ON sp.id = u.id
WHERE sp.id IS NULL

ORDER BY check_name, object_name;
