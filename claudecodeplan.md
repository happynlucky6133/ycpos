# FreshStack Order 按步执行方案

## 执行总览

| 步骤 | 内容 | 关键交付 | 依赖 |
|------|------|----------|------|
| 1 | RLS-first 数据库骨架 | `supabase_customer_portal_v1.sql` | 无 |
| 2 | 客户下单独立页面 | `customer.html/js/css` | 步骤1 |
| 3 | 内部系统查看客户申请 | 修改 `index.html` / `app.js` | 步骤1 |
| 4 | Sales 审核与填价格 | 修改内部页面 + RPC | 步骤3 |
| 5 | Warehouse 查货 | 修改内部页面 + RPC | 步骤4 |
| 6 | 拒绝必须联系客户 | 联系记录 + RPC | 步骤4 |
| 7 | 确认后转正式订单 | 转换 RPC | 步骤5,6 |
| 8 | 部署 order.freshstack.cc/yc | 配置部署 | 步骤2,7 |

---

## 每步执行后的检查清单

每一步完成后逐条验证：

- [ ] 现有 YCPos 功能未被破坏
- [ ] 无绕过 RLS 的路径
- [ ] 客户无法直接访问内部表
- [ ] 客户看不到价格
- [ ] 客户看不到库存
- [ ] Warehouse 看不到价格
- [ ] 无重复提交/重复转换漏洞
- [ ] token 失效/过期正确处理
- [ ] 手机和平板可用
- [ ] PWA 缓存不会导致旧版本问题

---

## 第 1 步完整指令

```
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

完成后列出：
1. 修改文件
2. 新增 SQL
3. 权限设计
4. 测试方式
5. 你没有做的后续阶段
```

---

## 第 2 步完整指令

```
你只做 FreshStack Order 第 2 步：客户下单独立页面。

前提：第 1 步的 supabase_customer_portal_v1.sql 已经完成。

要求：
1. 新建 customer.html、customer.js、customer.css。
2. 从 URL 读取 token 参数（?token=xxx）。
3. 调用 get_customer_portal_context(token) RPC 获取客户信息和可下单产品。
4. 显示客户名称、产品列表（名称 + 单位），不显示价格和库存。
5. 支持多产品同时下单：每行选产品、填数量、填备注。
6. 支持整单备注。
7. 调用 submit_customer_order_request RPC 提交申请。
8. 调用 get_customer_order_requests RPC 显示自己的历史申请和状态。
9. 页面没有任何内部 YCPos 菜单、价格、库存、供应商信息。
10. 适配手机和平板（响应式设计）。
11. token 无效/过期时显示"无权限访问"提示，不暴露任何内部信息。

完成后列出：
1. 修改文件
2. 前端如何调用 RPC
3. 权限边界
4. 测试方式
5. 你没有做的后续阶段
```

---

## 第 3 步完整指令

```
你只做 FreshStack Order 第 3 步：内部系统查看客户申请。

前提：第 1 步 SQL 已执行，第 2 步客户页面已完成。

要求：
1. 在现有 index.html 增加"客户申请"Tab/页面入口。
2. 仅对 staff（已登录员工）可见，客户入口完全不能访问。
3. 调用 get_customer_requests_app() RPC 获取申请列表。
4. 按 app_role() 控制可见字段：
   - Admin/Sales：可见完整申请（含价格字段预留位置，此时数据可能为空）。
   - Warehouse/Purchase：不可见 UnitPrice、LineTotal 价格字段。
5. 支持按日期范围和状态筛选。
6. 不要改动现有采购订单、加工损耗、库存等功能。
7. 保持现有 YCPos 所有功能不变。

完成后列出：
1. 修改了哪些文件
2. 新增了哪些 UI 元素
3. 权限如何实现
4. 测试方式
5. 你没做的后续阶段
```

---

## 第 4 步完整指令

```
你只做 FreshStack Order 第 4 步：Sales 审核与填价格。

前提：第 3 步内部查看页面已完成。

要求：
1. 在内部"客户申请"页面增加 Sales 审核功能。
2. Sales/Admin 可以：
   - 修改每行的 SalesQty（覆盖客户原始 Qty）。
   - 填写 UnitPrice，自动计算 LineTotal = SalesQty × UnitPrice。
   - 填写 SalesNote（整单备注）。
   - 将状态从 submitted 改为 sales_review，再送 warehouse_check。
3. 调用 sales_update_customer_request RPC 保存修改。
4. 状态流：submitted → sales_review → warehouse_check。
5. Warehouse/Purchase 角色不能修改数量和价格。
6. 不在此步骤生成正式订单，不扣库存。

完成后列出：
1. 修改文件
2. 新增/修改的 RPC
3. 权限边界
4. 测试方式
5. 你没做的后续阶段
```

