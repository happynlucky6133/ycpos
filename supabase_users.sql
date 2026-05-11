-- ============================================
-- YCPos 用户权限表（修正版）
-- 在 Supabase SQL Editor 中执行
-- ============================================

-- 创建用户表
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  "Username" TEXT UNIQUE NOT NULL,
  "Password" TEXT NOT NULL,
  "Role" TEXT NOT NULL,
  "DisplayName" TEXT NOT NULL,
  CONSTRAINT valid_role CHECK ("Role" IN ('admin', 'sales', 'purchase', 'warehouse'))
);

-- 插入预设账户（请尽快修改密码！）
INSERT INTO users ("Username", "Password", "Role", "DisplayName") VALUES
('admin', 'admin123', 'admin', '管理员'),
('sales', 'sales123', 'sales', '销售员'),
('purchase', 'purchase123', 'purchase', '采购员');
