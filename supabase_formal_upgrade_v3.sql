-- YCPos formal upgrade v3
-- Notes, multi-line priced orders, picking workflow, date reports, and negative stock sales completion.

ALTER TABLE products ADD COLUMN IF NOT EXISTS "Note" TEXT DEFAULT '';
ALTER TABLE stock_ins ADD COLUMN IF NOT EXISTS "Note" TEXT DEFAULT '';
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS "Note" TEXT DEFAULT '';
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS "TotalAmount" NUMERIC DEFAULT 0;
ALTER TABLE po_details ADD COLUMN IF NOT EXISTS "UnitPrice" NUMERIC DEFAULT 0;
ALTER TABLE po_details ADD COLUMN IF NOT EXISTS "LineTotal" NUMERIC DEFAULT 0;

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

DO $$
DECLARE
  v_constraint TEXT;
BEGIN
  SELECT conname INTO v_constraint
  FROM pg_constraint
  WHERE conrelid = 'staff_profiles'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) LIKE '%Role%'
  LIMIT 1;

  IF v_constraint IS NOT NULL THEN
    EXECUTE format('ALTER TABLE staff_profiles DROP CONSTRAINT %I', v_constraint);
  END IF;

  ALTER TABLE staff_profiles
  ADD CONSTRAINT staff_profiles_role_check
  CHECK ("Role" IN ('admin', 'sales', 'purchase', 'warehouse'));
END;
$$;

