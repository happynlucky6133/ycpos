-- ============================================
-- FreshStack Order 客户订货系统 v1
-- RLS-first 数据库骨架
-- 在 Supabase SQL Editor 中执行
-- 依赖: pgcrypto 扩展（用于 token hash）
-- ============================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ============================================
-- 1. customer_portal_tokens — 客户专属链接 token
-- ============================================
CREATE TABLE IF NOT EXISTS customer_portal_tokens (
  id SERIAL PRIMARY KEY,
  "CustomerID" TEXT NOT NULL REFERENCES customers("CustomerID"),
  token_hash TEXT NOT NULL,
  label TEXT DEFAULT '',
  is_active BOOLEAN NOT NULL DEFAULT true,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by TEXT DEFAULT '',
  last_used_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_portal_token_hash ON customer_portal_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_portal_token_customer ON customer_portal_tokens("CustomerID");

-- ============================================
-- 2. customer_order_requests — 客户订货申请主表
-- ============================================
CREATE TABLE IF NOT EXISTS customer_order_requests (
  id SERIAL PRIMARY KEY,
  "RequestID" TEXT UNIQUE NOT NULL,
  "CustomerID" TEXT NOT NULL REFERENCES customers("CustomerID"),
  "Status" TEXT NOT NULL DEFAULT 'submitted'
    CHECK ("Status" IN (
      'submitted',
      'sales_review',
      'warehouse_check',
      'waiting_customer',
      'confirmed',
      'converted',
      'rejected',
      'cancelled'
    )),
  "CustomerNote" TEXT DEFAULT '',
  "SalesNote" TEXT DEFAULT '',
  "WarehouseNote" TEXT DEFAULT '',
  "RejectReason" TEXT DEFAULT '',
  "ConvertedPOID" TEXT,
  "CreatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "UpdatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "SubmittedAt" TIMESTAMPTZ,
  "ReviewedBy" TEXT DEFAULT '',
  "ReviewedAt" TIMESTAMPTZ,
  "WarehouseCheckedBy" TEXT DEFAULT '',
  "WarehouseCheckedAt" TIMESTAMPTZ,
  "ConvertedBy" TEXT DEFAULT '',
  "ConvertedAt" TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_cor_customer ON customer_order_requests("CustomerID");
CREATE INDEX IF NOT EXISTS idx_cor_status ON customer_order_requests("Status");

-- ============================================
-- 3. customer_order_request_items — 客户订货申请明细
-- ============================================
CREATE TABLE IF NOT EXISTS customer_order_request_items (
  id SERIAL PRIMARY KEY,
  "RequestID" TEXT NOT NULL REFERENCES customer_order_requests("RequestID"),
  "ProductID" TEXT NOT NULL REFERENCES products("ProductID"),
  "Qty" NUMERIC NOT NULL DEFAULT 0,
  "CustomerNote" TEXT DEFAULT '',
  "SalesQty" NUMERIC,
  "UnitPrice" NUMERIC DEFAULT 0,
  "LineTotal" NUMERIC DEFAULT 0,
  "WarehouseStatus" TEXT DEFAULT ''
    CHECK ("WarehouseStatus" IN ('', '有货', '部分有货', '无货')),
  "WarehouseNote" TEXT DEFAULT '',
  "CreatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "UpdatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cori_request ON customer_order_request_items("RequestID");

-- ============================================
-- 4. customer_order_contact_logs — Sales 联系客户记录
-- ============================================
CREATE TABLE IF NOT EXISTS customer_order_contact_logs (
  id SERIAL PRIMARY KEY,
  "RequestID" TEXT NOT NULL REFERENCES customer_order_requests("RequestID"),
  "ContactMethod" TEXT NOT NULL DEFAULT 'WhatsApp'
    CHECK ("ContactMethod" IN ('WhatsApp', '电话', '其他')),
  "ContactNote" TEXT DEFAULT '',
  "ContactedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "ContactedBy" TEXT DEFAULT '',
  "CreatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cocl_request ON customer_order_contact_logs("RequestID");

-- ============================================
-- RLS 开启 —— 所有新表默认拒绝
-- ============================================
ALTER TABLE customer_portal_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_order_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_order_request_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_order_contact_logs ENABLE ROW LEVEL SECURITY;

-- 不给 anon 任何直接读写权限（无 policy = 拒绝）
-- 不给 authenticated 直接读写权限（全部走 SECURITY DEFINER RPC）

-- ============================================
-- 内部工具函数
-- ============================================

-- Token 验证：返回对应 CustomerID，token 无效/过期/停用时抛异常
CREATE OR REPLACE FUNCTION validate_customer_token(p_token TEXT)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_customer_id TEXT;
  v_token_hash TEXT;
BEGIN
  IF p_token IS NULL OR trim(p_token) = '' THEN
    RAISE EXCEPTION '无效的访问链接';
  END IF;

  v_token_hash := encode(digest(p_token, 'sha256'), 'hex');

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

-- ============================================
-- 客户 RPC（anon 通过 SECURITY DEFINER 调用）
-- ============================================

/*
  获取客户门户上下文
  返回：客户名称 + 可下单产品（名称、单位）
  不返回：价格、库存、供应商
*/
CREATE OR REPLACE FUNCTION get_customer_portal_context(p_token TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_customer_id TEXT;
  v_customer JSONB;
  v_products JSONB;
BEGIN
  v_customer_id := validate_customer_token(p_token);

  SELECT jsonb_build_object(
    'CustomerID',   c."CustomerID",
    'CustomerName', c."CustomerName"
  )
  INTO v_customer
  FROM customers c
  WHERE c."CustomerID" = v_customer_id;

  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'ProductID',   p."ProductID",
      'ProductName', p."ProductName",
      'Unit',        p."Unit"
    )
    ORDER BY p."ProductName"
  ), '[]'::jsonb)
  INTO v_products
  FROM products p;

  RETURN jsonb_build_object(
    'customer', v_customer,
    'products', v_products
  );
END;
$$;

/*
  客户提交订货申请
  写入 customer_order_requests + customer_order_request_items
  不生成 purchase_orders，不扣库存
*/
CREATE OR REPLACE FUNCTION submit_customer_order_request(
  p_token TEXT,
  p_items JSONB,
  p_note TEXT DEFAULT ''
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_customer_id TEXT;
  v_request_id TEXT;
  v_item JSONB;
  v_product_id TEXT;
  v_qty NUMERIC;
  v_item_note TEXT;
BEGIN
  v_customer_id := validate_customer_token(p_token);

  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION '请至少选择一项产品';
  END IF;

  v_request_id := 'CR-' || to_char(now(), 'YYMMDD') || '-' || substr(md5(random()::text), 1, 8);

  INSERT INTO customer_order_requests (
    "RequestID", "CustomerID", "Status", "CustomerNote",
    "CreatedAt", "UpdatedAt", "SubmittedAt"
  )
  VALUES (
    v_request_id, v_customer_id, 'submitted', COALESCE(p_note, ''),
    now(), now(), now()
  );

  FOR v_item IN SELECT value FROM jsonb_array_elements(p_items)
  LOOP
    v_product_id := v_item->>'product_id';
    v_qty        := COALESCE((v_item->>'qty')::NUMERIC, 0);
    v_item_note  := COALESCE(v_item->>'note', '');

    IF v_product_id IS NULL OR trim(v_product_id) = '' THEN
      RAISE EXCEPTION '产品不能为空';
    END IF;
    IF v_qty <= 0 THEN
      RAISE EXCEPTION '数量必须大于 0';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM products WHERE "ProductID" = v_product_id) THEN
      RAISE EXCEPTION '产品 "%" 不存在', v_product_id;
    END IF;

    INSERT INTO customer_order_request_items (
      "RequestID", "ProductID", "Qty", "CustomerNote",
      "CreatedAt", "UpdatedAt"
    )
    VALUES (
      v_request_id, v_product_id, v_qty, v_item_note,
      now(), now()
    );
  END LOOP;

  RETURN v_request_id;
END;
$$;

/*
  客户查看自己的订货申请记录
  不返回价格、Sales 内部备注、仓库内部备注
*/
CREATE OR REPLACE FUNCTION get_customer_order_requests(p_token TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_customer_id TEXT;
  v_requests JSONB;
  v_items JSONB;
BEGIN
  v_customer_id := validate_customer_token(p_token);

  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'RequestID',    r."RequestID",
      'Status',       r."Status",
      'CustomerNote', r."CustomerNote",
      'RejectReason', CASE WHEN r."Status" = 'rejected' THEN r."RejectReason" ELSE NULL END,
      'SubmittedAt',  r."SubmittedAt",
      'UpdatedAt',    r."UpdatedAt"
    )
    ORDER BY r.id DESC
  ), '[]'::jsonb)
  INTO v_requests
  FROM customer_order_requests r
  WHERE r."CustomerID" = v_customer_id;

  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'RequestID',    i."RequestID",
      'ProductID',    i."ProductID",
      'ProductName',  p."ProductName",
      'Unit',         p."Unit",
      'Qty',          i."Qty",
      'CustomerNote', i."CustomerNote"
    )
    ORDER BY i.id
  ), '[]'::jsonb)
  INTO v_items
  FROM customer_order_request_items i
  JOIN products p ON p."ProductID" = i."ProductID"
  WHERE i."RequestID" IN (
    SELECT "RequestID"
    FROM customer_order_requests
    WHERE "CustomerID" = v_customer_id
  );

  RETURN jsonb_build_object(
    'requests', v_requests,
    'items',    v_items
  );
