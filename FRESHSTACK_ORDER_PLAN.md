# FreshStack Order 客户订货系统开发计划书

## 1. 项目目标

在现有 YCPos 内部系统之外，建立一个完全独立的客户订货系统。

内部员工继续使用：

```text
ycpos.freshstack.cc
```

客户订货入口建议使用：

```text
order.freshstack.cc/yc
```

客户系统名称：

```text
FreshStack Order
```

客户系统只负责让客户提交“订货申请”，不直接生成正式出货订单，不直接扣库存，不显示价格，不显示库存。

客户提交后，由 Sales 审核、Warehouse 查货，Sales 最终确认后才转换成 YCPos 正式订单。

## 2. 核心原则

本项目必须从第一步开始建立在 RLS-first 的安全架构上。

不能先做出页面再补权限。所有客户入口都必须默认不可信。

### 客户可以看到

- 自己的客户名称
- 可下单产品名称
- 产品单位，例如 kg、box、pcs
- 自己提交过的订货申请
- 自己申请的处理状态
- 自己申请的备注

### 客户不能看到

- 价格
- 库存数量
- 供应商
- 采购资料
- 损耗资料
- 员工资料
- 其他客户资料
- 正式 YCPos 订单表
- AutoCount 同步资料

### 仓库可以看到

- 客户名
- 产品
- 数量
- 客户备注
- 仓库查货状态
- 仓库备注

### 仓库不能看到

- 单价
- 总价
- 客户价格历史
- Sales 内部价格备注

### Sales/Admin 可以看到

- 客户申请完整资料
- 产品数量
- 单价
- 总额
- Sales 备注
- 仓库查货结果
- 联系客户记录
- 转正式订单功能

## 3. 总体业务流程

```text
客户打开专属链接
        ↓
提交订货申请
        ↓
状态：客户已提交
        ↓
Sales 审核 / 调整数量 / 填价格
        ↓
Sales 送仓库查货
        ↓
Warehouse 确认有货 / 部分有货 / 无货
        ↓
Sales 联系客户或确认订单
        ↓
Sales 确认生成 YCPos 正式订单
        ↓
进入现有 YCPos 流程
        ↓
待处理 → 确认备货 → 确认上车 → 完成
```

客户申请不是正式订单。只有 Sales/Admin 确认后，系统才生成正式 `purchase_orders` 和 `po_details`。

## 4. 状态设计

客户订货申请建议使用以下状态：

```text
submitted           客户已提交
sales_review        Sales 审核中
warehouse_check     仓库查货中
waiting_customer    等客户回复
confirmed           已确认
converted           已转正式订单
rejected            已拒绝
cancelled           已取消
```

状态流：

```text
submitted
  ↓
sales_review
  ↓
warehouse_check
  ↓
waiting_customer / confirmed
  ↓
converted
```

取消或拒绝规则：

- 客户提交后，Sales/Admin 可以取消。
- Sales/Admin 拒绝前，必须填写联系客户记录。
- Warehouse 不能拒绝订单，只能标记有货、部分有货、无货。
- converted 后不可再修改客户申请，只能通过正式订单的退货/冲销功能处理。

## 5. 登录与客户识别

测试版先使用客户专属链接，不做账号密码和 WhatsApp OTP。

示例：

```text
https://order.freshstack.cc/yc?token=随机长token
```

token 要求：

- 必须是随机长 token。
- 不能使用客户名、电话、CustomerID 作为 token。
- 数据库只保存 token hash，不保存明文 token。
- token 可以停用。
- token 可以设置过期时间。
- token 使用时记录 `last_used_at`。

未来正式版可以升级：

- 客户账号密码登录
- WhatsApp OTP 登录
- 每个客户多个联系人账号

## 6. 数据库架构

新增客户订货相关表，和现有正式订单表分开。

### 6.1 customer_portal_tokens

用途：客户专属链接 token。

建议字段：

