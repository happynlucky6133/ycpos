-- Allow YCPos admins to create and maintain staff profile rows from the app.
-- Run this once in Supabase SQL Editor after supabase_formal_v2.sql / upgrade v3.

ALTER TABLE staff_profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "admin can insert staff profiles" ON staff_profiles;
CREATE POLICY "admin can insert staff profiles"
ON staff_profiles FOR INSERT
TO authenticated
WITH CHECK (app_role() = 'admin');

DROP POLICY IF EXISTS "admin can update staff profiles" ON staff_profiles;
CREATE POLICY "admin can update staff profiles"
ON staff_profiles FOR UPDATE
TO authenticated
USING (app_role() = 'admin')
WITH CHECK (app_role() = 'admin');

CREATE OR REPLACE FUNCTION create_staff_profile(
  p_email TEXT,
  p_display_name TEXT,
  p_role TEXT,
  p_active BOOLEAN DEFAULT true
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_user_id UUID;
BEGIN
  PERFORM require_role(ARRAY['admin']);
  IF p_role NOT IN ('admin', 'sales', 'purchase', 'warehouse') THEN
    RAISE EXCEPTION 'Invalid role';
  END IF;

  SELECT id INTO v_user_id
  FROM auth.users
  WHERE lower(email) = lower(trim(p_email))
  LIMIT 1;

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Auth user not found';
  END IF;

  INSERT INTO staff_profiles (id, "DisplayName", "Role", "Active")
  VALUES (v_user_id, COALESCE(NULLIF(trim(p_display_name), ''), trim(p_email)), p_role, COALESCE(p_active, true))
  ON CONFLICT (id) DO UPDATE
  SET "DisplayName" = EXCLUDED."DisplayName",
      "Role" = EXCLUDED."Role",
      "Active" = EXCLUDED."Active";

  RETURN v_user_id;
END;
$$;

GRANT EXECUTE ON FUNCTION create_staff_profile(TEXT, TEXT, TEXT, BOOLEAN) TO authenticated;
