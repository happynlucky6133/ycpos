-- YCPos cleanup: remove legacy plaintext users table.
-- Run only after confirming all staff use Supabase Auth + staff_profiles.

DROP TABLE IF EXISTS public.users;
