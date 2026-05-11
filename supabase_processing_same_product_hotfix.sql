-- Allow processing a product into the same product.
-- Example: Pisang Tali B 90kg, loss 10kg => same B stock only decreases by 10kg.

CREATE OR REPLACE FUNCTION process_fruit_loss(
  p_source_product_id TEXT,
  p_target_product_id TEXT,
  p_input_qty NUMERIC,
  p_stem_loss NUMERIC DEFAULT 0,
  p_other_loss NUMERIC DEFAULT 0
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_process_id TEXT;
  v_output_qty NUMERIC;
  v_balance NUMERIC;
BEGIN
  PERFORM require_role(ARRAY['admin', 'purchase']);

  v_output_qty := p_input_qty - COALESCE(p_stem_loss, 0) - COALESCE(p_other_loss, 0);
  IF p_input_qty <= 0 OR v_output_qty <= 0 THEN RAISE EXCEPTION 'Invalid processing quantity'; END IF;

  SELECT COALESCE("StockBalance", 0) INTO v_balance
  FROM products
  WHERE "ProductID" = p_source_product_id
  FOR UPDATE;

  IF v_balance < p_input_qty THEN RAISE EXCEPTION 'Insufficient source stock'; END IF;

  v_process_id := 'PR-' || to_char(now(), 'YYMMDD') || '-' || substr(md5(random()::text), 1, 4);

  IF p_source_product_id = p_target_product_id THEN
    UPDATE products SET "StockBalance" = COALESCE("StockBalance", 0) - COALESCE(p_stem_loss, 0) - COALESCE(p_other_loss, 0)
    WHERE "ProductID" = p_source_product_id;
  ELSE
    UPDATE products SET "StockBalance" = COALESCE("StockBalance", 0) - p_input_qty
    WHERE "ProductID" = p_source_product_id;

    UPDATE products SET "StockBalance" = COALESCE("StockBalance", 0) + v_output_qty
    WHERE "ProductID" = p_target_product_id;
  END IF;

  INSERT INTO processing_logs (
    "ProcessID", "Date", "Time", "SourceProductID", "TargetProductID",
    "InputQty", "StemLoss", "OtherLoss", "OutputQty", "CreatedBy"
  )
  VALUES (
    v_process_id, current_date::text, to_char(now(), 'HH24:MI:SS'),
    p_source_product_id, p_target_product_id,
    p_input_qty, COALESCE(p_stem_loss, 0), COALESCE(p_other_loss, 0), v_output_qty,
    COALESCE(app_display_name(), '')
  );

  PERFORM write_audit('新增加工损耗', v_process_id, p_source_product_id || ' -' || p_input_qty || ' / ' || p_target_product_id || ' +' || v_output_qty);
  RETURN v_process_id;
END;
$$;

GRANT EXECUTE ON FUNCTION process_fruit_loss(TEXT, TEXT, NUMERIC, NUMERIC, NUMERIC) TO authenticated;