---

## 第 5 步完整指令

```
你只做 FreshStack Order 第 5 步：Warehouse 查货。

前提：第 4 步 Sales 审核已完成。

要求：
1. 在内部"客户申请"页面增加 Warehouse 查货功能。
2. Warehouse/Purchase/Admin 可以：
   - 看到申请的产品、数量（不显示价格）。
   - 标记每行 warehouse_status：有货 / 部分有货 / 无货。
   - 填写 warehouse_note（每行备注）。
   - 填写整单 warehouse_note。
3. 调用 warehouse_update_customer_request RPC 保存查货结果。
4. Warehouse 不能修改 SalesQty、UnitPrice、不能拒绝订单、不能转换订单。
5. Sales/Admin 可以看到仓库查货结果。
6. 状态从 warehouse_check → waiting_customer 或 confirmed。

完成后列出：
1. 修改文件
2. 新增/修改的 RPC
3. 权限边界
4. 测试方式
5. 你没做的后续阶段
```

---

## 第 6 步完整指令

```
你只做 FreshStack Order 第 6 步：拒绝必须联系客户。

前提：第 4 步 Sales 审核已完成。

要求：
1. Sales/Admin 拒绝申请前必须：
   - 填写联系记录（ContactMethod + ContactNote）。
   - 填写拒绝原因（RejectReason）。
2. 新增 sales_contact_customer RPC：
   - 写入 customer_order_contact_logs。
   - 更新 customer_order_requests 的 RejectReason。
   - 状态改为 rejected。
3. 提供 WhatsApp 快捷联系按钮：
   - 格式：https://wa.me/60xxxxxxxxx?text=...
   - 预设文字模板，包含申请编号和客户名。
4. 没有联系记录时拒绝按钮不可用（前端校验 + 后端 RPC 校验）。
5. 联系记录可在申请详情中追踪查看。

完成后列出：
1. 修改文件
2. 新增/修改的 RPC
3. 校验逻辑
4. 测试方式
5. 你没做的后续阶段
```

---

## 第 7 步完整指令

```
你只做 FreshStack Order 第 7 步：确认后转正式订单。

前提：第 5 步 Warehouse 查货和第 6 步拒绝逻辑已完成。

要求：
1. 新增 convert_customer_request_to_order RPC：
   - 仅 Admin/Sales 可调用。
   - 将 customer_order_requests 状态改为 converted。
   - 根据 SalesQty 和 UnitPrice 生成 purchase_orders 记录。
   - 根据每行明细生成 po_details 记录。
   - 保存 ConvertedPOID 到 customer_order_requests。
   - 不在此步骤扣库存（沿用现有 YCPos 负库存机制）。
2. 已转换的申请不可再次转换（检查 status != 'converted'）。
3. converted 后不可再修改客户申请，只能通过正式订单的退货/冲销功能处理。
4. 转换后自动进入现有 YCPos 流程（待处理 → 确认备货 → 确认上车 → 完成）。
5. 保持现有 YCPos 订单处理逻辑不变。

完成后列出：
1. 修改文件
2. 新增的 RPC
3. purchase_orders/po_details 如何生成
4. 防重复转换机制
5. 测试方式
6. 你没做的后续阶段
```

---

## 第 8 步完整指令

```
你只做 FreshStack Order 第 8 步：部署到 order.freshstack.cc/yc。

前提：步骤 1-7 全部完成。

要求：
1. customer.html/js/css 部署到 order.freshstack.cc/yc 路径。
2. 确保 ycpos.freshstack.cc（内部员工入口）和 order.freshstack.cc/yc（客户入口）完全分离。
3. 客户入口不能访问内部 index.html。
4. 检查 Supabase URL 和 anon key 配置正确。
5. 检查 PWA service worker 不会缓存客户页面错误版本。
6. 检查手机和平板浏览器显示正常。
7. 检查 token 链接可正常使用。

完成后列出：
1. 部署配置
2. URL 路由规则
3. PWA 缓存策略
4. 验证清单
```