END;
$$;

-- ============================================
-- 员工 RPC（authenticated，按 app_role() 控制字段可见性）
-- ============================================

/*
  员工查看所有客户申请
  admin/sales      → 可见价格（UnitPrice, LineTotal）和 Sales 内部备注
  warehouse/purchase → 不可见价格，不可见 Sales 内部备注
*/
CREATE OR REPLACE FUNCTION get_customer_requests_app()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role TEXT;
  v_can_see_price BOOLEAN;
  v_requests JSONB;
  v_items JSONB;
BEGIN
  v_role := app_role();
  IF auth.uid() IS NULL OR v_role IS NULL THEN
    RAISE EXCEPTION 'Permission denied';
  END IF;
  v_can_see_price := v_role IN ('admin', 'sales');

  -- 主表：按角色返回不同字段集合
  SELECT COALESCE(jsonb_agg(
    CASE WHEN v_can_see_price THEN
      jsonb_build_object(
        'id',                  r.id,
        'RequestID',           r."RequestID",
        'CustomerID',          r."CustomerID",
        'CustomerName',        c."CustomerName",
        'Status',              r."Status",
        'CustomerNote',        r."CustomerNote",
        'SalesNote',           r."SalesNote",
        'WarehouseNote',       r."WarehouseNote",
        'RejectReason',        r."RejectReason",
        'ConvertedPOID',       r."ConvertedPOID",
        'CreatedAt',           r."CreatedAt",
        'UpdatedAt',           r."UpdatedAt",
        'SubmittedAt',         r."SubmittedAt",
        'ReviewedBy',          r."ReviewedBy",
        'ReviewedAt',          r."ReviewedAt",
        'WarehouseCheckedBy',  r."WarehouseCheckedBy",
        'WarehouseCheckedAt',  r."WarehouseCheckedAt",
        'ConvertedBy',         r."ConvertedBy",
        'ConvertedAt',         r."ConvertedAt"
      )
    ELSE
      jsonb_build_object(
        'id',                  r.id,
        'RequestID',           r."RequestID",
        'CustomerID',          r."CustomerID",
        'CustomerName',        c."CustomerName",
        'Status',              r."Status",
        'CustomerNote',        r."CustomerNote",
        'WarehouseNote',       r."WarehouseNote",
        'CreatedAt',           r."CreatedAt",
        'UpdatedAt',           r."UpdatedAt",
        'SubmittedAt',         r."SubmittedAt",
        'WarehouseCheckedBy',  r."WarehouseCheckedBy",
        'WarehouseCheckedAt',  r."WarehouseCheckedAt"
      )
    END
    ORDER BY r.id DESC
  ), '[]'::jsonb)
  INTO v_requests
  FROM customer_order_requests r
  LEFT JOIN customers c ON c."CustomerID" = r."CustomerID";

  -- 明细：admin/sales 可见全部字段；warehouse/purchase 不包含 UnitPrice、LineTotal
  SELECT COALESCE(jsonb_agg(
    CASE WHEN v_can_see_price THEN
      jsonb_build_object(
        'id',              i.id,
        'RequestID',       i."RequestID",
        'ProductID',       i."ProductID",
        'ProductName',     p."ProductName",
        'Unit',            p."Unit",
        'Qty',             i."Qty",
        'CustomerNote',    i."CustomerNote",
        'SalesQty',        i."SalesQty",
        'UnitPrice',       i."UnitPrice",
        'LineTotal',       i."LineTotal",
        'WarehouseStatus', i."WarehouseStatus",
        'WarehouseNote',   i."WarehouseNote"
      )
    ELSE
      jsonb_build_object(
        'id',              i.id,
        'RequestID',       i."RequestID",
        'ProductID',       i."ProductID",
        'ProductName',     p."ProductName",
        'Unit',            p."Unit",
        'Qty',             i."Qty",
        'EffectiveQty',    COALESCE(i."SalesQty", i."Qty"),
        'CustomerNote',    i."CustomerNote",
        'WarehouseStatus', i."WarehouseStatus",
        'WarehouseNote',   i."WarehouseNote"
      )
    END
    ORDER BY i.id
  ), '[]'::jsonb)
  INTO v_items
  FROM customer_order_request_items i
  JOIN products p ON p."ProductID" = i."ProductID";

  RETURN jsonb_build_object(
    'requests', v_requests,
    'items',    v_items
  );