```text
id
CustomerID
token_hash
label
is_active
expires_at
created_at
created_by
last_used_at
```

说明：

- `token_hash` 保存 hash，不保存明文 token。
- `CustomerID` 对应现有 customers 表。
- `is_active = false` 时链接失效。
- `expires_at` 为空代表不过期。

### 6.2 customer_order_requests

用途：客户订货申请主表。

建议字段：

```text
id
RequestID
CustomerID
Status
CustomerNote
SalesNote
WarehouseNote
RejectReason
ConvertedPOID
CreatedAt
UpdatedAt
SubmittedAt
ReviewedBy
ReviewedAt
WarehouseCheckedBy
WarehouseCheckedAt
ConvertedBy
ConvertedAt
```

说明：

- `ConvertedPOID` 保留未来转换正式 YCPos 订单。
- 转换后状态为 `converted`。
- 不在这里直接扣库存。

### 6.3 customer_order_request_items

用途：客户订货申请明细。

建议字段：

```text
id
RequestID
ProductID
Qty
CustomerNote
SalesQty
UnitPrice
LineTotal
WarehouseStatus
WarehouseNote
CreatedAt
UpdatedAt
```

说明：

- 客户提交的是 `Qty`。
- Sales 可调整为 `SalesQty`。
- `UnitPrice` 和 `LineTotal` 只有 Sales/Admin 可见。
- Warehouse 只能看产品、数量、仓库状态和仓库备注。

### 6.4 customer_order_contact_logs

用途：Sales 联系客户记录。

建议字段：

```text
id
RequestID
ContactMethod
ContactNote
ContactedAt
ContactedBy
CreatedAt
```

说明：

- 拒绝订单前必须至少有一条联系记录。
- `ContactMethod` 可选：WhatsApp、电话、其他。
- 后期可以加 WhatsApp 自动打开链接。

## 7. RLS 与权限原则

所有新表必须开启 RLS：

```sql
ALTER TABLE customer_portal_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_order_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_order_request_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_order_contact_logs ENABLE ROW LEVEL SECURITY;
```

测试版客户不是 Supabase Auth 用户，所以客户前端不应该直接 select / insert / update 表。

客户只能调用指定 SECURITY DEFINER RPC。

### 7.1 客户 RPC

客户可调用：

```text
get_customer_portal_context(p_token TEXT)
submit_customer_order_request(p_token TEXT, p_items JSONB, p_note TEXT)
get_customer_order_requests(p_token TEXT)
```

这些 RPC 必须：

- 验证 token hash。
- 验证 token 是否 active。
- 验证 token 是否过期。
- 只能返回该 token 对应客户的数据。
- 不能返回价格。
- 不能返回库存。
- 不能返回供应商。
- 不能返回其他客户数据。

### 7.2 员工 RPC

员工继续使用 Supabase Auth 和现有 `staff_profiles` / `app_role()`。

员工可调用：

```text
get_customer_requests_app()
sales_update_customer_request(...)
warehouse_update_customer_request(...)
sales_contact_customer(...)
convert_customer_request_to_order(...)
```

权限建议：

```text
Admin:
  可以查看和处理全部。

Sales:
  可以查看客户申请、填价格、改数量、联系客户、拒绝、确认、转换正式订单。

Warehouse/Purchase:
  可以查看客户申请的产品和数量。
  可以标记有货、部分有货、无货。
  可以写仓库备注。
  不能看价格。
  不能转换正式订单。
```

### 7.3 禁止直接访问

客户前端不能直接访问：

```text
products
customers
purchase_orders
po_details
stock_ins
stock_in_details
processing_logs
staff_profiles
autocount_sync_queue
```

客户前端也不能直接访问新增客户申请表。

## 8. 前端架构

客户系统必须和内部 YCPos 前端分离。

建议新增文件：

```text
customer.html
customer.js
customer.css
```

客户页面只包含：

- 客户名称
- 产品列表
- 多产品下单
- 数量输入
- 备注输入
- 提交按钮
- 自己的申请记录
- 申请状态