DROP FUNCTION IF EXISTS create_stock_in(TEXT, TEXT, NUMERIC);
DROP FUNCTION IF EXISTS create_product(TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS create_sales_order(TEXT, TEXT, NUMERIC);
DROP FUNCTION IF EXISTS create_sales_order(TEXT, JSONB);

CREATE OR REPLACE FUNCTION create_stock_in(
  p_supplier_id TEXT,
  p_product_id TEXT,
  p_qty NUMERIC,
  p_note TEXT DEFAULT ''
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_stock_in_id TEXT;
  v_detail_id TEXT;
  v_rows INTEGER;
BEGIN
  PERFORM require_role(ARRAY['admin', 'purchase']);
  IF p_qty <= 0 THEN RAISE EXCEPTION 'Invalid quantity'; END IF;
  IF NOT EXISTS (SELECT 1 FROM suppliers WHERE "SupplierID" = p_supplier_id) THEN RAISE EXCEPTION 'Supplier not found'; END IF;
  IF NOT EXISTS (SELECT 1 FROM products WHERE "ProductID" = p_product_id) THEN RAISE EXCEPTION 'Product not found'; END IF;

  v_stock_in_id := 'S01-' || to_char(now(), 'YYMMDD') || '-' || substr(md5(random()::text), 1, 4);
  v_detail_id := substr(md5(random()::text), 1, 10);

  INSERT INTO stock_ins ("StockInID", "Date", "Time", "SupplierID", "CreatedBy", "CreatedAt", "Note")
  VALUES (v_stock_in_id, current_date::text, to_char(now(), 'HH24:MI:SS'), p_supplier_id, COALESCE(app_display_name(), ''), now()::text, COALESCE(p_note, ''));

  INSERT INTO stock_in_details ("DetailID", "StockInID", "ProductID", "Qty")
  VALUES (v_detail_id, v_stock_in_id, p_product_id, p_qty);

  UPDATE products
  SET "StockBalance" = COALESCE("StockBalance", 0) + p_qty
  WHERE "ProductID" = p_product_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN RAISE EXCEPTION 'Product stock update failed'; END IF;

  INSERT INTO autocount_sync_queue ("EntityType", "EntityID", "Action", "Payload")
  VALUES ('stock_in', v_stock_in_id, 'upsert', jsonb_build_object('supplier_id', p_supplier_id, 'product_id', p_product_id, 'qty', p_qty, 'note', COALESCE(p_note, '')));

  PERFORM write_audit('新增进货', v_stock_in_id, '产品 ' || p_product_id || ' +' || p_qty || CASE WHEN COALESCE(p_note, '') <> '' THEN ' · ' || p_note ELSE '' END);
  RETURN v_stock_in_id;
END;
$$;

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
  PERFORM require_role(ARRAY['admin']);
  IF NULLIF(trim(p_product_name), '') IS NULL THEN RAISE EXCEPTION 'Product name is required'; END IF;

  v_product_id := 'p' || substr(md5(now()::text || random()::text), 1, 6);

  INSERT INTO products ("ProductID", "ProductName", "Grade", "Unit", "StockBalance", "Note")
  VALUES (v_product_id, trim(p_product_name), COALESCE(p_grade, ''), COALESCE(p_unit, 'kg'), 0, COALESCE(p_note, ''));

  INSERT INTO autocount_sync_queue ("EntityType", "EntityID", "Action", "Payload")
  VALUES ('product', v_product_id, 'upsert', jsonb_build_object('name', p_product_name, 'grade', p_grade, 'unit', p_unit, 'note', COALESCE(p_note, '')));

  PERFORM write_audit('新增产品', v_product_id, p_product_name);
  RETURN v_product_id;
END;
$$;

CREATE OR REPLACE FUNCTION create_sales_order(
  p_customer_id TEXT,
  p_items JSONB,
  p_note TEXT DEFAULT ''
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_po_id TEXT;
  v_detail_id TEXT;
  v_item JSONB;
  v_product_id TEXT;
  v_qty NUMERIC;
  v_unit_price NUMERIC;
  v_line_total NUMERIC;
  v_total NUMERIC := 0;
BEGIN
  PERFORM require_role(ARRAY['admin', 'sales']);
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'Order requires at least one item';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM customers WHERE "CustomerID" = p_customer_id) THEN RAISE EXCEPTION 'Customer not found'; END IF;

  v_po_id := 'PO-' || to_char(now(), 'YYMMDD') || '-' || substr(md5(random()::text), 1, 4);

  INSERT INTO purchase_orders ("POID", "Date", "Time", "CustomerID", "Status", "TotalAmount", "Note")
  VALUES (v_po_id, current_date::text, to_char(now(), 'HH24:MI:SS'), p_customer_id, 'pending', 0, COALESCE(p_note, ''));

  FOR v_item IN SELECT value FROM jsonb_array_elements(p_items)
  LOOP
    v_product_id := v_item->>'product_id';
    v_qty := COALESCE((v_item->>'qty')::NUMERIC, 0);
    v_unit_price := COALESCE((v_item->>'unit_price')::NUMERIC, 0);
    v_line_total := v_qty * v_unit_price;

    IF v_product_id IS NULL OR v_product_id = '' THEN RAISE EXCEPTION 'Product is required'; END IF;
    IF v_qty <= 0 THEN RAISE EXCEPTION 'Invalid quantity'; END IF;
    IF v_unit_price < 0 THEN RAISE EXCEPTION 'Invalid unit price'; END IF;
    IF NOT EXISTS (SELECT 1 FROM products WHERE "ProductID" = v_product_id) THEN RAISE EXCEPTION 'Product not found'; END IF;

    v_detail_id := substr(md5(random()::text || clock_timestamp()::text), 1, 10);
    INSERT INTO po_details ("DetailID", "POID", "ProductID", "QTY", "UnitPrice", "LineTotal")
    VALUES (v_detail_id, v_po_id, v_product_id, v_qty, v_unit_price, v_line_total);

    v_total := v_total + v_line_total;
  END LOOP;

  UPDATE purchase_orders SET "TotalAmount" = v_total WHERE "POID" = v_po_id;

  PERFORM write_audit('创建订单', v_po_id, '客户 ' || p_customer_id || ' 共 ' || jsonb_array_length(p_items) || ' 项，总额 ' || v_total || CASE WHEN COALESCE(p_note, '') <> '' THEN ' · ' || p_note ELSE '' END);
  RETURN v_po_id;
END;
$$;

CREATE OR REPLACE FUNCTION change_sales_order_status(
  p_po_id TEXT,
  p_status TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_current_status TEXT;
  v_line RECORD;
  v_role TEXT;
BEGIN
  v_role := app_role();
  IF p_status NOT IN ('ready', 'loaded', 'done', 'cancelled') THEN RAISE EXCEPTION 'Invalid status'; END IF;
  IF auth.uid() IS NULL OR v_role IS NULL THEN RAISE EXCEPTION 'Permission denied'; END IF;
  IF p_status IN ('ready', 'loaded') AND v_role <> ALL(ARRAY['admin', 'purchase', 'warehouse']) THEN RAISE EXCEPTION 'Permission denied'; END IF;
  IF p_status IN ('done', 'cancelled') AND v_role <> ALL(ARRAY['admin', 'sales']) THEN RAISE EXCEPTION 'Permission denied'; END IF;

  SELECT "Status" INTO v_current_status
  FROM purchase_orders
  WHERE "POID" = p_po_id
  FOR UPDATE;

  IF v_current_status IS NULL THEN RAISE EXCEPTION 'Order not found'; END IF;
  IF v_current_status IN ('done', 'cancelled') THEN RAISE EXCEPTION 'Order already processed'; END IF;
  IF p_status = 'ready' AND v_current_status <> 'pending' THEN RAISE EXCEPTION 'Invalid status flow'; END IF;
  IF p_status = 'loaded' AND v_current_status <> 'ready' THEN RAISE EXCEPTION 'Invalid status flow'; END IF;
  IF p_status = 'done' AND v_current_status <> 'loaded' THEN RAISE EXCEPTION 'Invalid status flow'; END IF;

  IF p_status = 'done' THEN
    FOR v_line IN SELECT "ProductID", "QTY" FROM po_details WHERE "POID" = p_po_id
    LOOP
      UPDATE products
      SET "StockBalance" = COALESCE("StockBalance", 0) - v_line."QTY"
      WHERE "ProductID" = v_line."ProductID";
    END LOOP;

    INSERT INTO autocount_sync_queue ("EntityType", "EntityID", "Action", "Payload")
    VALUES ('sales_order', p_po_id, 'upsert', (
      SELECT jsonb_build_object(
        'po_id', p_po_id,
        'lines', jsonb_agg(jsonb_build_object(
          'product_id', d."ProductID",
          'qty', d."QTY",
          'unit_price', COALESCE(d."UnitPrice", 0),
          'line_total', COALESCE(d."LineTotal", d."QTY" * COALESCE(d."UnitPrice", 0))
        ))
      )
      FROM po_details d
      WHERE d."POID" = p_po_id
    ));
  END IF;

  UPDATE purchase_orders SET "Status" = p_status WHERE "POID" = p_po_id;
  PERFORM write_audit(CASE
    WHEN p_status = 'ready' THEN '订单已备货'
    WHEN p_status = 'loaded' THEN '订单已上车'
    WHEN p_status = 'done' THEN '订单完成'
    ELSE '订单取消'
  END, p_po_id, '');
END;
$$;

CREATE OR REPLACE FUNCTION get_orders_app()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role TEXT;
  v_can_see_price BOOLEAN;
  v_orders JSONB;
  v_details JSONB;
BEGIN
  v_role := app_role();
  IF auth.uid() IS NULL OR v_role <> ALL(ARRAY['admin', 'sales', 'purchase', 'warehouse']) THEN
    RAISE EXCEPTION 'Permission denied';
  END IF;
  v_can_see_price := v_role IN ('admin', 'sales');

  SELECT COALESCE(jsonb_agg(
    CASE WHEN v_can_see_price THEN to_jsonb(o) || jsonb_build_object('CustomerName', COALESCE(c."CustomerName", o."CustomerID"))
    ELSE (to_jsonb(o) || jsonb_build_object('CustomerName', COALESCE(c."CustomerName", o."CustomerID"))) - 'TotalAmount' END
    ORDER BY o.id
  ), '[]'::jsonb)
  INTO v_orders
  FROM purchase_orders o
  LEFT JOIN customers c ON c."CustomerID" = o."CustomerID";

  SELECT COALESCE(jsonb_agg(
    CASE WHEN v_can_see_price THEN to_jsonb(d)
    ELSE jsonb_build_object(
      'id', d.id,
      'DetailID', d."DetailID",
      'POID', d."POID",
      'ProductID', d."ProductID",
      'QTY', d."QTY"
    ) END
    ORDER BY d.id
  ), '[]'::jsonb)
  INTO v_details
  FROM po_details d;

  RETURN jsonb_build_object('orders', v_orders, 'details', v_details);
END;
$$;

GRANT EXECUTE ON FUNCTION create_stock_in(TEXT, TEXT, NUMERIC, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION create_product(TEXT, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION create_sales_order(TEXT, JSONB, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION change_sales_order_status(TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION get_orders_app() TO authenticated;
REVOKE EXECUTE ON FUNCTION write_audit(TEXT, TEXT, TEXT) FROM authenticated;