END;
$$;

/*
  Sales/Admin 更新客户申请
  - 修改 SalesQty（覆盖客户原始 Qty），必须 > 0
  - 填写 UnitPrice（必须 >= 0）/ 自动计算 LineTotal
  - 填写 SalesNote
  - 推进状态（白名单 + 严格流转校验）
  - 不允许设置 rejected / converted / cancelled
*/
CREATE OR REPLACE FUNCTION sales_update_customer_request(
  p_request_id  TEXT,
  p_items       JSONB  DEFAULT NULL,
  p_sales_note  TEXT   DEFAULT NULL,
  p_new_status  TEXT   DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role           TEXT;
  v_current_status TEXT;
  v_item           JSONB;
  v_item_id        INTEGER;
  v_sales_qty      NUMERIC;
  v_unit_price     NUMERIC;
BEGIN
  v_role := app_role();
  IF auth.uid() IS NULL OR v_role IS NULL OR v_role <> ALL(ARRAY['admin', 'sales']) THEN
    RAISE EXCEPTION 'Permission denied';
  END IF;

  SELECT "Status" INTO v_current_status
  FROM customer_order_requests
  WHERE "RequestID" = p_request_id
  FOR UPDATE;

  IF v_current_status IS NULL THEN
    RAISE EXCEPTION '申请不存在';
  END IF;

  -- 终态 / confirmed 申请不可修改（confirmed 只能走 convert_customer_request_to_order）
  IF v_current_status IN ('converted', 'rejected', 'cancelled', 'confirmed') THEN
    RAISE EXCEPTION '申请已处理（%），无法修改', v_current_status;
  END IF;

  -- p_new_status 白名单 + 流转校验
  IF p_new_status IS NOT NULL AND p_new_status <> v_current_status THEN
    -- 禁止通过此函数设置 rejected / converted / cancelled
    IF p_new_status = ANY(ARRAY['rejected', 'converted', 'cancelled']) THEN
      RAISE EXCEPTION '不允许通过此操作将状态设为 %', p_new_status;
    END IF;

    -- 白名单：只允许这四个中间状态
    IF p_new_status NOT IN ('sales_review', 'warehouse_check', 'waiting_customer', 'confirmed') THEN
      RAISE EXCEPTION '无效的目标状态: %', p_new_status;
    END IF;

    -- 严格状态流转
    CASE v_current_status
      WHEN 'submitted' THEN
        IF p_new_status <> 'sales_review' THEN
          RAISE EXCEPTION '无效的状态流转: % → %', v_current_status, p_new_status;
        END IF;
      WHEN 'sales_review' THEN
        IF p_new_status <> 'warehouse_check' THEN
          RAISE EXCEPTION '无效的状态流转: % → %', v_current_status, p_new_status;
        END IF;
      WHEN 'warehouse_check' THEN
        IF p_new_status NOT IN ('waiting_customer', 'confirmed') THEN
          RAISE EXCEPTION '无效的状态流转: % → %', v_current_status, p_new_status;
        END IF;
      WHEN 'waiting_customer' THEN
        IF p_new_status <> 'confirmed' THEN
          RAISE EXCEPTION '无效的状态流转: % → %', v_current_status, p_new_status;
        END IF;
      WHEN 'confirmed' THEN
        RAISE EXCEPTION '已确认的申请不可再修改状态，请使用转正式订单功能';
      ELSE
        RAISE EXCEPTION '当前状态 % 不允许修改', v_current_status;
    END CASE;
  END IF;

  -- 更新明细：SalesQty、UnitPrice、LineTotal
  IF p_items IS NOT NULL AND jsonb_typeof(p_items) = 'array' THEN
    FOR v_item IN SELECT value FROM jsonb_array_elements(p_items)
    LOOP
      v_item_id    := (v_item->>'id')::INTEGER;
      v_sales_qty  := (v_item->>'sales_qty')::NUMERIC;
      v_unit_price := (v_item->>'unit_price')::NUMERIC;

      -- SalesQty 必须 > 0
      IF v_sales_qty IS NOT NULL AND v_sales_qty <= 0 THEN
        RAISE EXCEPTION 'SalesQty 必须大于 0';
      END IF;
      -- UnitPrice 必须 >= 0
      IF v_unit_price IS NOT NULL AND v_unit_price < 0 THEN
        RAISE EXCEPTION 'UnitPrice 不能为负数';
      END IF;

      UPDATE customer_order_request_items
      SET "SalesQty"  = COALESCE(v_sales_qty, "SalesQty"),
          "UnitPrice" = COALESCE(v_unit_price, "UnitPrice"),
          "LineTotal" = COALESCE(v_sales_qty, "SalesQty") * COALESCE(v_unit_price, "UnitPrice"),
          "UpdatedAt" = now()
      WHERE id = v_item_id
        AND "RequestID" = p_request_id;
    END LOOP;
  END IF;

  -- 更新主表
  UPDATE customer_order_requests
  SET "SalesNote"  = COALESCE(p_sales_note, "SalesNote"),
      "Status"     = COALESCE(p_new_status, "Status"),
      "ReviewedBy" = COALESCE(app_display_name(), "ReviewedBy"),
      "ReviewedAt" = CASE WHEN p_new_status IS NOT NULL THEN now() ELSE "ReviewedAt" END,
      "UpdatedAt"  = now()
  WHERE "RequestID" = p_request_id;

  PERFORM write_audit(
    'Sales 更新客户申请', p_request_id,
    CASE WHEN p_new_status IS NOT NULL
      THEN '状态 → ' || p_new_status
      ELSE '更新明细/备注'
    END
  );
END;
$$;

/*
  Warehouse/Purchase/Admin 查货
  - 标记每行 warehouse_status：有货 / 部分有货 / 无货
  - 填写 warehouse_note
  - 不能看/改价格
*/
CREATE OR REPLACE FUNCTION warehouse_update_customer_request(
  p_request_id     TEXT,
  p_items          JSONB DEFAULT NULL,
  p_warehouse_note TEXT  DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role           TEXT;
  v_current_status TEXT;
  v_item           JSONB;
  v_item_id        INTEGER;
  v_ws             TEXT;
  v_wn             TEXT;
BEGIN
  v_role := app_role();
  IF auth.uid() IS NULL OR v_role IS NULL OR v_role <> ALL(ARRAY['admin', 'warehouse', 'purchase']) THEN
    RAISE EXCEPTION 'Permission denied';
  END IF;

  SELECT "Status" INTO v_current_status
  FROM customer_order_requests
  WHERE "RequestID" = p_request_id
  FOR UPDATE;

  IF v_current_status IS NULL THEN
    RAISE EXCEPTION '申请不存在';
  END IF;

  IF v_current_status <> 'warehouse_check' THEN
    RAISE EXCEPTION '当前状态不是 warehouse_check，无法查货';
  END IF;

  IF p_items IS NOT NULL AND jsonb_typeof(p_items) = 'array' THEN
    FOR v_item IN SELECT value FROM jsonb_array_elements(p_items)
    LOOP
      v_item_id := (v_item->>'id')::INTEGER;
      v_ws      := v_item->>'warehouse_status';
      v_wn      := v_item->>'warehouse_note';

      IF v_ws IS NOT NULL AND v_ws NOT IN ('有货', '部分有货', '无货') THEN
        RAISE EXCEPTION '无效的仓库状态: %', v_ws;
      END IF;

      UPDATE customer_order_request_items
      SET "WarehouseStatus" = COALESCE(v_ws, "WarehouseStatus"),
          "WarehouseNote"   = COALESCE(v_wn, "WarehouseNote"),
          "UpdatedAt"       = now()
      WHERE id = v_item_id
        AND "RequestID" = p_request_id;
    END LOOP;
  END IF;

  UPDATE customer_order_requests
  SET "WarehouseNote"      = COALESCE(p_warehouse_note, "WarehouseNote"),
      "WarehouseCheckedBy" = COALESCE(app_display_name(), "WarehouseCheckedBy"),
      "WarehouseCheckedAt" = now(),
      "UpdatedAt"          = now()
  WHERE "RequestID" = p_request_id;

  PERFORM write_audit('仓库查货', p_request_id, '');
END;
$$;

/*
  Sales 联系客户 / 拒绝申请
  - 填写联系记录（ContactMethod + ContactNote）
  - 拒绝时必须先有联系记录 + 填写 RejectReason
*/
CREATE OR REPLACE FUNCTION sales_contact_customer(
  p_request_id    TEXT,
  p_contact_method TEXT DEFAULT 'WhatsApp',
  p_contact_note  TEXT DEFAULT '',
  p_reject_reason TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role           TEXT;
  v_current_status TEXT;
  v_contact_count  INTEGER;
BEGIN
  v_role := app_role();
  IF auth.uid() IS NULL OR v_role IS NULL OR v_role <> ALL(ARRAY['admin', 'sales']) THEN
    RAISE EXCEPTION 'Permission denied';
  END IF;

  SELECT "Status" INTO v_current_status
  FROM customer_order_requests
  WHERE "RequestID" = p_request_id
  FOR UPDATE;

  IF v_current_status IS NULL THEN
    RAISE EXCEPTION '申请不存在';
  END IF;

  IF v_current_status IN ('converted', 'cancelled', 'rejected') THEN
    RAISE EXCEPTION '申请已处理（%），无法操作', v_current_status;
  END IF;

  -- 插入联系记录
  INSERT INTO customer_order_contact_logs (
    "RequestID", "ContactMethod", "ContactNote", "ContactedAt", "ContactedBy"
  )
  VALUES (
    p_request_id, p_contact_method, p_contact_note, now(),
    COALESCE(app_display_name(), '')
  );

  -- 如果是拒绝操作：联系备注和拒绝原因都必须填写
  IF p_reject_reason IS NOT NULL THEN
    IF trim(p_contact_note) = '' THEN
      RAISE EXCEPTION '拒绝前必须填写联系备注';
    END IF;
    IF trim(p_reject_reason) = '' THEN
      RAISE EXCEPTION '拒绝原因不能为空';
    END IF;

    SELECT COUNT(*) INTO v_contact_count
    FROM customer_order_contact_logs
    WHERE "RequestID" = p_request_id;

    IF v_contact_count = 0 THEN
      RAISE EXCEPTION '拒绝前必须联系客户并填写联系记录';
    END IF;

    UPDATE customer_order_requests
    SET "Status"       = 'rejected',
        "RejectReason" = p_reject_reason,
        "UpdatedAt"    = now()
    WHERE "RequestID" = p_request_id;

    PERFORM write_audit('拒绝客户申请', p_request_id, p_reject_reason);
  ELSE
    PERFORM write_audit('联系客户', p_request_id, p_contact_method || ' · ' || p_contact_note);
  END IF;
END;
$$;

/*
  Sales/Admin 确认后将客户申请转换为 YCPos 正式订单
  - 生成 purchase_orders + po_details
  - 使用 SalesQty（如无则用客户原始 Qty）和 UnitPrice
  - 不在此步骤扣库存（沿用现有负库存机制）
  - 不可重复转换
*/
CREATE OR REPLACE FUNCTION convert_customer_request_to_order(
  p_request_id TEXT
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role           TEXT;
  v_current_status TEXT;
  v_customer_id    TEXT;
  v_po_id          TEXT;
  v_detail_id      TEXT;
  v_item           RECORD;
  v_sales_qty      NUMERIC;
  v_unit_price     NUMERIC;
  v_line_total     NUMERIC;
  v_total          NUMERIC := 0;
BEGIN
  v_role := app_role();
  IF auth.uid() IS NULL OR v_role IS NULL OR v_role <> ALL(ARRAY['admin', 'sales']) THEN
    RAISE EXCEPTION 'Permission denied';
  END IF;

  SELECT "Status", "CustomerID"
  INTO v_current_status, v_customer_id
  FROM customer_order_requests
  WHERE "RequestID" = p_request_id
  FOR UPDATE;

  IF v_current_status IS NULL THEN
    RAISE EXCEPTION '申请不存在';
  END IF;

  -- 只允许 confirmed 状态转换
  IF v_current_status <> 'confirmed' THEN
    RAISE EXCEPTION '只有已确认（confirmed）的申请才能转换，当前状态: %', v_current_status;
  END IF;

  -- 确认申请至少有一行明细
  IF NOT EXISTS (
    SELECT 1 FROM customer_order_request_items
    WHERE "RequestID" = p_request_id
  ) THEN
    RAISE EXCEPTION '申请没有明细，无法转换';
  END IF;

  -- 生成正式 purchase_orders
  v_po_id := 'PO-' || to_char(now(), 'YYMMDD') || '-' || substr(md5(random()::text), 1, 4);

  INSERT INTO purchase_orders ("POID", "Date", "Time", "CustomerID", "Status", "TotalAmount", "Note")
  VALUES (
    v_po_id, current_date::text, to_char(now(), 'HH24:MI:SS'),
    v_customer_id, 'pending', 0,
    '客户申请转单: ' || p_request_id
  );

  FOR v_item IN
    SELECT i.*, p."ProductName"
    FROM customer_order_request_items i
    JOIN products p ON p."ProductID" = i."ProductID"
    WHERE i."RequestID" = p_request_id
  LOOP
    v_sales_qty  := COALESCE(v_item."SalesQty", v_item."Qty");
    v_unit_price := COALESCE(v_item."UnitPrice", 0);

    -- 转换前再次校验：SalesQty 必须 > 0，UnitPrice 必须 >= 0
    IF v_sales_qty <= 0 THEN
      RAISE EXCEPTION '产品 "%" 的 SalesQty 必须大于 0，当前: %', v_item."ProductID", v_sales_qty;
    END IF;
    IF v_unit_price < 0 THEN
      RAISE EXCEPTION '产品 "%" 的 UnitPrice 不能为负数，当前: %', v_item."ProductID", v_unit_price;
    END IF;

    v_line_total := v_sales_qty * v_unit_price;

    v_detail_id := substr(md5(random()::text || clock_timestamp()::text), 1, 10);

    INSERT INTO po_details ("DetailID", "POID", "ProductID", "QTY", "UnitPrice", "LineTotal")
    VALUES (v_detail_id, v_po_id, v_item."ProductID", v_sales_qty, v_unit_price, v_line_total);

    v_total := v_total + v_line_total;
  END LOOP;

  UPDATE purchase_orders SET "TotalAmount" = v_total WHERE "POID" = v_po_id;

  -- 更新客户申请状态
  UPDATE customer_order_requests
  SET "Status"       = 'converted',
      "ConvertedPOID" = v_po_id,
      "ConvertedBy"   = COALESCE(app_display_name(), ''),
      "ConvertedAt"   = now(),
      "UpdatedAt"     = now()
  WHERE "RequestID" = p_request_id;

  PERFORM write_audit('客户申请转正式订单', p_request_id, '→ ' || v_po_id || ' 总额 ' || v_total);

  RETURN v_po_id;
END;
$$;

-- ============================================
-- 权限授予
-- 原则：每个新函数先 REVOKE FROM PUBLIC，再只 GRANT 给需要的角色
-- ============================================

-- 内部工具函数 —— 禁止所有外部调用
REVOKE EXECUTE ON FUNCTION validate_customer_token(TEXT) FROM PUBLIC;

-- 客户 RPC —— 先收回 PUBLIC，再只授予 anon
REVOKE EXECUTE ON FUNCTION get_customer_portal_context(TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION submit_customer_order_request(TEXT, JSONB, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION get_customer_order_requests(TEXT) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION get_customer_portal_context(TEXT) TO anon;
GRANT EXECUTE ON FUNCTION submit_customer_order_request(TEXT, JSONB, TEXT) TO anon;
GRANT EXECUTE ON FUNCTION get_customer_order_requests(TEXT) TO anon;

-- 员工 RPC —— 先收回 PUBLIC，再只授予 authenticated
REVOKE EXECUTE ON FUNCTION get_customer_requests_app() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION sales_update_customer_request(TEXT, JSONB, TEXT, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION warehouse_update_customer_request(TEXT, JSONB, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION sales_contact_customer(TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION convert_customer_request_to_order(TEXT) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION get_customer_requests_app() TO authenticated;
GRANT EXECUTE ON FUNCTION sales_update_customer_request(TEXT, JSONB, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION warehouse_update_customer_request(TEXT, JSONB, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION sales_contact_customer(TEXT, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION convert_customer_request_to_order(TEXT) TO authenticated;

-- 禁止 anon 和 authenticated 直接读写新表
REVOKE ALL ON TABLE customer_portal_tokens FROM anon, authenticated;
REVOKE ALL ON TABLE customer_order_requests FROM anon, authenticated;
REVOKE ALL ON TABLE customer_order_request_items FROM anon, authenticated;
REVOKE ALL ON TABLE customer_order_contact_logs FROM anon, authenticated;

-- ============================================
-- 验收测试 SQL（执行后在 Supabase SQL Editor 验证）
-- ============================================
/*
-- 1. 确认所有新表已创建
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public' AND table_name LIKE 'customer_%';

-- 2. 确认 RLS 已开启
SELECT tablename, rowsecurity FROM pg_tables
WHERE schemaname = 'public' AND tablename LIKE 'customer_%';

-- 3. 确认 anon 不能直接查表（应报错 permission denied）
-- SET ROLE anon; SELECT * FROM customer_order_requests LIMIT 1; RESET ROLE;

-- 4. 确认客户 RPC 已授权给 anon
SELECT routine_name, routine_type FROM information_schema.routines
WHERE routine_schema = 'public'
  AND routine_name IN (
    'get_customer_portal_context',
    'submit_customer_order_request',
    'get_customer_order_requests'
  );
*/
