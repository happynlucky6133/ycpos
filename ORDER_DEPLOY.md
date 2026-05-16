# FreshStack Order - 部署到 order.freshstack.cc/yc

## 最终部署架构

```
ycpos.freshstack.cc             -> 内部员工入口 -> GitHub Pages 根目录
order.freshstack.cc/yc          -> 客户订货入口 -> Cloudflare Worker -> GitHub Pages /yc/
```

内部系统和客户系统仍放在同一个 GitHub 仓库，但外部访问由 Cloudflare 分流：

- 员工打开 `https://ycpos.freshstack.cc`
- 客户打开 `https://order.freshstack.cc/yc?token=客户专属链接`
- Cloudflare Worker 只代理 `/yc/` 客户页面，不开放内部 `index.html`

## 文件布局

```
YCPos-PWA/
├── index.html
├── app.js
├── style.css
├── sw.js
├── customer.html
├── customer.js
├── customer.css
├── supabase_customer_portal_v1.sql
└── yc/
    ├── index.html
    ├── customer.js
    └── customer.css
```

`customer.html/js/css` 是开发参考版；正式客户入口使用 `yc/` 目录。

## 部署前必须做

### 1. 执行最新 SQL

在 Supabase SQL Editor 重新执行 `supabase_customer_portal_v1.sql`。

这一步很重要，因为第 5、6 步之后更新过 RPC：

- `get_customer_requests_app()` 增加 Warehouse/Purchase 使用的 `EffectiveQty`
- `get_customer_order_requests()` 让客户在被拒绝时看到拒绝原因

### 2. 创建测试 Token

```sql
INSERT INTO customer_portal_tokens ("CustomerID", token_hash, label)
VALUES (
  '你的CustomerID',
  encode(digest('test-token-2026', 'sha256'), 'hex'),
  '测试 token'
);
```

### 3. 推送 GitHub Pages

先确认 GitHub Pages 实际发布的是最新分支。以前项目出现过 `master` 已更新但线上仍跑旧 `main` 的情况，所以部署前要特别确认。

客户文件上线后，下面这个地址应可直接打开：

```
https://happynlucky6133.github.io/ycpos/yc/?token=test-token-2026
```

如果这个地址还是旧版或 404，先修 GitHub Pages 发布源，不要继续配置 Cloudflare。

## Cloudflare Worker 方案

推荐用 Worker 反向代理，而不是单纯 DNS CNAME。

原因：

- GitHub Pages 一个站点通常只配置一个主要自定义域名。
- `order.freshstack.cc` 直接 CNAME 到 GitHub Pages 可能出现 404、HTTPS 或域名归属问题。
- Worker 可以保留客户看到的域名 `order.freshstack.cc/yc`，同时只暴露客户页面。

### Worker 路由

在 Cloudflare 设置 Worker Route：

```
order.freshstack.cc/yc*
```

### Worker 代码

```js
export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (!url.pathname.startsWith("/yc")) {
      return new Response("Not found", { status: 404 });
    }

    let targetPath = url.pathname.replace(/^\/yc\/?/, "/yc/");
    if (targetPath === "/yc/") {
      targetPath = "/yc/index.html";
    }

    const targetUrl = new URL(
      `https://happynlucky6133.github.io/ycpos${targetPath}${url.search}`
    );

    const response = await fetch(targetUrl.toString(), {
      headers: {
        "User-Agent": "FreshStack-Order-Worker"
      }
    });

    const headers = new Headers(response.headers);
    headers.set("Cache-Control", "no-store");
    headers.delete("content-security-policy");

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers
    });
  }
};
```

### DNS

在 Cloudflare DNS 中确认：

| 名称 | 类型 | 目标 | Proxy |
|------|------|------|-------|
| order | A 或 CNAME | 任意可代理目标 / Worker route 接管 | Proxied |

重点是 `order.freshstack.cc/yc*` 要命中 Worker route。

## 可选：Redirect Rule

Redirect Rule 比 Worker 简单，但客户最终会看到 `ycpos.freshstack.cc/yc` 或 `happynlucky6133.github.io/ycpos/yc`，不再保留 `order.freshstack.cc`。

所以正式测试建议使用 Worker，不建议只用 Redirect。

## 验证清单

| 检查项 | URL |
|--------|-----|
| 内部系统正常 | https://ycpos.freshstack.cc |
| GitHub Pages 客户源正常 | https://happynlucky6133.github.io/ycpos/yc/?token=test-token-2026 |
| Cloudflare 客户入口正常 | https://order.freshstack.cc/yc?token=test-token-2026 |
| 无效 token 提示 | https://order.freshstack.cc/yc?token=bad |
| 客户页面无内部菜单 | https://order.freshstack.cc/yc |
| 客户页面无价格/库存 | 用有效 token 打开并检查产品列表 |
| 手机和平板 | Android 手机和平板浏览器实测 |

## 缓存策略

- Cloudflare Worker：`Cache-Control: no-store`，客户页面先不缓存，方便明天测试。
- Supabase API：永远网络请求，不缓存业务数据。
- 内部 PWA：仍由 `sw.js` 管理缓存。

## 后续维护

- 更新客户页面：修改 `yc/` 目录文件，推送到 GitHub Pages。
- 更新 SQL：在 Supabase SQL Editor 重新执行修改过的函数段或完整 SQL。
- Token 管理：通过 `customer_portal_tokens` 表新增、停用、设置过期时间。
