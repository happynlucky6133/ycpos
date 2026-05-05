/* ===== YCPos 库存系统 v2 - 优化版 ===== */
(function() {
  'use strict';

  // ============================================================
  // 配置
  // ============================================================
  const API = 'https://script.google.com/macros/s/AKfycbxWSPIE4veSauMMFKCje7NS3ms-moX3eMcdCv0mJHIEHLZEXkjWhGFbw-pqmhainy2kIQ/exec';
  const DB_NAME = 'YCPosCache';
  const DB_VERSION = 2;
  const STORE_NAME = 'data';
  const DEBOUNCE_MS = 250;

  // ============================================================
  // 状态管理（使用 Maps 实现 O(1) 查找）
  // ============================================================
  const state = {
    products:    new Map(),
    suppliers:   new Map(),
    customers:   new Map(),
    stockIns:    [],
    stockInDetails: new Map(),
    orders:      [],
    orderDetails: new Map(),
    currentPage: 'dashboard',
    currentModal: null,
    loading:     false
  };

  // 快速查找缓存
  let prodNameCache = new Map();  // ProductID -> name
  let supNameCache = new Map();  // SupplierID -> name
  let custNameCache = new Map(); // CustomerID -> name

  // ============================================================
  // IndexedDB - 离线数据缓存
  // ============================================================
  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function cacheData(data) {
    try {
      const db = await openDB();
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      store.put(data, 'lastData');
      store.put(Date.now(), 'timestamp');
      return new Promise((resolve, reject) => {
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
    } catch (e) {
      console.warn('IndexedDB write failed:', e);
    }
  }

  async function getCachedData() {
    try {
      const db = await openDB();
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const [data, timestamp] = await Promise.all([
        new Promise((r) => { const g = store.get('lastData'); g.onsuccess = () => r(g.result); }),
        new Promise((r) => { const g = store.get('timestamp'); g.onsuccess = () => r(g.result); })
      ]);
      return data ? { data, timestamp } : null;
    } catch (e) {
      console.warn('IndexedDB read failed:', e);
      return null;
    }
  }

  // ============================================================
  // 防抖工具
  // ============================================================
  function debounce(fn, ms) {
    let timer = null;
    return function(...args) {
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(this, args), ms);
    };
  }

  // ============================================================
  // API 调用
  // ============================================================
  async function api(params) {
    const url = API + '?' + new URLSearchParams(params).toString();
    const res = await fetch(url);
    return res.json();
  }

  // ============================================================
  // 数据解析与索引构建
  // ============================================================
  function buildIndexes(data) {
    // 转换为 Maps
    state.products = new Map((data.products || []).map(p => [p.ProductID, p]));
    state.suppliers = new Map((data.suppliers || []).map(s => [s.SupplierID, s]));
    state.customers = new Map((data.customers || []).map(c => [c.CustomerID, c]));
    state.stockIns = data.stockIns || [];
    state.stockInDetails = new Map((data.stockInDetails || []).map(d => [d.StockInID, d]));
    state.orders = data.orders || [];
    state.orderDetails = new Map((data.orderDetails || []).map(d => [d.POID, d]));

    // 构建名称缓存
    prodNameCache = new Map();
    state.products.forEach((p, id) => prodNameCache.set(id, p.ProductName));

    supNameCache = new Map();
    state.suppliers.forEach((s, id) => supNameCache.set(id, s.SupplierName));

    custNameCache = new Map();
    state.customers.forEach((c, id) => custNameCache.set(id, c.CustomerName));
  }

  // ============================================================
  // 数据加载
  // ============================================================
  async function loadAll(showCacheFirst = true) {
    if (state.loading) return;
    state.loading = true;
    const btn = document.getElementById('sync-btn');
    btn.disabled = true;
    btn.textContent = '加载中...';

    try {
      // 先展示缓存数据（如果可用）
      if (showCacheFirst) {
        const cached = await getCachedData();
        if (cached && cached.data) {
          buildIndexes(cached.data);
          renderCurrentPage();
          const t = new Date(cached.timestamp);
          document.getElementById('sync-time').textContent = '缓存数据 ' + t.toTimeString().slice(0,5);
        }
      }

      // 从网络获取最新数据
      const data = await api({ action: 'getAll' });
      if (data.error) throw new Error(data.error);

      buildIndexes(data);
      // 缓存到 IndexedDB（不阻塞渲染）
      cacheData(data);

      populateSelects();
      renderCurrentPage();
      const t = new Date();
      document.getElementById('sync-time').textContent = '已同步 ' + t.toTimeString().slice(0,5);
    } catch (e) {
      // 如果网络失败但已有缓存数据，不显示错误
      const cached = await getCachedData();
      if (!cached || !cached.data) {
        showToast('加载失败: ' + e.message, 'err');
        document.getElementById('sync-time').textContent = '加载失败，请刷新';
      } else {
        showToast('未能获取最新数据，显示缓存版本', 'err');
      }
    }

    btn.disabled = false;
    btn.textContent = '↻ 刷新';
    state.loading = false;
  }

  // ============================================================
  // 选择框填充
  // ============================================================
  function populateSelects() {
    // 供应商下拉
    const supSelect = document.getElementById('f-sup');
    supSelect.innerHTML = Array.from(state.suppliers.values())
      .map(s => `<option value="${s.SupplierID}">${escapeHTML(s.SupplierName)}</option>`).join('');

    // 产品下拉（进货 & 订单共用）
    ['f-prod', 'o-prod'].forEach(id => {
      document.getElementById(id).innerHTML = Array.from(state.products.values())
        .map(p => `<option value="${p.ProductID}">${escapeHTML(p.ProductName)} (${p.Grade})</option>`).join('');
    });

    // 客户下拉
    document.getElementById('o-cust').innerHTML = Array.from(state.customers.values())
      .map(c => `<option value="${c.CustomerID}">${escapeHTML(c.CustomerName)}</option>`).join('');
  }

  // ============================================================
  // 工具函数
  // ============================================================
  function escapeHTML(str) {
    if (!str) return '';
    return String(str).replace(/[&<>"']/g, function(m) {
      return ({ '&': '&', '<': '<', '>': '>', '"': '"', "'": '&#39;' })[m];
    });
  }

  function getProdName(id) { return prodNameCache.get(id) || id; }
  function getSupName(id)  { return supNameCache.get(id) || id; }
  function getCustName(id) { return custNameCache.get(id) || id; }
  function getProd(id)     { return state.products.get(id); }

  function stockBadge(n) {
    n = Number(n);
    if (n > 200) return '<span class="badge bg">充足</span>';
    if (n > 50)  return '<span class="badge ba">偏低</span>';
    return '<span class="badge br">告急</span>';
  }

  // ============================================================
  // Toast 提示
  // ============================================================
  let toastTimer = null;

  function showToast(msg, type) {
    const t = document.getElementById('toast');
    if (!t) return;
    clearTimeout(toastTimer);
    t.textContent = msg;
    t.className = 'toast ' + (type || 'ok');
    t.style.display = 'block';
    t.style.opacity = '1';
    toastTimer = setTimeout(() => {
      t.style.opacity = '0';
      setTimeout(() => t.style.display = 'none', 300);
    }, 3000);
  }

  // ============================================================
  // 页面渲染（使用模板字符串 + innerHTML 由浏览器优化）
  // ============================================================
  function renderCurrentPage() {
    const page = state.currentPage;
    if (page === 'dashboard')   renderDashboard();
    else if (page === 'products')  renderProducts();
    else if (page === 'stockin')   renderStockIn();
    else if (page === 'orders')    renderOrders();
    else if (page === 'customers') renderCustomers();
  }

  function renderDashboard() {
    const total = Array.from(state.products.values())
      .reduce((a, p) => a + Number(p.StockBalance || 0), 0);

    document.getElementById('s-products').textContent = state.products.size;
    document.getElementById('s-stock').innerHTML = total + ' <span class="stat-unit">kg</span>';
    document.getElementById('s-stockin').textContent = state.stockIns.length;
    document.getElementById('s-suppliers').textContent = state.suppliers.size;

    // 产品概览
    const prodContainer = document.getElementById('dash-products');
    if (state.products.size === 0) {
      prodContainer.innerHTML = '<div class="empty">暂无产品</div>';
    } else {
      prodContainer.innerHTML = Array.from(state.products.values()).map(p =>
        `<div class="card row-flex">
          <div>
            <div class="row-title">${escapeHTML(p.ProductName)}</div>
            <div class="row-sub">等级 ${p.Grade} · ${stockBadge(p.StockBalance)}</div>
          </div>
          <div>
            <div class="stock-num">${Number(p.StockBalance || 0)}</div>
            <div class="stock-unit">${p.Unit}</div>
          </div>
        </div>`
      ).join('');
    }

    // 最近进货
    const recentContainer = document.getElementById('dash-recent');
    const recent = state.stockIns.slice(-3).reverse();
    if (recent.length === 0) {
      recentContainer.innerHTML = '<div class="empty">暂无进货记录</div>';
    } else {
      recentContainer.innerHTML = recent.map(s => {
        const d = state.stockInDetails.get(s.StockInID);
        return `<div class="card">
          <div class="row-flex" style="margin-bottom:5px">
            <span class="mono">${s.StockInID}</span>
            <span style="font-size:11px;color:var(--text2)">${String(s.Date).slice(0,10)}</span>
          </div>
          <div style="font-size:13px;color:var(--text)">
            ${d ? escapeHTML(getProdName(d.ProductID)) : '-'} · <strong>${d ? d.Qty : '-'} kg</strong>
          </div>
          <div class="row-sub">${escapeHTML(getSupName(s.SupplierID))}</div>
        </div>`;
      }).join('');
    }
  }

  function renderProducts() {
    const q = (document.getElementById('product-search').value || '').toLowerCase();
    const list = Array.from(state.products.values())
      .filter(p => p.ProductName.toLowerCase().includes(q));

    const container = document.getElementById('product-list');
    if (list.length === 0) {
      container.innerHTML = '<div class="empty">没有找到产品</div>';
      return;
    }

    container.innerHTML = list.map(p =>
      `<div class="card row-flex">
        <div>
          <div class="row-title">${escapeHTML(p.ProductName)}</div>
          <div class="row-sub">${p.ProductID} · 等级 ${p.Grade} · ${stockBadge(p.StockBalance)}</div>
        </div>
        <div>
          <div class="stock-num">${Number(p.StockBalance || 0)}</div>
          <div class="stock-unit">${p.Unit}</div>
        </div>
      </div>`
    ).join('');
  }

  // 防抖搜索版本
  const debouncedRenderProducts = debounce(renderProducts, DEBOUNCE_MS);
  const debouncedRenderCustomers = debounce(renderCustomers, DEBOUNCE_MS);

  function renderStockIn() {
    const container = document.getElementById('stockin-list');
    if (state.stockIns.length === 0) {
      container.innerHTML = '<div class="empty">暂无进货记录</div>';
      return;
    }

    container.innerHTML = [...state.stockIns].reverse().map(s => {
      const d = state.stockInDetails.get(s.StockInID);
      return `<div class="card">
        <div class="row-flex" style="margin-bottom:5px">
          <span class="mono">${s.StockInID}</span>
          <span style="font-size:11px;color:var(--text2)">${String(s.Date).slice(0,10)}</span>
        </div>
        <div style="font-size:13px">
          ${d ? escapeHTML(getProdName(d.ProductID)) : '-'} · <strong>${d ? d.Qty : '-'} kg</strong>
        </div>
        <div class="row-sub">${escapeHTML(getSupName(s.SupplierID))}</div>
      </div>`;
    }).join('');
  }

  const STATUS_LABELS = { pending: '待处理', done: '完成', cancelled: '取消' };
  const STATUS_CHIPS = { pending: 'chip-p', done: 'chip-d', cancelled: 'chip-c' };

  function renderOrders() {
    const container = document.getElementById('orders-list');
    if (state.orders.length === 0) {
      container.innerHTML = '<div class="empty">暂无采购订单</div>';
      return;
    }

    container.innerHTML = [...state.orders].reverse().map(o => {
      const d = state.orderDetails.get(o.POID);
      const st = o.Status || 'pending';
      const label = STATUS_LABELS[st] || st;
      const chipClass = STATUS_CHIPS[st] || 'chip-p';
      const productName = d ? escapeHTML(getProdName(d.ProductID)) : '-';
      const qty = d ? d.QTY : '-';
      const custName = escapeHTML(getCustName(o.CustomerID));
      const date = String(o.Date).slice(0,10);

      let actions = '';
      if (st === 'pending') {
        actions = `<div class="order-actions">
          <button class="order-btn order-btn-done" data-po="${o.POID}" data-status="done" data-pid="${d ? d.ProductID : ''}" data-qty="${d ? d.QTY : 0}">✓ 完成</button>
          <button class="order-btn order-btn-cancel" data-po="${o.POID}" data-status="cancelled">✗ 取消</button>
        </div>`;
      }

      return `<div class="card">
        <div class="row-flex" style="margin-bottom:5px">
          <span class="mono">${o.POID}</span>
          <span class="chip ${chipClass}">${label}</span>
        </div>
        <div style="font-size:13px">${productName} · <strong>${qty} kg</strong></div>
        <div class="row-sub">${custName} · ${date}</div>
        ${actions}
      </div>`;
    }).join('');

    // 事件委托：订单按钮
    container.querySelectorAll('.order-btn').forEach(btn => {
      btn.addEventListener('click', function() {
        const poID = this.dataset.po;
        const status = this.dataset.status;
        const productID = this.dataset.pid || '';
        const qty = this.dataset.qty || '0';
        changeOrderStatus(poID, status, productID, qty);
      });
    });
  }

  function renderCustomers() {
    const q = (document.getElementById('customer-search').value || '').toLowerCase();
    const list = Array.from(state.customers.values())
      .filter(c => (c.CustomerName || '').toLowerCase().includes(q));

    const container = document.getElementById('customer-list');
    if (list.length === 0) {
      container.innerHTML = '<div class="empty">暂无客户</div>';
      return;
    }

    container.innerHTML = list.map(c => {
      let sub = c.CustomerID;
      if (c.Phone) sub += ' · 📞 ' + escapeHTML(c.Phone);
      if (c.Note)  sub += ' · ' + escapeHTML(c.Note);
      return `<div class="card row-flex">
        <div>
          <div class="row-title">${escapeHTML(c.CustomerName)}</div>
          <div class="row-sub">${sub}</div>
        </div>
        <span style="font-size:22px">👤</span>
      </div>`;
    }).join('');
  }

  // ============================================================
  // 页面切换
  // ============================================================
  function switchPage(page, btn) {
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    document.getElementById('page-' + page).classList.add('active');
    if (btn) btn.classList.add('active');
    state.currentPage = page;
    renderCurrentPage();
  }

  // ============================================================
  // Modal 控制
  // ============================================================
  const PAGE_MODAL_MAP = {
    dashboard:  'modal-si',
    stockin:    'modal-si',
    products:   'modal-prod',
    orders:     'modal-order',
    customers:  'modal-customer'
  };

  function openModal() {
    const modalId = PAGE_MODAL_MAP[state.currentPage];
    if (!modalId) return;
    state.currentModal = modalId;
    document.getElementById(modalId).classList.add('open');
  }

  function closeModal() {
    if (state.currentModal) {
      document.getElementById(state.currentModal).classList.remove('open');
      state.currentModal = null;
    }
  }

  // ============================================================
  // 表单提交操作
  // ============================================================
  async function submitStockIn() {
    const qty = parseInt(document.getElementById('f-qty').value);
    if (!qty || qty < 1) { showToast('请输入正确数量', 'err'); return; }

    const btn = document.getElementById('btn-si');
    btn.disabled = true;
    btn.textContent = '提交中...';
    try {
      const res = await api({
        action: 'addStockIn',
        supplierID: document.getElementById('f-sup').value,
        productID: document.getElementById('f-prod').value,
        qty,
        createdBy: 'duzenfruit@gmail.com'
      });
      if (res.error) throw new Error(res.error);
      showToast('进货成功！', 'ok');
      document.getElementById('f-qty').value = '';
      closeModal();
      await loadAll(false);
    } catch (e) {
      showToast('提交失败: ' + e.message, 'err');
    }
    btn.disabled = false;
    btn.textContent = '确认进货';
  }

  async function submitProduct() {
    const name = document.getElementById('np-name').value.trim();
    if (!name) { showToast('请输入产品名称', 'err'); return; }

    const btn = document.getElementById('btn-prod');
    btn.disabled = true;
    btn.textContent = '添加中...';
    try {
      const res = await api({
        action: 'addProduct',
        name,
        grade: document.getElementById('np-grade').value,
        unit: document.getElementById('np-unit').value
      });
      if (res.error) throw new Error(res.error);
      showToast('产品已添加！', 'ok');
      document.getElementById('np-name').value = '';
      closeModal();
      await loadAll(false);
    } catch (e) {
      showToast('提交失败: ' + e.message, 'err');
    }
    btn.disabled = false;
    btn.textContent = '添加产品';
  }

  async function submitCustomer() {
    const name = document.getElementById('nc-name').value.trim();
    if (!name) { showToast('请输入客户名称', 'err'); return; }

    const btn = document.getElementById('btn-customer');
    btn.disabled = true;
    btn.textContent = '添加中...';
    try {
      const res = await api({
        action: 'addCustomer',
        name,
        phone: document.getElementById('nc-phone').value.trim(),
        note: document.getElementById('nc-note').value.trim()
      });
      if (res.error) throw new Error(res.error);
      showToast('客户已添加！', 'ok');
      document.getElementById('nc-name').value = '';
      document.getElementById('nc-phone').value = '';
      document.getElementById('nc-note').value = '';
      closeModal();
      await loadAll(false);
    } catch (e) {
      showToast('提交失败: ' + e.message, 'err');
    }
    btn.disabled = false;
    btn.textContent = '添加客户';
  }

  async function submitOrder() {
    const qty = parseInt(document.getElementById('o-qty').value);
    if (!qty || qty < 1) { showToast('请输入正确数量', 'err'); return; }

    const btn = document.getElementById('btn-order');
    btn.disabled = true;
    btn.textContent = '创建中...';
    try {
      const res = await api({
        action: 'addOrder',
        customerID: document.getElementById('o-cust').value,
        productID: document.getElementById('o-prod').value,
        qty
      });
      if (res.error) throw new Error(res.error);
      showToast('订单已创建！', 'ok');
      document.getElementById('o-qty').value = '';
      closeModal();
      await loadAll(false);
    } catch (e) {
      showToast('提交失败: ' + e.message, 'err');
    }
    btn.disabled = false;
    btn.textContent = '创建订单';
  }

  async function changeOrderStatus(poID, status, productID, qty) {
    try {
      const res = await api({ action: 'updateOrder', poID, status, productID, qty });
      if (res.error) throw new Error(res.error);
      showToast(
        status === 'done' ? '订单已完成 ✓' : '订单已取消',
        status === 'done' ? 'ok' : 'err'
      );
      await loadAll(false);
    } catch (e) {
      showToast('操作失败', 'err');
    }
  }

  // ============================================================
  // 初始化
  // ============================================================
  function init() {
    // 导航按钮事件（使用事件委托）
    document.querySelector('.nav').addEventListener('click', function(e) {
      const btn = e.target.closest('.nav-btn');
      if (!btn) return;
      e.preventDefault();
      const page = btn.dataset.page;
      if (page) switchPage(page, btn);
    });

    // 搜索防抖
    document.getElementById('product-search').addEventListener('input', debouncedRenderProducts);
    document.getElementById('customer-search').addEventListener('input', debouncedRenderCustomers);

    // FAB 按钮
    document.getElementById('fab').addEventListener('click', openModal);

    // 刷新按钮
    document.getElementById('sync-btn').addEventListener('click', () => loadAll(false));

    // Modal 背景点击关闭
    document.querySelectorAll('.modal-bg').forEach(m => {
      m.addEventListener('click', function(e) {
        if (e.target === this) closeModal();
      });
    });

    // Modal 提交按钮
    document.getElementById('btn-si').addEventListener('click', submitStockIn);
    document.getElementById('btn-prod').addEventListener('click', submitProduct);
    document.getElementById('btn-customer').addEventListener('click', submitCustomer);
    document.getElementById('btn-order').addEventListener('click', submitOrder);

    // Modal 取消按钮
    document.querySelectorAll('.btn-cancel').forEach(btn => {
      btn.addEventListener('click', closeModal);
    });

    // Service Worker 注册
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }

    // 启动加载
    loadAll(true);
  }

  // DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
