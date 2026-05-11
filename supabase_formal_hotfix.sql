-- ============================================
-- YCPos 正式版热修复
-- 解决旧数据库表缺少字段导致 create_stock_in 失败的问题。
-- 可重复执行。
-- ============================================

ALTER TABLE stock_ins ADD COLUMN IF NOT EXISTS "CreatedBy" TEXT DEFAULT '';
ALTER TABLE stock_ins ADD COLUMN IF NOT EXISTS "CreatedAt" TEXT DEFAULT '';
ALTER TABLE stock_ins ADD COLUMN IF NOT EXISTS "UpdatedBy" TEXT DEFAULT '';
ALTER TABLE stock_ins ADD COLUMN IF NOT EXISTS "UpdatedAt" TEXT DEFAULT '';
ALTER TABLE stock_ins ADD COLUMN IF NOT EXISTS "AutoCountDocNo" TEXT;

ALTER TABLE products ADD COLUMN IF NOT EXISTS "AutoCountItemCode" TEXT;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS "AutoCountCreditorCode" TEXT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS "AutoCountDebtorCode" TEXT;
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS "AutoCountDocNo" TEXT;
