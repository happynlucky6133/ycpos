-- ============================================
-- YCPos 审计日志表
-- 在 Supabase SQL Editor 中执行
-- ============================================

CREATE TABLE audit_logs (
  id SERIAL PRIMARY KEY,
  "Timestamp" TEXT NOT NULL,
  "User" TEXT NOT NULL,
  "Action" TEXT NOT NULL,
  "Target" TEXT DEFAULT '',
  "Detail" TEXT DEFAULT ''
);