客户页面不包含：

- 内部菜单
- 库存页面
- 进货页面
- 加工损耗页面
- 正式订单处理按钮
- 价格显示
- 仓库操作
- Sales 操作

## 9. 内部 YCPos 改动范围

内部系统新增一个页面或 tab：

```text
客户申请
```

Sales/Admin 页面功能：

- 查看客户申请列表
- 查看申请明细
- 修改 SalesQty
- 填 UnitPrice
- 写 SalesNote
- 送仓库查货
- WhatsApp 联系客户
- 填联系记录
- 拒绝申请
- 确认并生成正式订单

Warehouse/Purchase/Admin 页面功能：

- 查看客户申请列表
- 查看产品和数量
- 标记有货、部分有货、无货
- 写仓库备注

权限要求：

- Sales/Admin 可见价格。
- Warehouse/Purchase 不可见价格。
- 客户入口完全不可访问内部页面。

## 10. 打印与通知

第一版不做自动通知。

拒绝或等待客户回复时，提供 WhatsApp 快捷联系按钮：

```text
https://wa.me/60xxxxxxxxx?text=...
```

示例文字：

```text
您好，关于您的订货申请 #CR-260514-001，部分产品今天暂时无法供应。请问是否调整数量或改明天出货？
```

第一版不需要客户自动收到系统通知。Sales 联系客户后必须回系统填写联系记录。

## 11. 分阶段开发计划

每一步只做一件事。Claude Code 每完成一步后，必须停止，等待检查。

### 第 1 步：RLS-first 数据库骨架

目标：建立客户订货系统数据库和安全 RPC，不改前端。

交付：

```text
supabase_customer_portal_v1.sql
```

内容：

- 新建 4 张客户订货表。
- 所有新表开启 RLS。
- 不给 anon 直接读写表。
- 建 token hash 验证函数。
- 建客户 RPC。
- 建员工查看 RPC。
- 明确 GRANT / REVOKE。

验收：

- 客户 RPC 不返回价格。
- 客户 RPC 不返回库存。
- token 无效时拒绝。
- token 过期时拒绝。
- 客户提交申请不生成正式订单。
- 客户提交申请不扣库存。

### 第 2 步：客户下单独立页面

目标：新增客户页面。

交付：

```text
customer.html
customer.js
customer.css
```

功能：

- 从 URL 读取 token。
- 调用 `get_customer_portal_context`。
- 显示客户名称。
- 显示可下单产品。
- 多产品下单。
- 填数量和备注。
- 提交申请。
- 查看自己的申请记录。

验收：

- 不显示价格。
- 不显示库存。
- 不出现内部 YCPos 菜单。
- 手机和平板可用。
- token 错误时显示无权限。

### 第 3 步：内部系统查看客户申请

目标：YCPos 内部增加客户申请列表。

功能：

- Sales/Admin 查看完整申请。
- Warehouse/Purchase 查看不含价格的申请。
- 按日期和状态筛选。

验收：

- Sales/Admin 可看价格字段。
- Warehouse/Purchase 看不到价格字段。
- 客户入口不能访问。

### 第 4 步：Sales 审核与填价格

目标：Sales 可以审核客户申请。

功能：

- 修改数量。
- 填单价。
- 写 Sales 备注。
- 送仓库查货。

状态：

```text
submitted → sales_review → warehouse_check
```

验收：

- 价格只有 Sales/Admin 可见。
- 送仓库后 Warehouse 能看到。
- 不扣库存。
- 不生成正式订单。

### 第 5 步：Warehouse 查货

目标：仓库确认有没有货。

功能：

- 有货。
- 部分有货。
- 无货。
- 仓库备注。

验收：

- Warehouse/Purchase 不看到价格。
- Warehouse/Purchase 不能转换正式订单。
- Sales 能看到仓库结果。

### 第 6 步：拒绝必须联系客户

