-- Allow sales order completion to create negative stock.
-- Completing an order now always deducts each line quantity from products.StockBalance.

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
BEGIN
  PERFORM require_role(ARRAY['admin', 'sales']);
  IF p_status NOT IN ('done', 'cancelled') THEN RAISE EXCEPTION 'Invalid status'; END IF;

  SELECT "Status" INTO v_current_status
  FROM purchase_orders
  WHERE "POID" = p_po_id
  FOR UPDATE;

  IF v_current_status IS NULL THEN RAISE EXCEPTION 'Order not found'; END IF;
  IF v_current_status <> 'pending' THEN RAISE EXCEPTION 'Order already processed'; END IF;

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
  PERFORM write_audit(CASE WHEN p_status = 'done' THEN '订单完成' ELSE '订单取消' END, p_po_id, '');
END;
$$;

GRANT EXECUTE ON FUNCTION change_sales_order_status(TEXT, TEXT) TO authenticated;
