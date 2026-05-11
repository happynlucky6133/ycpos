-- ============================================
-- YCPos 数据库表创建脚本
-- 在 Supabase SQL Editor 中执行
-- ============================================

-- 1. 产品表
CREATE TABLE products (
  id SERIAL PRIMARY KEY,
  "ProductID" TEXT UNIQUE NOT NULL,
  "ProductName" TEXT NOT NULL,
  "Grade" TEXT DEFAULT '',
  "Unit" TEXT DEFAULT 'kg',
  "StockBalance" NUMERIC DEFAULT 0,
  "Note" TEXT DEFAULT ''
);

-- 2. 供应商表
CREATE TABLE suppliers (
  id SERIAL PRIMARY KEY,
  "SupplierID" TEXT UNIQUE NOT NULL,
  "SupplierName" TEXT NOT NULL,
  "Phone" TEXT DEFAULT '',
  "Note" TEXT DEFAULT ''
);

-- 3. 客户表
CREATE TABLE customers (
  id SERIAL PRIMARY KEY,
  "CustomerID" TEXT UNIQUE NOT NULL,
  "CustomerName" TEXT NOT NULL,
  "Phone" TEXT DEFAULT '',
  "Note" TEXT DEFAULT ''
);

-- 4. 进货主表
CREATE TABLE stock_ins (
  id SERIAL PRIMARY KEY,
  "StockInID" TEXT UNIQUE NOT NULL,
  "Date" TEXT NOT NULL,
  "Time" TEXT NOT NULL,
  "SupplierID" TEXT NOT NULL,
  "CreatedBy" TEXT DEFAULT '',
  "CreatedAt" TEXT DEFAULT '',
  "UpdatedBy" TEXT DEFAULT '',
  "UpdatedAt" TEXT DEFAULT '',
  "Note" TEXT DEFAULT ''
);

-- 5. 进货详情表
CREATE TABLE stock_in_details (
  id SERIAL PRIMARY KEY,
  "DetailID" TEXT UNIQUE NOT NULL,
  "StockInID" TEXT NOT NULL,
  "ProductID" TEXT NOT NULL,
  "Qty" NUMERIC NOT NULL
);

-- 6. 采购订单表
CREATE TABLE purchase_orders (
  id SERIAL PRIMARY KEY,
  "POID" TEXT UNIQUE NOT NULL,
  "Date" TEXT NOT NULL,
  "Time" TEXT NOT NULL,
  "CustomerID" TEXT NOT NULL,
  "Status" TEXT DEFAULT 'pending',
  "TotalAmount" NUMERIC DEFAULT 0,
  "Note" TEXT DEFAULT ''
);

-- 7. 订单详情表
CREATE TABLE po_details (
  id SERIAL PRIMARY KEY,
  "DetailID" TEXT UNIQUE NOT NULL,
  "POID" TEXT NOT NULL,
  "ProductID" TEXT NOT NULL,
  "QTY" NUMERIC NOT NULL,
  "UnitPrice" NUMERIC DEFAULT 0,
  "LineTotal" NUMERIC DEFAULT 0
);

-- 8. 加工 / 损耗记录
-- SourceProductID 是收货等级库存，TargetProductID 是出货等级库存。
-- 例：香蕉整串 -> 香蕉 A，InputQty - StemLoss - OtherLoss = OutputQty。
CREATE TABLE processing_logs (
  id SERIAL PRIMARY KEY,
  "ProcessID" TEXT UNIQUE NOT NULL,
  "Date" TEXT NOT NULL,
  "Time" TEXT NOT NULL,
  "SourceProductID" TEXT NOT NULL,
  "TargetProductID" TEXT NOT NULL,
  "InputQty" NUMERIC NOT NULL,
  "StemLoss" NUMERIC DEFAULT 0,
  "OtherLoss" NUMERIC DEFAULT 0,
  "OutputQty" NUMERIC NOT NULL,
  "CreatedBy" TEXT DEFAULT '',
  "CreatedAt" TEXT DEFAULT now()
);

-- 插入一些示例数据用于测试（可选）
-- INSERT INTO products ("ProductID", "ProductName", "Grade", "Unit", "StockBalance") VALUES
-- ('p001', '测试产品A', 'A', 'kg', 100),
-- ('p002', '测试产品B', 'B', 'kg', 50);
