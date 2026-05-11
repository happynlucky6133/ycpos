-- ============================================
-- YCPos 加工 / 损耗记录表
-- 如果现有数据库已经建立，只需要在 Supabase SQL Editor 执行这个文件。
-- ============================================

CREATE TABLE IF NOT EXISTS processing_logs (
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
