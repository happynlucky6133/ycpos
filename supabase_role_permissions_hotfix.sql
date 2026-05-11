-- Align app role permissions with YCPos daily workflows.
-- sales: products, customers, orders
-- purchase: products, suppliers, stock-in, processing

CREATE OR REPLACE FUNCTION create_product(
  p_product_name TEXT,
  p_grade TEXT DEFAULT '',
  p_unit TEXT DEFAULT 'kg',
  p_note TEXT DEFAULT ''
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_product_id TEXT;
BEGIN
  PERFORM require_role(ARRAY['admin', 'sales', 'purchase']);
  IF NULLIF(trim(p_product_name), '') IS NULL THEN RAISE EXCEPTION 'Product name is required'; END IF;

  v_product_id := 'p' || substr(md5(now()::text || random()::text), 1, 6);

  INSERT INTO products ("ProductID", "ProductName", "Grade", "Unit", "StockBalance", "Note")
  VALUES (v_product_id, trim(p_product_name), COALESCE(p_grade, ''), COALESCE(p_unit, 'kg'), 0, COALESCE(p_note, ''));

  INSERT INTO autocount_sync_queue ("EntityType", "EntityID", "Action", "Payload")
  VALUES ('product', v_product_id, 'upsert', jsonb_build_object('name', p_product_name, 'grade', p_grade, 'unit', p_unit, 'note', p_note));

  PERFORM write_audit('新增产品', v_product_id, p_product_name);
  RETURN v_product_id;
END;
$$;

CREATE OR REPLACE FUNCTION create_supplier(
  p_supplier_name TEXT,
  p_phone TEXT DEFAULT '',
  p_note TEXT DEFAULT ''
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_supplier_id TEXT;
BEGIN
  PERFORM require_role(ARRAY['admin', 'purchase']);
  IF NULLIF(trim(p_supplier_name), '') IS NULL THEN RAISE EXCEPTION 'Supplier name is required'; END IF;

  v_supplier_id := 'S' || upper(substr(md5(now()::text || random()::text), 1, 6));

  INSERT INTO suppliers ("SupplierID", "SupplierName", "Phone", "Note")
  VALUES (v_supplier_id, trim(p_supplier_name), COALESCE(p_phone, ''), COALESCE(p_note, ''));

  INSERT INTO autocount_sync_queue ("EntityType", "EntityID", "Action", "Payload")
  VALUES ('supplier', v_supplier_id, 'upsert', jsonb_build_object('name', p_supplier_name, 'phone', p_phone, 'note', p_note));

  PERFORM write_audit('新增供应商', v_supplier_id, p_supplier_name);
  RETURN v_supplier_id;
END;
$$;

CREATE OR REPLACE FUNCTION create_customer(
  p_customer_name TEXT,
  p_phone TEXT DEFAULT '',
  p_note TEXT DEFAULT ''
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_customer_id TEXT;
BEGIN
  PERFORM require_role(ARRAY['admin', 'sales']);
  IF NULLIF(trim(p_customer_name), '') IS NULL THEN RAISE EXCEPTION 'Customer name is required'; END IF;

  v_customer_id := 'C' || upper(substr(md5(now()::text || random()::text), 1, 6));

  INSERT INTO customers ("CustomerID", "CustomerName", "Phone", "Note")
  VALUES (v_customer_id, trim(p_customer_name), COALESCE(p_phone, ''), COALESCE(p_note, ''));

  INSERT INTO autocount_sync_queue ("EntityType", "EntityID", "Action", "Payload")
  VALUES ('customer', v_customer_id, 'upsert', jsonb_build_object('name', p_customer_name, 'phone', p_phone, 'note', p_note));

  PERFORM write_audit('新增客户', v_customer_id, p_customer_name);
  RETURN v_customer_id;
END;
$$;

GRANT EXECUTE ON FUNCTION create_product(TEXT, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION create_supplier(TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION create_customer(TEXT, TEXT, TEXT) TO authenticated;
