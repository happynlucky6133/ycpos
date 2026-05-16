# FreshStack Order Savepoint

## 当前阶段

**第 1 步完成（已修正），尚未进入第 2 步。**

## 已完成内容

### 新建文件
- `supabase_customer_portal_v1.sql` — RLS-first 数据库骨架（已修正 12 个安全问题，尚未在 Supabase 执行）
- `claudecodeplan.md` — 8 步完整执行方案

### supabase_customer_portal_v1.sql 内容

**4 张新表（全部 ENABLE ROW LEVEL SECURITY，不给 anon/authenticated 直接读写）：**
- `customer_portal_tokens` — 客户专属链接 token（token_hash 存 SHA-256，UNIQUE INDEX）
- `customer_order_requests` — 客户订货申请主表（8 种状态 CHECK，ConvertedPOID 预留）
- `customer_order_request_items` — 申请明细（含 SalesQty/UnitPrice/LineTotal/WarehouseStatus）
- `customer_order_contact_logs` — Sales 联系客户记录

**9 个 SECURITY DEFINER RPC（全部先 REVOKE FROM PUBLIC 再按需 GRANT）：**

| RPC | 调用者 | 用途 |
|-----|--------|------|
| `validate_customer_token` | 内部 | token SHA-256 验证，不对外暴露 |
| `get_customer_portal_context` | anon | 客户门户上下文（不含价格/库存） |
| `submit_customer_order_request` | anon | 客户提交申请（不生成 PO，不扣库存） |
| `get_customer_order_requests` | anon | 客户查看自己的申请（不含价格） |
| `get_customer_requests_app` | authenticated | 员工查看申请（按角色剥离价格字段） |
| `sales_update_customer_request` | authenticated | Sales 审核/填价格/推进状态（严格流转校验） |
| `warehouse_update_customer_request` | authenticated | Warehouse 查货标记（不能看/改价格） |
| `sales_contact_customer` | authenticated | 联系客户/拒绝（拒绝时强制联系备注+原因） |
| `convert_customer_request_to_order` | authenticated | 转换正式订单（仅 confirmed，防重复） |

**状态流转（严格锁死）：**
```
submitted → sales_review → warehouse_check → waiting_customer → confirmed → converted
                                              ↘ confirmed      → converted
rejected  ← 只能通过 sales_contact_customer
cancelled ← 暂无函数触发（预留）
converted ← 只能通过 convert_customer_request_to_order
```

### 安全校验要点
- SalesQty > 0，UnitPrice >= 0（写入时 + 转换前双重校验）
- 拒绝时 contact_note 和 reject_reason 都不能为空
- 转换前检查至少有一行明细
- sales_update 不可设 rejected / converted / cancelled
- convert 只允许 Status = 'confirmed'

## 未执行内容

- `supabase_customer_portal_v1.sql` **尚未在 Supabase SQL Editor 执行**
- 未修改任何现有前端文件（index.html / app.js / style.css）
- 未创建客户页面（customer.html / customer.js / customer.css）
- 未部署到 order.freshstack.cc

## 明天要做什么

**第 2 步**：客户下单独立页面。
- 新建 `customer.html`、`customer.js`、`customer.css`
- 从 URL 读取 token → 调用 `get_customer_portal_context`
- 显示客户名 + 可下单产品（不显示价格/库存）
- 多产品下单 + 数量输入 + 备注
- 调用 `submit_customer_order_request` 提交
- 调用 `get_customer_order_requests` 显示历史
- 适配手机和平板
- token 无效时显示"无权限访问"

指令块在 `claudecodeplan.md` 第 2 步。

**前提**：第 1 步 SQL 需先在 Supabase SQL Editor 中执行并通过验证。

## 需要 Codex 检查的文件

1. `supabase_customer_portal_v1.sql` — 整个文件（表结构 + RLS + 所有 RPC + 权限授予）
2. `claudecodeplan.md` — 第 2 步指令是否清晰可行