目标：Sales 拒绝申请前必须联系客户。

功能：

- WhatsApp 联系客户按钮。
- 联系方式。
- 联系备注。
- 拒绝原因。
- 联系记录保存。

验收：

- 没有联系记录不能拒绝。
- 没有拒绝原因不能拒绝。
- 联系记录可以追踪。

### 第 7 步：确认后转正式订单

目标：Sales/Admin 把客户申请转换成 YCPos 正式订单。

功能：

- 生成 `purchase_orders`。
- 生成 `po_details`。
- 保存 `ConvertedPOID`。
- 状态改为 `converted`。

验收：

- 不能重复转换。
- 转换后进入现有 YCPos 流程。
- 仍然允许负库存。
- 完成订单时才扣库存。

### 第 8 步：部署到 order.freshstack.cc/yc

目标：客户系统独立部署。

内容：

- 配置部署路径。
- 检查 PWA 缓存。
- 检查 Supabase URL/key。
- 检查手机和平板显示。

验收：

- `ycpos.freshstack.cc` 是内部员工入口。
- `order.freshstack.cc/yc` 是客户入口。
- 两边不会互相跳错。
- 客户入口不能进入内部 POS。

## 12. Claude Code 每阶段执行规则

每次只给 Claude Code 一个阶段。

固定指令模板：

```text
你只做 FreshStack Order 第 X 步，不要做其他阶段。
保持现有 YCPos 功能不变。
必须遵守 RLS-first 安全原则。
不要重构无关代码。
不要暴露价格、库存、供应商给客户入口。
完成后列出：
1. 修改文件
2. 新增 SQL
3. 权限设计
4. 测试方式
5. 你没有做的后续阶段
```

## 13. 每阶段检查清单

每次 Claude Code 做完后，需要检查：

- 是否影响现有 YCPos。
- 是否绕过 RLS。
- 是否让客户直接访问内部表。
- 是否让客户看到价格。
- 是否让客户看到库存。
- 是否让 Warehouse 看到价格。
- 是否可以重复提交或重复转换。
- token 失效是否正确。
- 手机和平板是否可用。
- PWA 缓存是否会造成旧版本问题。

## 14. 第一阶段给 Claude Code 的完整指令

```text
你只做 YCPos / FreshStack Order 客户订货系统第 1 步：RLS-first 数据库骨架。

目标：
建立客户订货系统的数据表、RLS、安全 RPC。不要改任何前端文件，不要改现有业务流程。

要求：
1. 新建 supabase_customer_portal_v1.sql。
2. 新增 customer_portal_tokens、customer_order_requests、customer_order_request_items、customer_order_contact_logs。
3. 所有新表必须 ENABLE ROW LEVEL SECURITY。
4. 默认不要给 anon 直接 select/insert/update/delete 表权限。
5. 客户端只能通过 SECURITY DEFINER RPC 操作。
6. token 只保存 hash，不保存明文 token。
7. 客户 RPC 只能返回安全字段：客户名、可下单产品名、单位、客户自己的申请状态；不能返回价格、库存、供应商。
8. 员工 RPC 必须按 app_role() 控制权限：
   - admin/sales 可以看到价格字段和处理状态。
   - purchase/warehouse 可以看产品数量和仓库状态，但不能看到价格。
9. 提交客户申请时只写入 customer_order_requests，不得生成 purchase_orders，不得扣库存。
10. 保留未来转换成正式订单的 ConvertedPOID 字段。
11. 写完后不要执行 SQL，只输出修改文件和说明。
```

## 15. 后续升级方向

测试版跑顺之后，可以考虑：

- WhatsApp OTP 登录。
- 客户账号密码登录。
- 客户联系人管理。
- 客户确认 Sales 修改后的数量。
- 自动 WhatsApp 通知。
- 客户查看历史申请。
- 客户重复上一张订单。
- 客户专属产品列表。
- 客户信用额度。
- AutoCount 单向同步。

