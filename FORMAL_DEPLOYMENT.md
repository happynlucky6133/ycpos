# YCPos 正式版部署步骤

## 1. 执行数据库脚本

在 Supabase SQL Editor 依次执行：

1. `supabase_processing.sql`
2. `supabase_formal_v2.sql`

`supabase_formal_v2.sql` 会建立：

- `staff_profiles` 员工角色表
- RLS policies
- 库存/订单/加工 RPC
- `autocount_sync_queue`，先预留 AutoCount 单向同步队列

## 2. 建立员工账号

第一次管理员账号仍然需要在 Supabase Dashboard 的 Authentication 里新增 Email/password。

然后把第一个管理员写入 `staff_profiles`：

```sql
INSERT INTO staff_profiles (id, "DisplayName", "Role", "Active")
SELECT id, '管理员', 'admin', true
FROM auth.users
WHERE email = 'admin@example.com';
```

角色只允许：

- `admin`
- `sales`
- `purchase`
- `warehouse`

之后新增员工可以直接在 YCPos app 右上角点击 `👤+` 创建。创建前请确认已执行 `supabase_staff_profiles_admin_policy.sql`，或已使用包含该员工创建函数的最新版 `supabase_formal_v2.sql` / `supabase_formal_upgrade_v3.sql`。

如果希望员工创建后马上可以登录，请到 Supabase Dashboard：

Authentication → Providers → Email → 关闭 `Confirm email`

如果这个开关是开启状态，app 可以创建账号，但员工必须先完成邮箱确认才可以登录。

## 3. 前端登录

YCPos 登录页现在使用员工 Email + password。

前端不再使用旧的 `users` 明文密码表。旧表可以先保留一个月作为备份，但正式流程不要继续新增旧账号。

## 4. 试跑期间

这一个月先不接 AutoCount。系统会把未来需要同步的资料写入 `autocount_sync_queue`：

- product
- customer
- supplier
- stock_in
- sales_order

等流程稳定后，再做 Windows AutoCount Sync App 来读取这个队列并写入 AutoCount。

## 5. 重要提醒

开启 RLS 后，前端直接写表会被挡住。正式版写入必须走 RPC：

- `create_product`
- `create_supplier`
- `create_customer`
- `create_stock_in`
- `process_fruit_loss`
- `create_sales_order`
- `change_sales_order_status`
