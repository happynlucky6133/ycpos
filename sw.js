/* ===== YCPos Service Worker v4 - 子路径兼容版 ===== */
const CACHE = 'ycpos-v10';
const STATIC_ASSETS = [
  '.',
  './index.html',
  './manifest.json',
  './style.css',
  './app.js',
  './icon-192.png',
  './icon-512.png'
];

// ============================================================
// 安装：预缓存静态资源
// ============================================================
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(cache => {
      // 逐一缓存，避免单个失败导致全部失败
      return Promise.allSettled(
        STATIC_ASSETS.map(url =>
          cache.add(url).catch(() => console.warn('SW: 缓存失败', url))
        )
      );
    })
  );
  self.skipWaiting();
});

// ============================================================
// 激活：清理旧缓存
// ============================================================
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => k !== CACHE).map(k => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

// ============================================================
// 请求：缓存优先策略（对 API 请求使用网络优先）
// ============================================================
self.addEventListener('fetch', e => {
  const url = e.request.url;

  // API 请求：GET 才缓存；POST/RPC 不能缓存，否则写入成功也可能被前端当成失败。
  if (url.includes('supabase.co')) {
    e.respondWith(networkFirstWithCacheFallback(e.request));
    return;
  }

  // 静态资源：缓存优先，网络回退
  e.respondWith(
    caches.match(e.request)
      .then(cached => cached || fetchAndCache(e.request))
      .catch(() => caches.match(e.request))
  );
});

// ============================================================
// 网络优先策略（适用于 API）
// ============================================================
async function networkFirstWithCacheFallback(request) {
  try {
    const response = await fetch(request);
    // 只缓存成功的 GET 响应
    if (response.ok && request.method === 'GET') {
      const cache = await caches.open(CACHE);
      cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    const cached = await caches.match(request);
    if (cached) return cached;
    throw err;
  }
}

// ============================================================
// 请求并缓存（适用于静态资源）
// ============================================================
async function fetchAndCache(request) {
  const response = await fetch(request);
  if (response.ok) {
    const cache = await caches.open(CACHE);
    cache.put(request, response.clone());
  }
  return response;
}
