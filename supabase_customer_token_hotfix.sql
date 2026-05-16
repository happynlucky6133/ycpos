CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

CREATE OR REPLACE FUNCTION validate_customer_token(p_token TEXT)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_customer_id TEXT;
  v_token_hash TEXT;
BEGIN
  IF p_token IS NULL OR trim(p_token) = '' THEN
    RAISE EXCEPTION '无效的访问链接';
  END IF;

  v_token_hash := encode(digest(trim(p_token), 'sha256'), 'hex');

  SELECT "CustomerID" INTO v_customer_id
  FROM customer_portal_tokens
  WHERE token_hash = v_token_hash
    AND is_active = true
    AND (expires_at IS NULL OR expires_at > now())
  LIMIT 1;

  IF v_customer_id IS NULL THEN
    RAISE EXCEPTION '无效或已过期的访问链接';
  END IF;

  UPDATE customer_portal_tokens
  SET last_used_at = now()
  WHERE token_hash = v_token_hash;

  RETURN v_customer_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION validate_customer_token(TEXT) FROM PUBLIC;

INSERT INTO customer_portal_tokens ("CustomerID", token_hash, label)
VALUES
  ('CTGC7X3', encode(digest('block-588', 'sha256'), 'hex'), 'Block 588'),
  ('CA453F1', encode(digest('block-688', 'sha256'), 'hex'), 'Block 688')
ON CONFLICT (token_hash)
DO UPDATE SET
  "CustomerID" = EXCLUDED."CustomerID",
  label = EXCLUDED.label,
  is_active = true,
  expires_at = NULL;

SELECT
  cpt."CustomerID",
  c."CustomerName",
  cpt.label,
  cpt.is_active,
  cpt.expires_at
FROM customer_portal_tokens cpt
JOIN customers c ON c."CustomerID" = cpt."CustomerID"
WHERE cpt.token_hash IN (
  encode(digest('block-588', 'sha256'), 'hex'),
  encode(digest('block-688', 'sha256'), 'hex')
);
