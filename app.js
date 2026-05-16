/* ===== YCPos 库存系统 v4 - 权限版 ===== */
(function() {
  'use strict';

  // ============================================================
  // Supabase 配置
  // ============================================================
  const SUPABASE_URL = 'https://qmgguevkxnheyjlagcoi.supabase.co';
  const SUPABASE_KEY = 'sb_publishable_NbWgnMsQVRHc1l1USwIYhQ_nX_eXOUS';
  const SB = SUPABASE_URL + '/rest/v1';
  const AUTH = SUPABASE_URL + '/auth/v1';

  // ============================================================
  // 状态管理
  // ============================================================
  const state = {
    products:    new Map(),
    suppliers:   new Map(),
    customers:   new Map(),
    stockIns:    [],
    stockInDetails: new Map(),
    processingLogs: [],
    orders:      [],
    orderDetails: new Map(),
    orderDraft: [],
    stockInFilter: { from: '', to: '' },
    orderFilter: { from: '', to: '' },
    crFilter: { from: '', to: '', status: '' },
    customerRequests: [],
    customerRequestItems: [],
    customerRequestsError: false,
    currentPage: 'dashboard',
    currentModal: null,
    loading:     false
  };

  let prodNameCache = new Map();
  let supNameCache = new Map();
  let custNameCache = new Map();

  const GRADE_RULES = {
    banana: {
      label: '香蕉',
      purchase: ['整串', 'A', 'B', 'C'],
      sales: ['A', 'B', 'C'],
      map: { '整串': 'A', A: 'A', B: 'B', C: 'C' }
    },
    papaya: {
      label: '木瓜',
      purchase: ['A', 'B', 'C'],
      sales: ['A', 'B'],
      map: { A: 'A', B: 'B', C: 'B' }
    },
    durian: {
      label: '榴莲',
      purchase: ['AA', 'A', 'AB', 'B', 'BC', 'C', 'CC', 'CCC'],
      sales: ['A', 'B', 'C', 'D'],
      map: { AA: 'A', A: 'A', AB: 'B', B: 'B', BC: 'C', C: 'C', CC: 'D', CCC: 'D' }
    }
  };

  // ============================================================
  // 当前用户
  // ============================================================
  let currentUser = null;
  let authToken = '';

  // 从 localStorage 恢复登录状态
  try {
    authToken = localStorage.getItem('ycpos_auth_token') || '';
    const saved = localStorage.getItem('ycpos_user');
    if (saved) currentUser = JSON.parse(saved);
  } catch(e) {}

  // ============================================================
  // 权限工具
  // ============================================================
  function hasRole(roles) {
    if (!currentUser) return false;
    return roles.includes(currentUser.Role);
  }

  function canSeePrices() {
    return hasRole(['admin', 'sales']);
  }

  function canCreateOrder() {
    return hasRole(['admin', 'sales']);
  }

  function canCompleteOrder() {
    return hasRole(['admin', 'sales']);
  }

  function canCancelOrder() {
    return hasRole(['admin', 'sales']);
  }

  function canPrepareOrder() {
    return hasRole(['admin', 'purchase', 'warehouse']);
  }

  function canShowNav(page) {
    if (!currentUser) return true;
    const role = currentUser.Role;
    if (role === 'admin') return true;
    if (role === 'sales') return !['stockin', 'processing', 'suppliers', 'audit'].includes(page);
    if (role === 'purchase' || role === 'warehouse') return !['customers', 'audit'].includes(page);
    return true;
  }

  function canShowFab(page) {
    if (!currentUser) return false;
    const role = currentUser.Role;
    // 只在有对应 modal 的页面显示 + 号
    const fabPages = ['stockin', 'products', 'orders', 'processing', 'suppliers', 'customers'];
    if (!fabPages.includes(page)) return false;
    if (role === 'admin') return true;
    if (role === 'sales') return ['products', 'customers', 'orders'].includes(page);
    if (role === 'purchase') return ['products', 'suppliers', 'stockin', 'processing'].includes(page);
    return false;
  }

  function canUseModal(modalId) {
    if (!currentUser) return false;
    const role = currentUser.Role;
    if (role === 'admin') return true;
    if (role === 'purchase') return ['modal-prod', 'modal-supplier', 'modal-si', 'modal-processing'].includes(modalId);
    if (role === 'sales') return ['modal-prod', 'modal-customer', 'modal-order'].includes(modalId);
    return false;
  }

function applyPermissions() {
    if (!currentUser) return;

    // 隐藏越权的导航按钮
    document.querySelectorAll('.nav-btn').forEach(btn => {
      const page = btn.dataset.page;
      btn.style.display = canShowNav(page) ? '' : 'none';
    });

    // 审计日志页仅 admin 可见
    const auditNav = document.getElementById('nav-audit');
    if (auditNav) auditNav.style.display = isAdmin() ? '' : 'none';

    // 控制 FAB
    const fab = document.getElementById('fab');
    fab.style.display = canShowFab(state.currentPage) ? 'flex' : 'none';

    // 用户显示
    const ud = document.getElementById('user-display');
    ud.textContent = '👤 ' + currentUser.DisplayName + ' (退出)';
    ud.style.display = 'inline';

    // admin 专用按钮（👤+ 添加用户）
    const adminActions = document.getElementById('admin-actions');
    adminActions.style.display = 'inline';
    document.getElementById('btn-add-user').style.display = isAdmin() ? 'inline' : 'none';
  }

  // ============================================================
  // Supabase API
  // ============================================================
  function sbHeaders(extra = {}) {
    return Object.assign({
      'apikey': SUPABASE_KEY,
      'Authorization': 'Bearer ' + (authToken || SUPABASE_KEY)
    }, extra);
  }

  function handleApiError(text) {
    if (String(text || '').includes('JWT expired')) {
      showToast('登录已过期，请重新登录', 'err');
      doLogout();
      return new Error('登录已过期，请重新登录');
    }
    return new Error(text);
  }

  async function sbGet(table, opts = {}) {
    const params = new URLSearchParams();
    if (opts.select) params.set('select', opts.select);
    if (opts.order)  params.set('order', opts.order);
    const url = SB + '/' + table + '?' + params.toString();
    const res = await fetch(url, {
      headers: sbHeaders()
    });
    if (!res.ok) throw handleApiError(await res.text());
    return res.json();
  }

  async function sbGetOptional(table, opts = {}) {
    try {
      return await sbGet(table, opts);
    } catch (e) {
      console.warn('Optional table unavailable:', table, e.message);
      return [];
    }
  }

  async function sbPost(table, data) {
    const url = SB + '/' + table;
    const res = await fetch(url, {
      method: 'POST',
      headers: sbHeaders({ 'Content-Type': 'application/json', 'Prefer': 'return=representation' }),
      body: JSON.stringify(data)
    });
    if (!res.ok) throw handleApiError('HTTP ' + res.status + ': ' + await res.text());
    try { return await res.json(); } catch { return { success: true }; }
  }

  async function sbPatch(table, idCol, idVal, data) {
    const url = SB + '/' + table + '?' + idCol + '=eq.' + encodeURIComponent(idVal);
    const res = await fetch(url, {
      method: 'PATCH',
      headers: sbHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(data)
    });
    if (!res.ok) throw handleApiError(await res.text());
    return true;
  }

  async function sbGetFiltered(table, col, val, opts = {}) {
    const params = new URLSearchParams();
    params.set(col, 'eq.' + encodeURIComponent(val));
    if (opts.select) params.set('select', opts.select);
    const url = SB + '/' + table + '?' + params.toString();
    const res = await fetch(url, {
      headers: sbHeaders()
    });
    if (!res.ok) throw handleApiError(await res.text());
    return res.json();
  }

  async function sbDelete(table, idCol, idVal) {
    const url = SB + '/' + table + '?' + idCol + '=eq.' + encodeURIComponent(idVal);
    const res = await fetch(url, {
      method: 'DELETE',
      headers: sbHeaders()
    });
    if (!res.ok) throw handleApiError(await res.text());
    return true;
  }

  async function sbRpc(fnName, data) {
    const res = await fetch(SB + '/rpc/' + fnName, {
      method: 'POST',
      headers: sbHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(data || {})
    });
    if (!res.ok) throw handleApiError(await res.text());
    const text = await res.text();
    if (!text) return null;
    try { return JSON.parse(text); } catch { return text; }
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async function createStaffProfileWithRetry(profile) {
    let lastError = null;
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        return await sbRpc('create_staff_profile', profile);
      } catch (e) {
        lastError = e;
        const msg = getErrorMessage(e);
        if (!msg.includes('Auth user not found')) throw e;
        await sleep(700 + attempt * 500);
      }
    }
    throw lastError || new Error('Auth user not found');
  }

  async function loadOrdersForCurrentRole() {
    try {
      const bundle = await sbRpc('get_orders_app', {});
      if (bundle && Array.isArray(bundle.orders) && Array.isArray(bundle.details)) {
        return { orders: bundle.orders, orderDetails: bundle.details };
      }
    } catch (e) {
      console.warn('Order RPC unavailable, falling back to direct tables:', e.message);
    }
    const [orders, orderDetails] = await Promise.all([
      sbGetOptional('purchase_orders', { order: 'id' }),
      sbGetOptional('po_details', { order: 'id' })
    ]);
    return { orders, orderDetails };
  }

  async function loadCustomerRequests() {
    try {
      const bundle = await sbRpc('get_customer_requests_app', {});
      if (bundle && Array.isArray(bundle.requests) && Array.isArray(bundle.items)) {
        state.customerRequests = bundle.requests;
        state.customerRequestItems = bundle.items;
        state.customerRequestsError = false;
        return;
      }
      throw new Error('Invalid response format');
    } catch (e) {
      console.warn('Customer requests RPC failed:', e.message);
      state.customerRequests = [];
      state.customerRequestItems = [];
      state.customerRequestsError = true;
    }
  }

  // ============================================================
  // 登录 / 登出
  // ============================================================
  async function doLogin() {
    const email = document.getElementById('login-user').value.trim();
    const password = document.getElementById('login-pass').value.trim();
    const errEl = document.getElementById('login-error');
    if (!email || !password) {
      errEl.textContent = '请输入 Email 和密码';
      errEl.style.display = 'block';
      return;
    }
    errEl.style.display = 'none';

    const btn = document.getElementById('login-btn');
    btn.disabled = true;
    btn.textContent = '登录中...';
    try {
      const loginRes = await fetch(AUTH + '/token?grant_type=password', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': SUPABASE_KEY
        },
        body: JSON.stringify({ email, password })
      });
      if (!loginRes.ok) {
        const loginText = await loginRes.text();
        const loginMsg = getErrorMessage(new Error(loginText));
        if (loginMsg.includes('Email not confirmed')) {
          throw new Error('Email 还未确认。请在 Supabase Auth 关闭 Confirm email，或先确认这个邮箱。');
        }
        throw new Error(loginMsg || 'Email 或密码错误');
      }
      const session = await loginRes.json();
      authToken = session.access_token;
      localStorage.setItem('ycpos_auth_token', authToken);

      const profiles = await sbGetFiltered('staff_profiles', 'id', session.user.id, { select: '*' });
      if (!profiles || profiles.length === 0 || profiles[0].Active === false) {
        throw new Error('这个账号还没有员工权限');
      }
      const profile = profiles[0];

      currentUser = {
        Username: email,
        DisplayName: profile.DisplayName || email,
        Role: profile.Role
      };
      localStorage.setItem('ycpos_user', JSON.stringify(currentUser));

      // 隐藏登录页，显示主应用
      document.getElementById('page-login').classList.remove('active');
      document.getElementById('app-main').style.display = 'flex';

      applyPermissions();
      showToast('欢迎，' + currentUser.DisplayName + '！', 'ok');
      loadAll();
    } catch (e) {
      errEl.textContent = '登录失败: ' + e.message;
      errEl.style.display = 'block';
    }
    btn.disabled = false;
    btn.textContent = '登录';
  }

  function doLogout() {
    currentUser = null;
    authToken = '';
    localStorage.removeItem('ycpos_user');
    localStorage.removeItem('ycpos_auth_token');
    document.getElementById('app-main').style.display = 'none';
    document.getElementById('page-login').classList.add('active');
    document.getElementById('login-pass').value = '';
    document.getElementById('login-error').style.display = 'none';
    // 重置页面
    document.querySelectorAll('.nav-btn').forEach(b => b.style.display = '');
    document.getElementById('fab').style.display = 'none';
    document.getElementById('user-display').style.display = 'none';
    showToast('已退出登录', 'ok');
  }

  // ============================================================
  // 数据加载
  // ============================================================
  async function loadAll() {
    if (state.loading) return;
    state.loading = true;
    const btn = document.getElementById('sync-btn');
    btn.disabled = true;
    btn.textContent = '加载中...';

    try {
      const [products, suppliers, customers, stockIns, stockInDetails, processingLogs, orderBundle] = await Promise.all([
        sbGet('products', { order: 'id' }),
        sbGetOptional('suppliers', { order: 'id' }),
        sbGetOptional('customers', { order: 'id' }),
        sbGetOptional('stock_ins', { order: 'id' }),
        sbGetOptional('stock_in_details', { order: 'id' }),
        sbGetOptional('processing_logs', { order: 'id' }),
        loadOrdersForCurrentRole(),
        loadCustomerRequests()
      ]);

      const orders = orderBundle.orders || [];
      const orderDetails = orderBundle.orderDetails || [];
      buildIndexes({ products, suppliers, customers, stockIns, stockInDetails, processingLogs, orders, orderDetails });
      populateSelects();
      renderCurrentPage();

      const t = new Date();
      document.getElementById('sync-time').textContent = '已同步 ' + t.toTimeString().slice(0,5);
    } catch (e) {
      showToast('加载失败: ' + e.message, 'err');
      document.getElementById('sync-time').textContent = '加载失败';
    }

    btn.disabled = false;
    btn.textContent = '↻ 刷新';
    state.loading = false;
  }

  // ============================================================
  // 数据解析
  // ============================================================
  function buildIndexes(data) {
    state.products = new Map((data.products || []).map(p => [p.ProductID, p]));
    state.suppliers = new Map((data.suppliers || []).map(s => [s.SupplierID, s]));
    state.customers = new Map((data.customers || []).map(c => [c.CustomerID, c]));
    state.stockIns = data.stockIns || [];
    state.stockInDetails = new Map((data.stockInDetails || []).map(d => [d.StockInID, d]));
    state.processingLogs = data.processingLogs || [];
    state.orders = data.orders || [];
    state.orderDetails = new Map();
    (data.orderDetails || []).forEach(d => {
      if (!state.orderDetails.has(d.POID)) state.orderDetails.set(d.POID, []);
      state.orderDetails.get(d.POID).push(d);
    });

    prodNameCache = new Map();
    state.products.forEach((p, id) => prodNameCache.set(id, p.ProductName));
    supNameCache = new Map();
    state.suppliers.forEach((s, id) => supNameCache.set(id, s.SupplierName));
    custNameCache = new Map();
    state.customers.forEach((c, id) => custNameCache.set(id, c.CustomerName));
  }

  // ============================================================
  // 选择框填充
  // ============================================================
  function populateSelects() {
    const sup = document.getElementById('f-sup');
    if (sup) sup.innerHTML = Array.from(state.suppliers.values())
      .map(s => `<option value="${escapeHTML(s.SupplierID)}">${escapeHTML(s.SupplierName)}</option>`).join('');

    ['f-prod', 'o-prod'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.innerHTML = Array.from(state.products.values())
        .map(p => `<option value="${escapeHTML(p.ProductID)}">${escapeHTML(p.ProductName)} (${escapeHTML(p.Grade || '')})</option>`).join('');
    });

    ['pr-source', 'pr-target'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.innerHTML = Array.from(state.products.values())
        .map(p => `<option value="${escapeHTML(p.ProductID)}">${escapeHTML(formatProductLabel(p))}</option>`).join('');
    });

    const cust = document.getElementById('o-cust');
    if (cust) cust.innerHTML = Array.from(state.customers.values())
      .map(c => `<option value="${escapeHTML(c.CustomerID)}">${escapeHTML(c.CustomerName)}</option>`).join('');

    // 初始化数量单位标签
    updateQtyLabels();
  }

  // ============================================================
  // 工具函数
  // ============================================================
  function escapeHTML(str) {
    if (!str) return '';
    return String(str).replace(/[&<>"']/g, m => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[m]);
  }

  function getProdName(id) { return prodNameCache.get(id) || id; }
  function getSupName(id)  { return supNameCache.get(id) || id; }
  function getCustName(id) { return custNameCache.get(id) || id; }
  function getProd(id)     { return state.products.get(id); }
  function getProdUnit(id) {
    const p = state.products.get(id);
    return p ? (p.Unit || 'kg') : 'kg';
  }

  function formatProductLabel(p) {
    if (!p) return '';
    return p.ProductName + (p.Grade ? ' ' + p.Grade : '') + ' · ' + Number(p.StockBalance || 0) + ' ' + (p.Unit || 'kg');
  }

  function formatProductNameGrade(p) {
    if (!p) return '';
    return p.ProductName + (p.Grade ? ' ' + p.Grade : '');
  }

  function normalizeFruitName(name) {
    const text = String(name || '').toLowerCase();
    if (text.includes('banana') || text.includes('蕉')) return 'banana';
    if (text.includes('papaya') || text.includes('木瓜')) return 'papaya';
    if (text.includes('durian') || text.includes('榴莲') || text.includes('榴槤')) return 'durian';
    return '';
  }

  function getGradeRuleForProduct(product) {
    return GRADE_RULES[normalizeFruitName(product && product.ProductName)] || null;
  }

  function getMappedSalesGrade(product) {
    const rule = getGradeRuleForProduct(product);
    if (!rule) return '';
    return rule.map[product.Grade] || '';
  }

  function fmtNum(n) {
    const v = Number(n || 0);
    return Number.isInteger(v) ? String(v) : v.toFixed(2).replace(/\.?0+$/, '');
  }

  function fmtMoney(n) {
    return 'RM ' + Number(n || 0).toFixed(2);
  }

  function getDateText(value) {
    return String(value || '').slice(0, 10);
  }

  function inDateRange(dateValue, filter) {
    const date = getDateText(dateValue);
    if (!date) return false;
    if (filter.from && date < filter.from) return false;
    if (filter.to && date > filter.to) return false;
    return true;
  }

  function sumOrderTotal(order, lines) {
    return Number(order.TotalAmount || (lines || []).reduce((sum, d) => {
      const qty = Number(d.QTY || 0);
      const price = Number(d.UnitPrice || 0);
      return sum + qty * price;
    }, 0));
  }

  function getOrderCustomerName(order) {
    return order.CustomerName || getCustName(order.CustomerID);
  }

  function stockBadge(n) {
    n = Number(n);
    if (n > 200) return '<span class="badge bg">充足</span>';
    if (n > 50)  return '<span class="badge ba">偏低</span>';
    return '<span class="badge br">告急</span>';
  }

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

  function getErrorMessage(e) {
    let msg = e && e.message ? e.message : String(e || '未知错误');
    try {
      const parsed = JSON.parse(msg);
      msg = parsed.message || parsed.details || msg;
    } catch (_) {}
    return msg;
  }

  // 审计日志
  async function auditLog(action, target, detail) {
    try {
      await sbRpc('write_audit', {
        p_action: action,
        p_target: target || '',
        p_detail: detail || ''
      });
    } catch (e) { /* 审计日志记录失败不打断主流程 */ }
  }

  async function loadAuditLogs() {
    const container = document.getElementById('audit-list');
    try {
      const logs = await sbGet('audit_logs', { order: 'id.desc' });
      renderAuditLog(logs, container);
    } catch (e) {
      container.innerHTML = '<div class="empty">加载失败: ' + escapeHTML(e.message) + '</div>';
    }
  }

  function renderAuditLog(logs, container) {
    if (!logs || logs.length === 0) {
      container.innerHTML = '<div class="empty">暂无审计记录</div>';
      return;
    }
    container.innerHTML = logs.map(l => {
      const ts = String(l.Timestamp || '').slice(0, 16).replace('T', ' ');
      return `<div class="card audit-row">
        <div class="row-flex">
          <span class="mono" style="font-size:11px;color:var(--text2)">${escapeHTML(ts)}</span>
          <span class="chip" style="background:var(--blue-light);color:var(--blue);font-size:11px">${escapeHTML(l.Action)}</span>
        </div>
        <div style="font-size:13px;margin-top:4px">
          <strong>${escapeHTML(l.User)}</strong>
          ${l.Target ? ' · ' + escapeHTML(l.Target) : ''}
        </div>
        ${l.Detail ? '<div class="row-sub">' + escapeHTML(l.Detail) + '</div>' : ''}
      </div>`;
    }).join('');
  }

  // 根据所选产品动态更新数量单位的标签
  function updateQtyLabels() {
    const fProd = document.getElementById('f-prod');
    const oProd = document.getElementById('o-prod');
    const fLabel = document.getElementById('f-qty-label');
    const oLabel = document.getElementById('o-qty-label');
    if (fProd && fLabel) {
      const unit = getProdUnit(fProd.value);
      fLabel.textContent = '数量 (' + unit + ')';
    }
    if (oProd && oLabel) {
      const unit = getProdUnit(oProd.value);
      oLabel.textContent = '数量 (' + unit + ')';
    }
  }

  function debounce(fn, ms) {
    let timer = null;
    return function(...args) {
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(this, args), ms);
    };
  }

  // ============================================================
  // 页面渲染
  // ============================================================
  function renderCurrentPage() {
    const page = state.currentPage;
    if (page === 'dashboard')   renderDashboard();
    else if (page === 'products')  renderProducts();
    else if (page === 'stockin')   renderStockIn();
    else if (page === 'orders')    renderOrders();
    else if (page === 'processing') renderProcessing();
    else if (page === 'suppliers') renderSuppliers();
    else if (page === 'customers') renderCustomers();
    else if (page === 'customer-requests') renderCustomerRequests();
    else if (page === 'audit')     loadAuditLogs();
  }

  function renderDashboard() {
    const stockByUnit = Array.from(state.products.values()).reduce((acc, p) => {
      const unit = p.Unit || 'kg';
      acc[unit] = (acc[unit] || 0) + Number(p.StockBalance || 0);
      return acc;
    }, {});
    const stockText = Object.entries(stockByUnit)
      .map(([unit, qty]) => `${fmtNum(qty)} <span class="stat-unit">${escapeHTML(unit)}</span>`)
      .join('<br>') || '-';

    document.getElementById('s-products').textContent = state.products.size;
    document.getElementById('s-stock').innerHTML = stockText;
    document.getElementById('s-stockin').textContent = state.stockIns.length;
    document.getElementById('s-suppliers').textContent = state.suppliers.size;

    const prodContainer = document.getElementById('dash-products');
    if (state.products.size === 0) {
      prodContainer.innerHTML = '<div class="empty">暂无产品</div>';
    } else {
      prodContainer.innerHTML = Array.from(state.products.values()).map(p =>
        `<div class="card row-flex">
          <div>
            <div class="row-title">${escapeHTML(p.ProductName)}</div>
            <div class="row-sub">等级 ${escapeHTML(p.Grade || '-')} · ${stockBadge(p.StockBalance)}${p.Note ? ' · ' + escapeHTML(p.Note) : ''}</div>
          </div>
          <div>
            <div class="stock-num">${Number(p.StockBalance || 0)}</div>
            <div class="stock-unit">${p.Unit || 'kg'}</div>
          </div>
        </div>`
      ).join('');
    }

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
          <div style="font-size:13px">
            ${d ? escapeHTML(getProdName(d.ProductID)) : '-'} · <strong>${d ? d.Qty + ' ' + getProdUnit(d.ProductID) : '-'}</strong>
          </div>
          <div class="row-sub">${escapeHTML(getSupName(s.SupplierID))}${s.Note ? ' · ' + escapeHTML(s.Note) : ''}</div>
        </div>`;
      }).join('');
    }
  }

  const isAdmin = () => currentUser && currentUser.Role === 'admin';

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
          <div class="row-sub">${escapeHTML(p.ProductID)} · 等级 ${escapeHTML(p.Grade || '-')} · ${stockBadge(p.StockBalance)}${p.Note ? ' · ' + escapeHTML(p.Note) : ''}</div>
        </div>
        <div style="display:flex;align-items:center;gap:8px">
          <div style="text-align:right">
            <div class="stock-num">${Number(p.StockBalance || 0)}</div>
            <div class="stock-unit">${p.Unit || 'kg'}</div>
          </div>
          ${isAdmin() ? `<button class="del-btn" data-type="product" data-id="${p.ProductID}">✕</button>` : ''}
        </div>
      </div>`
    ).join('');
    attachDeleteHandlers(container);
  }

  function renderSuppliers() {
    const q = (document.getElementById('supplier-search').value || '').toLowerCase();
    const list = Array.from(state.suppliers.values())
      .filter(s => (s.SupplierName || '').toLowerCase().includes(q));
    const container = document.getElementById('supplier-list');
    if (list.length === 0) {
      container.innerHTML = '<div class="empty">暂无供应商</div>';
      return;
    }
    container.innerHTML = list.map(s => {
      let sub = s.SupplierID;
      if (s.Phone) sub += ' · 📞 ' + escapeHTML(s.Phone);
      if (s.Note)  sub += ' · ' + escapeHTML(s.Note);
      return `<div class="card row-flex">
        <div>
          <div class="row-title">${escapeHTML(s.SupplierName)}</div>
          <div class="row-sub">${sub}</div>
        </div>
        <div style="display:flex;align-items:center;gap:8px">
          <span style="font-size:22px">🏭</span>
          ${isAdmin() ? `<button class="del-btn" data-type="supplier" data-id="${s.SupplierID}">✕</button>` : ''}
        </div>
      </div>`;
    }).join('');
    attachDeleteHandlers(container);
  }

  function renderStockIn() {
    const container = document.getElementById('stockin-list');
    const list = state.stockIns.filter(s => inDateRange(s.Date, state.stockInFilter));
    if (list.length === 0) {
      container.innerHTML = '<div class="empty">暂无进货记录</div>';
      return;
    }
    container.innerHTML = [...list].reverse().map(s => {
      const d = state.stockInDetails.get(s.StockInID);
      return `<div class="card">
        <div class="row-flex" style="margin-bottom:5px">
          <span class="mono">${s.StockInID}</span>
          <div style="display:flex;align-items:center;gap:6px">
            <span style="font-size:11px;color:var(--text2)">${String(s.Date).slice(0,10)}</span>
            ${isAdmin() ? `<button class="del-btn sm" data-type="stockin" data-id="${s.StockInID}">✕</button>` : ''}
          </div>
        </div>
        <div style="font-size:13px">
          ${d ? escapeHTML(getProdName(d.ProductID)) : '-'} · <strong>${d ? d.Qty + ' ' + getProdUnit(d.ProductID) : '-'}</strong>
        </div>
        <div class="row-sub">${escapeHTML(getSupName(s.SupplierID))}</div>
        ${s.Note ? '<div class="row-sub">' + escapeHTML(s.Note) + '</div>' : ''}
        <div class="print-actions"><button class="print-btn" data-print-stockin="${s.StockInID}">打印进货证明</button></div>
      </div>`;
    }).join('');
    attachDeleteHandlers(container);
    container.querySelectorAll('[data-print-stockin]').forEach(btn => {
      btn.addEventListener('click', () => printStockIn(btn.dataset.printStockin));
    });
  }

  function renderProcessing() {
    renderGradeRules();
    renderLossSummary();
    renderProcessingLogs();
  }

  function renderGradeRules() {
    const container = document.getElementById('grade-rule-list');
    if (!container) return;
    container.innerHTML = Object.values(GRADE_RULES).map(rule => {
      const pairs = Object.entries(rule.map)
        .map(([from, to]) => `<span class="grade-pill">${escapeHTML(from)} → ${escapeHTML(to)}</span>`)
        .join('');
      return `<div class="card">
        <div class="row-flex" style="align-items:flex-start;gap:10px">
          <div>
            <div class="row-title">${escapeHTML(rule.label)}</div>
            <div class="row-sub">收货：${rule.purchase.map(escapeHTML).join(' / ')}</div>
            <div class="row-sub">出货：${rule.sales.map(escapeHTML).join(' / ')}</div>
          </div>
          <span class="chip chip-d">等级转换</span>
        </div>
        <div class="grade-map">${pairs}</div>
      </div>`;
    }).join('');
  }

  function renderLossSummary() {
    const container = document.getElementById('loss-summary');
    if (!container) return;
    if (!state.processingLogs.length) {
      container.innerHTML = '<div class="empty">暂无损耗记录</div>';
      return;
    }

    const totals = state.processingLogs.reduce((acc, log) => {
      acc.input += Number(log.InputQty || 0);
      acc.output += Number(log.OutputQty || 0);
      acc.stem += Number(log.StemLoss || 0);
      acc.other += Number(log.OtherLoss || 0);
      return acc;
    }, { input: 0, output: 0, stem: 0, other: 0 });
    const totalLoss = totals.stem + totals.other;
    const lossRate = totals.input ? (totalLoss / totals.input * 100) : 0;

    container.innerHTML = `<div class="mini-stat-grid">
      <div class="mini-stat"><div class="stat-label">加工总量</div><div class="stat-value">${fmtNum(totals.input)}</div></div>
      <div class="mini-stat"><div class="stat-label">可售产出</div><div class="stat-value">${fmtNum(totals.output)}</div></div>
      <div class="mini-stat"><div class="stat-label">总损耗</div><div class="stat-value">${fmtNum(totalLoss)}</div></div>
      <div class="mini-stat"><div class="stat-label">损耗率</div><div class="stat-value">${lossRate.toFixed(1)}%</div></div>
    </div>`;
  }

  function renderProcessingLogs() {
    const container = document.getElementById('processing-list');
    if (!container) return;
    if (!state.processingLogs.length) {
      container.innerHTML = '<div class="empty">暂无加工记录</div>';
      return;
    }
    container.innerHTML = [...state.processingLogs].reverse().map(log => {
      const source = getProd(log.SourceProductID);
      const target = getProd(log.TargetProductID);
      const input = Number(log.InputQty || 0);
      const stem = Number(log.StemLoss || 0);
      const other = Number(log.OtherLoss || 0);
      const lossRate = input ? ((stem + other) / input * 100) : 0;
      return `<div class="card">
        <div class="row-flex" style="margin-bottom:5px">
          <span class="mono">${escapeHTML(log.ProcessID)}</span>
          <span style="font-size:11px;color:var(--text2)">${String(log.Date || '').slice(0,10)}</span>
        </div>
        <div style="font-size:13px">${escapeHTML(formatProductNameGrade(source))} → <strong>${escapeHTML(formatProductNameGrade(target))}</strong></div>
        <div class="row-sub">加工 ${fmtNum(input)} · 产出 ${fmtNum(log.OutputQty)} · 损耗 ${fmtNum(stem + other)} · 损耗率 ${lossRate.toFixed(1)}%</div>
      </div>`;
    }).join('');
  }

  const STATUS_LABELS = { pending: '待处理', ready: '已备货', loaded: '已上车', done: '完成', cancelled: '取消' };
  const STATUS_CHIPS = { pending: 'chip-p', ready: 'chip-p', loaded: 'chip-d', done: 'chip-d', cancelled: 'chip-c' };
  const STATUS_LABELS_CR = {
    submitted: '已提交', sales_review: 'Sales 审核中', warehouse_check: '仓库查货中',
    waiting_customer: '等待客户回复', confirmed: '已确认', converted: '已转正式订单',
    rejected: '已拒绝', cancelled: '已取消'
  };

  function renderOrders() {
    const container = document.getElementById('orders-list');
    const orders = state.orders.filter(o => inDateRange(o.Date, state.orderFilter));
    renderOrderSummary(orders);
    if (orders.length === 0) {
      container.innerHTML = '<div class="empty">暂无订单</div>';
      return;
    }

    container.innerHTML = [...orders].reverse().map(o => {
      const lines = state.orderDetails.get(o.POID) || [];
      const st = o.Status || 'pending';
      const label = STATUS_LABELS[st] || st;
      const chipClass = STATUS_CHIPS[st] || 'chip-p';
      const custName = escapeHTML(getOrderCustomerName(o));
      const date = String(o.Date).slice(0,10);
      const total = sumOrderTotal(o, lines);
      const lineHtml = lines.length ? lines.map(d => {
        const qty = Number(d.QTY || 0);
        const price = Number(d.UnitPrice || 0);
        const lineTotal = Number(d.LineTotal || qty * price);
        const priceText = canSeePrices()
          ? ` x ${fmtMoney(price)}${lineTotal ? ' = ' + fmtMoney(lineTotal) : ''}`
          : '';
        return `<div class="order-line-row">
          <div>
            <div class="order-line-title">${escapeHTML(getProdName(d.ProductID))}</div>
            <div class="order-line-sub">${fmtNum(qty)} ${escapeHTML(getProdUnit(d.ProductID))}${priceText}</div>
          </div>
          ${canSeePrices() ? `<strong>${fmtMoney(lineTotal)}</strong>` : ''}
        </div>`;
      }).join('') : '<div class="empty small">没有产品明细</div>';

      const actionButtons = [];
      if (st === 'pending' && canPrepareOrder()) actionButtons.push(`<button class="order-btn order-btn-done" data-po="${o.POID}" data-status="ready">✓ 确认备货</button>`);
      if (st === 'ready' && canPrepareOrder()) actionButtons.push(`<button class="order-btn order-btn-done" data-po="${o.POID}" data-status="loaded">✓ 确认上车</button>`);
      if (st === 'loaded' && canCompleteOrder()) actionButtons.push(`<button class="order-btn order-btn-done" data-po="${o.POID}" data-status="done">✓ 完成</button>`);
      if (['pending', 'ready', 'loaded'].includes(st) && canCancelOrder()) actionButtons.push(`<button class="order-btn order-btn-cancel" data-po="${o.POID}" data-status="cancelled">✗ 取消</button>`);
      const actions = actionButtons.length ? `<div class="order-actions">${actionButtons.join('')}</div>` : '';

      return `<div class="card">
        <div class="row-flex" style="margin-bottom:5px">
      <span class="mono">${o.POID}</span>
          <div style="display:flex;align-items:center;gap:6px">
            <span class="chip ${chipClass}">${label}</span>
            ${isAdmin() ? `<button class="del-btn sm" data-type="order" data-id="${o.POID}">✕</button>` : ''}
          </div>
        </div>
        ${lineHtml}
        ${canSeePrices() ? `<div style="font-size:13px;text-align:right;margin-top:6px"><strong>${fmtMoney(total)}</strong></div>` : ''}
        <div class="row-sub">${custName} · ${date}</div>
        ${o.Note ? '<div class="row-sub">' + escapeHTML(o.Note) + '</div>' : ''}
        <div class="print-actions"><button class="print-btn" data-print-order="${o.POID}">打印备货单</button></div>
        ${actions}
      </div>`;
    }).join('');

    container.querySelectorAll('[data-print-order]').forEach(btn => {
      btn.addEventListener('click', () => printOrder(btn.dataset.printOrder));
    });
    container.querySelectorAll('.order-btn').forEach(btn => {
      btn.addEventListener('click', function() {
        changeOrderStatus(this.dataset.po, this.dataset.status);
      });
    });
  }

  function renderCustomerRequests() {
    const container = document.getElementById('cr-requests-list');
    if (!container) return;

    const seePrice = canSeePrices();
    const CR_STATUS_LABELS = {
      submitted:         '已提交',
      sales_review:      'Sales 审核中',
      warehouse_check:   '仓库查货中',
      waiting_customer:  '等待客户回复',
      confirmed:         '已确认',
      converted:         '已转正式订单',
      rejected:          '已拒绝',
      cancelled:         '已取消'
    };
    const CR_STATUS_CHIPS = {
      submitted:         'chip-p',
      sales_review:      'chip-p',
      warehouse_check:   'chip-p',
      waiting_customer:  'chip-d',
      confirmed:         'chip-d',
      converted:         'chip-d',
      rejected:          'chip-c',
      cancelled:         'chip-c'
    };

    if (state.customerRequestsError) {
      container.innerHTML = '<div class="empty" style="color:var(--danger)">客户申请加载失败，请刷新或联系 Admin</div>';
      return;
    }

    let requests = state.customerRequests || [];
    // 日期筛选：基于 SubmittedAt
    if (state.crFilter.from) {
      requests = requests.filter(function (r) {
        var d = String(r.SubmittedAt || '').slice(0, 10);
        return d >= state.crFilter.from;
      });
    }
    if (state.crFilter.to) {
      requests = requests.filter(function (r) {
        var d = String(r.SubmittedAt || '').slice(0, 10);
        return d <= state.crFilter.to;
      });
    }
    // 状态筛选
    if (state.crFilter.status) {
      requests = requests.filter(function (r) {
        return r.Status === state.crFilter.status;
      });
    }

    if (requests.length === 0) {
      container.innerHTML = '<div class="empty">暂无客户申请</div>';
      return;
    }

    container.innerHTML = requests.map(function (r) {
      var items = (state.customerRequestItems || []).filter(function (i) {
        return i.RequestID === r.RequestID;
      });

      var st = r.Status || 'submitted';
      var label = CR_STATUS_LABELS[st] || st;
      var chipClass = CR_STATUS_CHIPS[st] || 'chip-p';
      var custName = escapeHTML(r.CustomerName || r.CustomerID || '');
      var date = String(r.SubmittedAt || '').slice(0, 10);

      var linesHtml = '';
      if (items.length) {
        linesHtml = items.map(function (d) {
          var qty = Number(d.Qty || 0);
          var salesQty = d.SalesQty != null ? Number(d.SalesQty) : null;
          var effectiveQty = Number(d.EffectiveQty || d.Qty || 0);
          var unitPrice = d.UnitPrice != null ? Number(d.UnitPrice) : null;
          var lineTotal = d.LineTotal != null ? Number(d.LineTotal) : null;
          var ws = d.WarehouseStatus || '';

          var priceText = '';
          if (seePrice && unitPrice !== null) {
            priceText = ' x ' + fmtMoney(unitPrice);
            if (lineTotal !== null) priceText += ' = ' + fmtMoney(lineTotal);
          }

          var qtyText;
          if (!seePrice) {
            qtyText = fmtNum(effectiveQty);
          } else if (salesQty !== null && salesQty !== qty) {
            qtyText = '<span style="text-decoration:line-through;color:var(--text2)">' + fmtNum(qty) + '</span> ' + fmtNum(salesQty);
          } else {
            qtyText = fmtNum(qty);
          }

          var wsBadge = '';
          if (ws) {
            var wsColor = ws === '有货' ? 'var(--primary)' : (ws === '部分有货' ? '#b45309' : 'var(--danger)');
            wsBadge = ' <span style="font-size:11px;color:' + wsColor + '">' + escapeHTML(ws) + '</span>';
          }

          return '<div class="order-line-row">' +
            '<div>' +
            '<div class="order-line-title">' + escapeHTML(d.ProductName || d.ProductID) + wsBadge + '</div>' +
            '<div class="order-line-sub">' + qtyText + ' ' + escapeHTML(d.Unit || '') + priceText + '</div>' +
            (d.WarehouseNote ? '<div class="row-sub">仓库备注：' + escapeHTML(d.WarehouseNote) + '</div>' : '') +
            '</div>' +
            (seePrice && lineTotal !== null ? '<strong>' + fmtMoney(lineTotal) + '</strong>' : '') +
            '</div>';
        }).join('');
      } else {
        linesHtml = '<div class="empty small">没有产品明细</div>';
      }

      return '<div class="card">' +
        '<div class="row-flex" style="margin-bottom:5px">' +
        '<span class="mono">' + escapeHTML(r.RequestID || '') + '</span>' +
        '<span class="chip ' + chipClass + '">' + label + '</span>' +
        '</div>' +
        '<div class="row-sub">' + custName + ' · ' + date + '</div>' +
        (r.CustomerNote ? '<div class="row-sub">客户备注：' + escapeHTML(r.CustomerNote) + '</div>' : '') +
        (seePrice && r.SalesNote ? '<div class="row-sub">Sales 备注：' + escapeHTML(r.SalesNote) + '</div>' : '') +
        (r.WarehouseNote ? '<div class="row-sub">仓库备注：' + escapeHTML(r.WarehouseNote) + '</div>' : '') +
        linesHtml +
        (seePrice && r.RejectReason ? '<div class="row-sub" style="color:var(--danger)">拒绝原因：' + escapeHTML(r.RejectReason) + '</div>' : '') +
        (seePrice && r.ConvertedPOID ? '<div class="row-sub">已转正式订单：<span class="mono">' + escapeHTML(r.ConvertedPOID) + '</span></div>' : '') +
        (seePrice && ['submitted','sales_review','warehouse_check','waiting_customer'].indexOf(r.Status) !== -1
          ? '<div style="margin-top:8px"><button class="btn btn-primary sm cr-review-btn" data-rid="' + escapeHTML(r.RequestID) + '">审核 / 改价</button></div>'
          : '') +
        (r.Status === 'warehouse_check' && canPrepareOrder()
          ? '<div style="margin-top:4px"><button class="btn btn-primary sm cr-wh-btn" data-rid="' + escapeHTML(r.RequestID) + '">查货</button></div>'
          : '') +
        (seePrice && ['submitted','sales_review','warehouse_check','waiting_customer','confirmed'].indexOf(r.Status) !== -1
          ? '<div style="margin-top:4px"><button class="btn sm cr-contact-btn" data-rid="' + escapeHTML(r.RequestID) + '">联系客户</button></div>'
          : '') +
        (seePrice && r.Status === 'confirmed'
          ? '<div style="margin-top:4px"><button class="btn btn-primary sm cr-convert-btn" data-rid="' + escapeHTML(r.RequestID) + '">转正式订单</button></div>'
          : '') +
        '</div>';
    }).join('');

    // 绑定审核按钮事件
    container.querySelectorAll('.cr-review-btn').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        openCRReviewModal(this.dataset.rid);
      });
    });

    // 绑定查货按钮事件
    container.querySelectorAll('.cr-wh-btn').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        openCRWarehouseModal(this.dataset.rid);
      });
    });

    // 绑定联系客户按钮事件
    container.querySelectorAll('.cr-contact-btn').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        openCRContactModal(this.dataset.rid);
      });
    });

    // 绑定转正式订单按钮事件
    container.querySelectorAll('.cr-convert-btn').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        convertCRToOrder(this.dataset.rid);
      });
    });
  }

  // ============================================================
  // Sales 审核 Modal
  // ============================================================
  function openCRReviewModal(requestId) {
    var req = null;
    for (var i = 0; i < state.customerRequests.length; i++) {
      if (state.customerRequests[i].RequestID === requestId) {
        req = state.customerRequests[i];
        break;
      }
    }
    if (!req) return;

    var items = (state.customerRequestItems || []).filter(function (it) {
      return it.RequestID === requestId;
    });

    state.currentCRRequestID = requestId;
    document.getElementById('cr-review-title').textContent = '审核客户申请 ' + requestId;
    document.getElementById('cr-review-meta').textContent =
      '客户：' + (req.CustomerName || req.CustomerID) + ' · 状态：' +
      (STATUS_LABELS_CR[req.Status] || req.Status);
    document.getElementById('cr-review-sales-note').value = req.SalesNote || '';
    document.getElementById('cr-review-error').style.display = 'none';

    // 渲染可编辑明细
    var itemsContainer = document.getElementById('cr-review-items');
    itemsContainer.innerHTML = items.map(function (d, idx) {
      var salesQty = d.SalesQty != null ? Number(d.SalesQty) : '';
      var unitPrice = d.UnitPrice != null ? Number(d.UnitPrice) : '';
      var lineTotal = d.LineTotal != null ? Number(d.LineTotal) : (salesQty !== '' && unitPrice !== '' ? Number(salesQty) * Number(unitPrice) : 0);
      return '<div class="cr-review-item" data-id="' + d.id + '" data-idx="' + idx + '" style="border:1px solid var(--border);border-radius:8px;padding:8px;margin-bottom:8px">' +
        '<div style="font-weight:600;margin-bottom:4px">' + escapeHTML(d.ProductName || d.ProductID) + ' <span style="font-weight:400;color:var(--text2);font-size:13px">' + escapeHTML(d.Unit || '') + '</span></div>' +
        '<div style="font-size:13px;color:var(--text2);margin-bottom:6px">客户数量：' + fmtNum(Number(d.Qty || 0)) + (d.CustomerNote ? ' · ' + escapeHTML(d.CustomerNote) : '') + '</div>' +
        '<div class="order-line-inputs">' +
          '<div class="form-group"><label class="form-label">Sales 数量</label><input type="number" class="cr-sales-qty" value="' + salesQty + '" placeholder="' + fmtNum(Number(d.Qty || 0)) + '" min="0" step="any" style="width:100%"></div>' +
          '<div class="form-group"><label class="form-label">单价 (RM)</label><input type="number" class="cr-unit-price" value="' + unitPrice + '" placeholder="0.00" min="0" step="0.01" style="width:100%"></div>' +
        '</div>' +
        '<div style="font-size:13px;text-align:right;margin-top:4px;color:var(--text2)">小计：<strong class="cr-line-total">' + fmtMoney(lineTotal) + '</strong></div>' +
        '</div>';
    }).join('');

    // 绑定实时计算
    itemsContainer.querySelectorAll('.cr-sales-qty, .cr-unit-price').forEach(function (input) {
      input.addEventListener('input', function () {
        var itemEl = this.closest('.cr-review-item');
        var qty = parseFloat(itemEl.querySelector('.cr-sales-qty').value) || 0;
        var price = parseFloat(itemEl.querySelector('.cr-unit-price').value) || 0;
        itemEl.querySelector('.cr-line-total').textContent = fmtMoney(qty * price);
      });
    });

    // 状态流转按钮
    var status = req.Status;
    var actionsContainer = document.getElementById('cr-review-actions');
    actionsContainer.innerHTML = '';

    var transitions = [];
    if (status === 'submitted')    transitions = [{ s: 'sales_review',    label: '送 Sales 审核' }];
    if (status === 'sales_review') transitions = [{ s: 'warehouse_check', label: '送仓库查货' }];
    if (status === 'warehouse_check') transitions = [
      { s: 'waiting_customer', label: '通知客户等待' },
      { s: 'confirmed',       label: '确认可出货' }
    ];
    if (status === 'waiting_customer') transitions = [{ s: 'confirmed', label: '客户已确认' }];

    transitions.forEach(function (t) {
      var btn = document.createElement('button');
      btn.className = 'btn btn-primary sm';
      btn.textContent = t.label;
      btn.addEventListener('click', function () {
        submitCRReview(requestId, t.s);
      });
      actionsContainer.appendChild(btn);
    });

    document.getElementById('modal-cr-review').classList.add('open');
  }

  function collectCRReviewItems() {
    var items = [];
    document.querySelectorAll('#cr-review-items .cr-review-item').forEach(function (el) {
      var id = el.dataset.id;
      var qty = parseFloat(el.querySelector('.cr-sales-qty').value);
      var price = parseFloat(el.querySelector('.cr-unit-price').value);
      if (!isNaN(qty) || !isNaN(price)) {
        items.push({
          id: parseInt(id),
          sales_qty: isNaN(qty) ? null : qty,
          unit_price: isNaN(price) ? null : price
        });
      }
    });
    return items;
  }

  function submitCRReview(requestId, newStatus) {
    var items = collectCRReviewItems();
    var note = (document.getElementById('cr-review-sales-note').value || '').trim();
    var errEl = document.getElementById('cr-review-error');

    // 客户端前置校验
    for (var i = 0; i < items.length; i++) {
      if (items[i].sales_qty !== null && items[i].sales_qty <= 0) {
        errEl.textContent = 'Sales 数量必须大于 0';
        errEl.style.display = 'block';
        return;
      }
      if (items[i].unit_price !== null && items[i].unit_price < 0) {
        errEl.textContent = '单价不能为负数';
        errEl.style.display = 'block';
        return;
      }
    }
    errEl.style.display = 'none';

    sbRpc('sales_update_customer_request', {
      p_request_id: requestId,
      p_items: items.length ? items : null,
      p_sales_note: note || null,
      p_new_status: newStatus
    }).then(function () {
      document.getElementById('modal-cr-review').classList.remove('open');
      loadCustomerRequests().then(renderCustomerRequests);
    }).catch(function (e) {
      errEl.textContent = e.message || '保存失败';
      errEl.style.display = 'block';
    });
  }

  // ============================================================
  // Warehouse 查货 Modal
  // ============================================================
  function openCRWarehouseModal(requestId) {
    var req = null;
    for (var i = 0; i < state.customerRequests.length; i++) {
      if (state.customerRequests[i].RequestID === requestId) {
        req = state.customerRequests[i];
        break;
      }
    }
    if (!req || req.Status !== 'warehouse_check') return;

    var items = (state.customerRequestItems || []).filter(function (it) {
      return it.RequestID === requestId;
    });

    state.currentCRWarehouseID = requestId;
    document.getElementById('cr-wh-title').textContent = '仓库查货 ' + requestId;
    document.getElementById('cr-wh-meta').textContent =
      '客户：' + (req.CustomerName || req.CustomerID) +
      ' · 状态：' + (STATUS_LABELS_CR[req.Status] || req.Status);
    document.getElementById('cr-wh-note').value = req.WarehouseNote || '';
    document.getElementById('cr-wh-error').style.display = 'none';

    var itemsContainer = document.getElementById('cr-wh-items');
    itemsContainer.innerHTML = items.map(function (d) {
      var ws = d.WarehouseStatus || '';
      var whQty = Number(d.EffectiveQty || d.Qty || 0);
      return '<div class="cr-wh-item" data-id="' + d.id + '" style="border:1px solid var(--border);border-radius:8px;padding:8px;margin-bottom:8px">' +
        '<div style="font-weight:600;margin-bottom:4px">' + escapeHTML(d.ProductName || d.ProductID) +
        ' <span style="font-weight:400;color:var(--text2);font-size:13px">' + escapeHTML(d.Unit || '') + '</span></div>' +
        '<div style="font-size:13px;color:var(--text2);margin-bottom:6px">数量：' + fmtNum(whQty) +
        (d.CustomerNote ? ' · 客户备注：' + escapeHTML(d.CustomerNote) : '') + '</div>' +
        '<div class="form-group"><label class="form-label">查货结果</label>' +
        '<select class="cr-wh-status" style="width:100%">' +
        '<option value="" disabled' + (ws ? '' : ' selected') + '>请选择…</option>' +
        '<option value="有货"' + (ws === '有货' ? ' selected' : '') + '>有货</option>' +
        '<option value="部分有货"' + (ws === '部分有货' ? ' selected' : '') + '>部分有货</option>' +
        '<option value="无货"' + (ws === '无货' ? ' selected' : '') + '>无货</option>' +
        '</select></div>' +
        '<div class="form-group"><label class="form-label">仓库备注（可选）</label>' +
        '<input type="text" class="cr-wh-item-note" value="' + escapeHTML(d.WarehouseNote || '') + '" placeholder="缺货原因等" style="width:100%"></div>' +
        '</div>';
    }).join('');

    document.getElementById('modal-cr-warehouse').classList.add('open');
  }

  function collectCRWarehouseItems() {
    var items = [];
    document.querySelectorAll('#cr-wh-items .cr-wh-item').forEach(function (el) {
      var ws = el.querySelector('.cr-wh-status').value;
      var wn = (el.querySelector('.cr-wh-item-note').value || '').trim();
      if (ws) {
        items.push({
          id: parseInt(el.dataset.id),
          warehouse_status: ws,
          warehouse_note: wn || null
        });
      }
    });
    return items;
  }

  function submitCRWarehouse() {
    var requestId = state.currentCRWarehouseID;
    if (!requestId) return;
    var items = collectCRWarehouseItems();
    var note = (document.getElementById('cr-wh-note').value || '').trim();
    var errEl = document.getElementById('cr-wh-error');
    var totalItems = document.querySelectorAll('#cr-wh-items .cr-wh-item').length;

    errEl.style.display = 'none';

    if (items.length !== totalItems) {
      errEl.textContent = '请为每个产品选择查货结果';
      errEl.style.display = 'block';
      return;
    }

    sbRpc('warehouse_update_customer_request', {
      p_request_id: requestId,
      p_items: items.length ? items : null,
      p_warehouse_note: note || null
    }).then(function () {
      document.getElementById('modal-cr-warehouse').classList.remove('open');
      loadCustomerRequests().then(renderCustomerRequests);
    }).catch(function (e) {
      errEl.textContent = e.message || '保存失败';
      errEl.style.display = 'block';
    });
  }

  // ============================================================
  // 联系客户 / 拒绝 Modal
  // ============================================================
  function normalizeMalaysiaPhone(raw) {
    var digits = String(raw || '').replace(/[^0-9]/g, '');
    if (!digits) return '';
    if (digits.indexOf('60') === 0 && digits.length >= 9) return digits;
    if (digits.indexOf('0') === 0) return '60' + digits.slice(1);
    if (digits.indexOf('1') === 0) return '60' + digits;
    if (digits.length >= 9) return digits;
    return '';
  }

  function openCRContactModal(requestId) {
    var req = null;
    for (var i = 0; i < state.customerRequests.length; i++) {
      if (state.customerRequests[i].RequestID === requestId) {
        req = state.customerRequests[i];
        break;
      }
    }
    if (!req) return;
    if (req.Status === 'converted' || req.Status === 'cancelled' || req.Status === 'rejected') return;

    state.currentCRContactID = requestId;

    document.getElementById('cr-contact-title').textContent = '联系客户 ' + requestId;
    document.getElementById('cr-contact-meta').textContent =
      '客户：' + (req.CustomerName || req.CustomerID) +
      ' · 状态：' + (STATUS_LABELS_CR[req.Status] || req.Status);
    document.getElementById('cr-contact-note').value = '';
    document.getElementById('cr-reject-reason').value = '';
    document.getElementById('cr-reject-section').style.display = 'none';
    document.getElementById('cr-contact-error').style.display = 'none';

    // WhatsApp 快捷按钮
    var cust = state.customers.get(req.CustomerID);
    var waBtn = document.getElementById('cr-contact-wa');
    if (cust && cust.Phone) {
      var phone = normalizeMalaysiaPhone(cust.Phone);
      if (phone) {
        var text = encodeURIComponent(
          '您好，关于您的订货申请 ' + requestId + '，'
        );
        waBtn.href = 'https://wa.me/' + phone + '?text=' + text;
        waBtn.style.display = 'flex';
      } else {
        waBtn.style.display = 'none';
      }
    } else {
      waBtn.style.display = 'none';
    }

    document.getElementById('modal-cr-contact').classList.add('open');
  }

  function submitCRContact() {
    var requestId = state.currentCRContactID;
    if (!requestId) return;
    var method = document.getElementById('cr-contact-method').value;
    var note = (document.getElementById('cr-contact-note').value || '').trim();
    var errEl = document.getElementById('cr-contact-error');

    if (!note) {
      errEl.textContent = '请填写联系备注';
      errEl.style.display = 'block';
      return;
    }
    errEl.style.display = 'none';

    sbRpc('sales_contact_customer', {
      p_request_id: requestId,
      p_contact_method: method,
      p_contact_note: note
    }).then(function () {
      document.getElementById('modal-cr-contact').classList.remove('open');
      loadCustomerRequests().then(renderCustomerRequests);
    }).catch(function (e) {
      errEl.textContent = e.message || '保存失败';
      errEl.style.display = 'block';
    });
  }

  function submitCRReject() {
    var requestId = state.currentCRContactID;
    if (!requestId) return;
    var method = document.getElementById('cr-contact-method').value;
    var note = (document.getElementById('cr-contact-note').value || '').trim();
    var reason = (document.getElementById('cr-reject-reason').value || '').trim();
    var errEl = document.getElementById('cr-contact-error');

    // 先显示拒绝原因区
    var rejectSection = document.getElementById('cr-reject-section');
    if (rejectSection.style.display === 'none') {
      rejectSection.style.display = 'block';
      document.getElementById('cr-reject-reason').focus();
      return;
    }

    if (!note) {
      errEl.textContent = '请填写联系备注';
      errEl.style.display = 'block';
      return;
    }
    if (!reason) {
      errEl.textContent = '请填写拒绝原因';
      errEl.style.display = 'block';
      return;
    }
    errEl.style.display = 'none';

    sbRpc('sales_contact_customer', {
      p_request_id: requestId,
      p_contact_method: method,
      p_contact_note: note,
      p_reject_reason: reason
    }).then(function () {
      document.getElementById('modal-cr-contact').classList.remove('open');
      loadCustomerRequests().then(renderCustomerRequests);
    }).catch(function (e) {
      errEl.textContent = e.message || '拒绝失败';
      errEl.style.display = 'block';
    });
  }

  // ============================================================
  // 转正式订单
  // ============================================================
  function convertCRToOrder(requestId) {
    if (!confirm('确认将客户申请 ' + requestId + ' 转换为 YCPos 正式订单？\n\n转换后将生成 purchase_orders 并进入现有出货流程，不可撤销。')) {
      return;
    }

    sbRpc('convert_customer_request_to_order', {
      p_request_id: requestId
    }).then(function (result) {
      showToast('已转正式订单：' + (result || ''));
      loadCustomerRequests().then(renderCustomerRequests);
      // 刷新订单列表，让新 PO 出现在订单页
      loadOrdersForCurrentRole().then(function (bundle) {
        if (bundle) {
          state.orders = bundle.orders || [];
          state.orderDetails = new Map();
          (bundle.orderDetails || []).forEach(function (d) {
            var arr = state.orderDetails.get(d.POID) || [];
            arr.push(d);
            state.orderDetails.set(d.POID, arr);
          });
        }
      });
    }).catch(function (e) {
      showToast('转换失败：' + (e.message || '未知错误'), 'err');
    });
  }

  function renderOrderSummary(orders) {
    const container = document.getElementById('order-summary');
    if (!container) return;
    if (!orders.length) {
      container.innerHTML = '<div class="empty">暂无订单汇总</div>';
      return;
    }

    const stats = orders.reduce((acc, o) => {
      const lines = state.orderDetails.get(o.POID) || [];
      const status = o.Status || 'pending';
      const total = sumOrderTotal(o, lines);
      acc.count += 1;
      acc.byStatus[status] = (acc.byStatus[status] || 0) + total;
      lines.forEach(d => {
        const key = d.ProductID;
        const qty = Number(d.QTY || 0);
        const lineTotal = Number(d.LineTotal || qty * Number(d.UnitPrice || 0));
        if (!acc.products[key]) acc.products[key] = { qty: 0, amount: 0, unit: getProdUnit(key) };
        acc.products[key].qty += qty;
        acc.products[key].amount += lineTotal;
      });
      const customer = o.CustomerID;
      acc.customers[customer] = (acc.customers[customer] || 0) + total;
      return acc;
    }, { count: 0, byStatus: {}, products: {}, customers: {} });

    const productRows = Object.entries(stats.products).map(([id, item]) =>
      `<div class="summary-row"><span>${escapeHTML(getProdName(id))}</span><strong>${fmtNum(item.qty)} ${escapeHTML(item.unit)}${canSeePrices() ? ' · ' + fmtMoney(item.amount) : ''}</strong></div>`
    ).join('');
    const customerRows = canSeePrices() ? Object.entries(stats.customers).map(([id, amount]) =>
      `<div class="summary-row"><span>${escapeHTML(getOrderCustomerName(orders.find(o => o.CustomerID === id) || { CustomerID: id }))}</span><strong>${fmtMoney(amount)}</strong></div>`
    ).join('') : '';

    container.innerHTML = `<div class="summary-block">
      <div class="mini-stat-grid">
        <div class="mini-stat"><div class="stat-label">订单数量</div><div class="stat-value">${stats.count}</div></div>
        <div class="mini-stat"><div class="stat-label">待处理</div><div class="stat-value">${canSeePrices() ? fmtMoney(stats.byStatus.pending || 0) : (orders.filter(o => (o.Status || 'pending') === 'pending').length + ' 单')}</div></div>
        <div class="mini-stat"><div class="stat-label">备货/上车</div><div class="stat-value">${canSeePrices() ? fmtMoney((stats.byStatus.ready || 0) + (stats.byStatus.loaded || 0)) : (orders.filter(o => ['ready', 'loaded'].includes(o.Status)).length + ' 单')}</div></div>
        <div class="mini-stat"><div class="stat-label">完成</div><div class="stat-value">${canSeePrices() ? fmtMoney(stats.byStatus.done || 0) : (orders.filter(o => o.Status === 'done').length + ' 单')}</div></div>
        <div class="mini-stat"><div class="stat-label">取消</div><div class="stat-value">${canSeePrices() ? fmtMoney(stats.byStatus.cancelled || 0) : (orders.filter(o => o.Status === 'cancelled').length + ' 单')}</div></div>
      </div>
      <div class="card">
        <div class="row-title">产品汇总</div>
        <div class="summary-list">${productRows || '<div class="empty small">没有产品明细</div>'}</div>
      </div>
      ${canSeePrices() ? `<div class="card">
        <div class="row-title">客户汇总</div>
        <div class="summary-list">${customerRows || '<div class="empty small">没有客户汇总</div>'}</div>
      </div>` : ''}
    </div>`;
  }

  function openPrintWindow(title, bodyHtml) {
    const win = window.open('', '_blank');
    if (!win) {
      showToast('浏览器阻止了打印窗口，请允许弹窗', 'err');
      return;
    }
    win.document.write(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHTML(title)}</title>
      <style>
        *{box-sizing:border-box}
        html,body{margin:0;padding:0}
        body{font-family:Arial,"Noto Sans SC",sans-serif;color:#111;background:#f3f3f3;font-size:11px;line-height:1.28}
        .sheet{width:105mm;min-height:148.5mm;background:#fff;padding:6mm;overflow:hidden}
        h1{font-size:16px;margin:0 0 5mm;font-weight:700}
        .meta{display:grid;grid-template-columns:22mm 1fr;gap:2mm 4mm;margin:0 0 5mm}
        .meta strong{font-weight:700}
        .meta span{word-break:break-word}
        table{width:100%;border-collapse:collapse;margin:0 0 8mm;table-layout:fixed}
        th,td{border:1px solid #cfcfcf;padding:2.2mm 1.6mm;text-align:left;vertical-align:top;word-break:break-word}
        th{background:#f3f3f3;font-weight:700}
        th:nth-child(1),td:nth-child(1){width:38%}
        th:nth-child(2),td:nth-child(2){width:20%}
        th:nth-child(3),td:nth-child(3){width:22%}
        th:nth-child(4),td:nth-child(4){width:20%}
        .sign{display:grid;grid-template-columns:1fr 1fr;gap:10mm;margin-top:10mm}
        .line{border-top:1px solid #333;padding-top:2mm;min-height:12mm}
        .toolbar{position:sticky;bottom:0;padding:10px;background:rgba(243,243,243,.96);border-top:1px solid #ddd}
        .toolbar button{width:100%;max-width:105mm;padding:12px 14px;border:1px solid #999;border-radius:6px;background:#fff;font-size:16px}
        @media screen{
          body{display:flex;flex-direction:column;align-items:flex-start}
          .sheet{box-shadow:0 1px 8px rgba(0,0,0,.12);transform-origin:top left}
        }
        @media screen and (max-width:430px){
          .sheet{width:100vw;min-height:141.4vw;padding:14px;font-size:11px}
          h1{font-size:17px;margin-bottom:14px}
          .meta{grid-template-columns:80px 1fr;gap:6px 10px;margin-bottom:14px}
          th,td{padding:7px 5px}
          .sign{gap:26px;margin-top:28px}
        }
        @media print{
          @page{size:A4 portrait;margin:0}
          body{background:#fff}
          .toolbar{display:none}
          .sheet{width:105mm;min-height:148.5mm;padding:6mm;box-shadow:none;page-break-after:always}
        }
      </style></head><body><main class="sheet">${bodyHtml}</main><div class="toolbar"><button onclick="window.print()">打印</button></div></body></html>`);
    win.document.close();
    win.focus();
  }

  function printStockIn(stockInID) {
    const s = state.stockIns.find(x => x.StockInID === stockInID);
    if (!s) return;
    const d = state.stockInDetails.get(stockInID);
    const product = d ? getProd(d.ProductID) : null;
    openPrintWindow('进货证明 ' + stockInID, `
      <h1>YCPos 进货证明</h1>
      <div class="meta">
        <strong>进货单号</strong><span>${escapeHTML(stockInID)}</span>
        <strong>日期时间</strong><span>${escapeHTML(getDateText(s.Date))} ${escapeHTML(s.Time || '')}</span>
        <strong>供应商</strong><span>${escapeHTML(getSupName(s.SupplierID))}</span>
        <strong>经手人</strong><span>${escapeHTML(s.CreatedBy || '')}</span>
        <strong>备注</strong><span>${escapeHTML(s.Note || '')}</span>
      </div>
      <table><thead><tr><th>产品</th><th>等级</th><th>数量</th><th>单位</th></tr></thead><tbody>
        <tr>
          <td>${escapeHTML(product ? product.ProductName : '-')}</td>
          <td>${escapeHTML(product ? (product.Grade || '-') : '-')}</td>
          <td>${escapeHTML(d ? fmtNum(d.Qty) : '-')}</td>
          <td>${escapeHTML(d ? getProdUnit(d.ProductID) : '-')}</td>
        </tr>
      </tbody></table>
      <div class="sign"><div class="line">供应商确认</div><div class="line">公司确认</div></div>
    `);
  }

  function printOrder(poID) {
    const o = state.orders.find(x => x.POID === poID);
    if (!o) return;
    const lines = state.orderDetails.get(poID) || [];
    const rows = lines.map(d => {
      const product = getProd(d.ProductID);
      return `<tr>
        <td>${escapeHTML(product ? product.ProductName : getProdName(d.ProductID))}</td>
        <td>${escapeHTML(product ? (product.Grade || '-') : '-')}</td>
        <td>${escapeHTML(fmtNum(d.QTY))}</td>
        <td>${escapeHTML(getProdUnit(d.ProductID))}</td>
      </tr>`;
    }).join('');
    openPrintWindow('备货单 ' + poID, `
      <h1>YCPos 备货单</h1>
      <div class="meta">
        <strong>订单号</strong><span>${escapeHTML(poID)}</span>
        <strong>日期</strong><span>${escapeHTML(getDateText(o.Date))}</span>
        <strong>客户</strong><span>${escapeHTML(getOrderCustomerName(o))}</span>
        <strong>状态</strong><span>${escapeHTML(STATUS_LABELS[o.Status || 'pending'] || o.Status || '')}</span>
        <strong>备注</strong><span>${escapeHTML(o.Note || '')}</span>
      </div>
      <table><thead><tr><th>产品</th><th>等级</th><th>数量</th><th>单位</th></tr></thead><tbody>${rows}</tbody></table>
      <div class="sign"><div class="line">备货确认</div><div class="line">上车确认</div></div>
    `);
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
        <div style="display:flex;align-items:center;gap:8px">
          <span style="font-size:22px">👤</span>
          ${isAdmin() ? `<button class="del-btn" data-type="customer" data-id="${c.CustomerID}">✕</button>` : ''}
        </div>
      </div>`;
    }).join('');
    attachDeleteHandlers(container);
  }

  const debouncedRenderProducts = debounce(renderProducts, 250);
  const debouncedRenderSuppliers = debounce(renderSuppliers, 250);
  const debouncedRenderCustomers = debounce(renderCustomers, 250);

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

    // 根据页面控制 FAB
    const fab = document.getElementById('fab');
    fab.style.display = canShowFab(page) ? 'flex' : 'none';
  }

  // ============================================================
  // Modal 控制
  // ============================================================
  const PAGE_MODAL_MAP = {
    dashboard:  'modal-si',
    stockin:    'modal-si',
    products:   'modal-prod',
    orders:     'modal-order',
    processing: 'modal-processing',
    suppliers:  'modal-supplier',
    customers:  'modal-customer'
  };

  function openModal() {
    const modalId = PAGE_MODAL_MAP[state.currentPage];
    if (!modalId) return;
    // 权限检查
    if (!canUseModal(modalId)) {
      showToast('你没有权限执行此操作', 'err');
      return;
    }
    state.currentModal = modalId;
    document.getElementById(modalId).classList.add('open');
    // 打开 modal 后更新一次单位标签
    updateQtyLabels();
    if (modalId === 'modal-processing') {
      selectSuggestedProcessingTarget();
      updateProcessingPreview();
    }
    if (modalId === 'modal-order') renderOrderDraft();
  }

  function closeModal() {
    if (state.currentModal) {
      if (state.currentModal === 'modal-order') {
        state.orderDraft = [];
        document.getElementById('o-qty').value = '';
        document.getElementById('o-price').value = '';
        document.getElementById('o-note').value = '';
        renderOrderDraft();
      }
      document.getElementById(state.currentModal).classList.remove('open');
      state.currentModal = null;
    }
  }

  // ============================================================
  // 表单提交
  // ============================================================
  async function submitStockIn() {
    if (!canUseModal('modal-si')) { showToast('无权操作', 'err'); return; }
    const qty = Number(document.getElementById('f-qty').value);
    if (!qty || qty < 1) { showToast('请输入正确数量', 'err'); return; }
    const btn = document.getElementById('btn-si');
    btn.disabled = true;
    btn.textContent = '提交中...';
    try {
      const supplierID = document.getElementById('f-sup').value;
      const productID = document.getElementById('f-prod').value;
      await sbRpc('create_stock_in', {
        p_supplier_id: supplierID,
        p_product_id: productID,
        p_qty: qty,
        p_note: document.getElementById('f-note').value.trim()
      });

      showToast('进货成功！', 'ok');
      document.getElementById('f-qty').value = '';
      document.getElementById('f-note').value = '';
      closeModal();
      await loadAll();
    } catch (e) {
      showToast('提交失败: ' + getErrorMessage(e), 'err');
    }
    btn.disabled = false;
    btn.textContent = '确认进货';
  }

  function updateProcessingPreview() {
    const input = Number(document.getElementById('pr-input').value || 0);
    const other = Number(document.getElementById('pr-other-loss').value || 0);
    const output = Math.max(input - other, 0);
    const unit = getProdUnit(document.getElementById('pr-source').value);
    const rate = input ? (other / input * 100) : 0;
    const source = getProd(document.getElementById('pr-source').value);
    const mapped = getMappedSalesGrade(source);
    const hint = mapped ? '建议出货等级：' + mapped + '。' : '';
    document.getElementById('processing-preview').textContent =
      hint + '可售产出 ' + fmtNum(output) + ' ' + unit + '，损耗率 ' + rate.toFixed(1) + '%';
  }

  function selectSuggestedProcessingTarget() {
    const sourceEl = document.getElementById('pr-source');
    const targetEl = document.getElementById('pr-target');
    if (!sourceEl || !targetEl) return;
    const source = getProd(sourceEl.value);
    const mappedGrade = getMappedSalesGrade(source);
    if (!source || !mappedGrade) return;
    const match = Array.from(state.products.values()).find(p =>
      p.ProductID !== source.ProductID &&
      normalizeFruitName(p.ProductName) === normalizeFruitName(source.ProductName) &&
      String(p.Grade || '').toUpperCase() === String(mappedGrade).toUpperCase()
    );
    if (match) targetEl.value = match.ProductID;
  }

  async function submitProcessing() {
    if (!canUseModal('modal-processing')) { showToast('无权操作', 'err'); return; }
    const sourceID = document.getElementById('pr-source').value;
    const targetID = document.getElementById('pr-target').value;
    const input = Number(document.getElementById('pr-input').value || 0);
    const stem = 0;
    const other = Number(document.getElementById('pr-other-loss').value || 0);
    const output = input - other;
    const source = getProd(sourceID);
    const target = getProd(targetID);

    if (!sourceID || !targetID || !source || !target) { showToast('请选择原料和可售产品', 'err'); return; }
    if (!input || input <= 0) { showToast('请输入正确加工数量', 'err'); return; }
    if (other < 0 || output <= 0) { showToast('损耗不能大过加工数量', 'err'); return; }
    if (Number(source.StockBalance || 0) < input) { showToast('原料库存不足', 'err'); return; }

    const btn = document.getElementById('btn-processing');
    btn.disabled = true;
    btn.textContent = '提交中...';
    try {
      await sbRpc('process_fruit_loss', {
        p_source_product_id: sourceID,
        p_target_product_id: targetID,
        p_input_qty: input,
        p_stem_loss: stem,
        p_other_loss: other
      });

      showToast('加工记录已保存', 'ok');
      ['pr-input', 'pr-other-loss'].forEach(id => document.getElementById(id).value = '');
      closeModal();
      await loadAll();
    } catch (e) {
      showToast('提交失败: ' + getErrorMessage(e), 'err');
    }
    btn.disabled = false;
    btn.textContent = '确认加工';
  }

  async function submitProduct() {
    if (!canUseModal('modal-prod')) { showToast('无权操作', 'err'); return; }
    const name = document.getElementById('np-name').value.trim();
    if (!name) { showToast('请输入产品名称', 'err'); return; }
    const btn = document.getElementById('btn-prod');
    btn.disabled = true;
    btn.textContent = '添加中...';
    try {
      await sbRpc('create_product', {
        p_product_name: name,
        p_grade: document.getElementById('np-grade').value,
        p_unit: document.getElementById('np-unit').value,
        p_note: document.getElementById('np-note').value.trim()
      });
      showToast('产品已添加！', 'ok');
      document.getElementById('np-name').value = '';
      document.getElementById('np-grade').value = '';
      document.getElementById('np-note').value = '';
      closeModal();
      await loadAll();
    } catch (e) {
      showToast('提交失败: ' + getErrorMessage(e), 'err');
    }
    btn.disabled = false;
    btn.textContent = '添加产品';
  }

  async function submitCustomer() {
    if (!canUseModal('modal-customer')) { showToast('无权操作', 'err'); return; }
    const name = document.getElementById('nc-name').value.trim();
    if (!name) { showToast('请输入客户名称', 'err'); return; }
    const btn = document.getElementById('btn-customer');
    btn.disabled = true;
    btn.textContent = '添加中...';
    try {
      await sbRpc('create_customer', {
        p_customer_name: name,
        p_phone: document.getElementById('nc-phone').value.trim(),
        p_note: document.getElementById('nc-note').value.trim()
      });
      showToast('客户已添加！', 'ok');
      document.getElementById('nc-name').value = '';
      document.getElementById('nc-phone').value = '';
      document.getElementById('nc-note').value = '';
      closeModal();
      await loadAll();
    } catch (e) {
      showToast('提交失败: ' + getErrorMessage(e), 'err');
    }
    btn.disabled = false;
    btn.textContent = '添加客户';
  }

  async function submitSupplier() {
    if (!canUseModal('modal-supplier')) { showToast('无权操作', 'err'); return; }
    const name = document.getElementById('ns-name').value.trim();
    if (!name) { showToast('请输入供应商名称', 'err'); return; }
    const btn = document.getElementById('btn-supplier');
    btn.disabled = true;
    btn.textContent = '添加中...';
    try {
      await sbRpc('create_supplier', {
        p_supplier_name: name,
        p_phone: document.getElementById('ns-phone').value.trim(),
        p_note: document.getElementById('ns-note').value.trim()
      });
      showToast('供应商已添加！', 'ok');
      document.getElementById('ns-name').value = '';
      document.getElementById('ns-phone').value = '';
      document.getElementById('ns-note').value = '';
      closeModal();
      await loadAll();
    } catch (e) {
      showToast('提交失败: ' + getErrorMessage(e), 'err');
    }
    btn.disabled = false;
    btn.textContent = '添加供应商';
  }

  function renderOrderDraft() {
    const list = document.getElementById('order-draft-list');
    const totalEl = document.getElementById('order-total');
    if (!list || !totalEl) return;

    const total = state.orderDraft.reduce((sum, line) => sum + line.qty * line.unitPrice, 0);
    totalEl.textContent = '总额 ' + fmtMoney(total);

    if (!state.orderDraft.length) {
      list.innerHTML = '<div class="empty small">还没有产品</div>';
      return;
    }

    list.innerHTML = state.orderDraft.map((line, index) => {
      const product = getProd(line.productID);
      return `<div class="order-draft-row">
        <div>
          <div class="order-draft-title">${escapeHTML(formatProductLabel(product))}</div>
          <div class="order-draft-sub">${fmtNum(line.qty)} ${escapeHTML(getProdUnit(line.productID))} x ${fmtMoney(line.unitPrice)} = ${fmtMoney(line.qty * line.unitPrice)}</div>
        </div>
        <button class="order-remove" data-index="${index}" type="button">×</button>
      </div>`;
    }).join('');

    list.querySelectorAll('.order-remove').forEach(btn => {
      btn.addEventListener('click', function() {
        state.orderDraft.splice(Number(this.dataset.index), 1);
        renderOrderDraft();
      });
    });
  }

  function addOrderLine() {
    const productID = document.getElementById('o-prod').value;
    const qty = Number(document.getElementById('o-qty').value || 0);
    const unitPrice = Number(document.getElementById('o-price').value || 0);
    if (!productID) { showToast('请选择产品', 'err'); return; }
    if (!qty || qty <= 0) { showToast('请输入正确数量', 'err'); return; }
    if (unitPrice < 0) { showToast('请输入正确单价', 'err'); return; }

    const existing = state.orderDraft.find(line => line.productID === productID && line.unitPrice === unitPrice);
    if (existing) existing.qty += qty;
    else state.orderDraft.push({ productID, qty, unitPrice });

    document.getElementById('o-qty').value = '';
    document.getElementById('o-price').value = '';
    renderOrderDraft();
  }

  async function submitOrder() {
    if (!canUseModal('modal-order')) { showToast('无权操作', 'err'); return; }
    if (!state.orderDraft.length) { showToast('请先加入产品', 'err'); return; }
    const btn = document.getElementById('btn-order');
    btn.disabled = true;
    btn.textContent = '创建中...';
    try {
      const customerID = document.getElementById('o-cust').value;
      await sbRpc('create_sales_order', {
        p_customer_id: customerID,
        p_note: document.getElementById('o-note').value.trim(),
        p_items: state.orderDraft.map(line => ({
          product_id: line.productID,
          qty: line.qty,
          unit_price: line.unitPrice
        }))
      });

      showToast('订单已创建！', 'ok');
      state.orderDraft = [];
      document.getElementById('o-qty').value = '';
      document.getElementById('o-price').value = '';
      document.getElementById('o-note').value = '';
      renderOrderDraft();
      closeModal();
      await loadAll();
    } catch (e) {
      showToast('提交失败: ' + getErrorMessage(e), 'err');
    }
    btn.disabled = false;
    btn.textContent = '创建订单';
  }

  async function changeOrderStatus(poID, status) {
    const allowed = (status === 'ready' || status === 'loaded') ? canPrepareOrder()
      : status === 'done' ? canCompleteOrder()
      : status === 'cancelled' ? canCancelOrder()
      : false;
    if (!allowed) {
      showToast('无权操作', 'err');
      return;
    }
    try {
      await sbRpc('change_sales_order_status', {
        p_po_id: poID,
        p_status: status
      });
      showToast(STATUS_LABELS[status] ? '订单已更新为' + STATUS_LABELS[status] : '订单已更新', status === 'cancelled' ? 'err' : 'ok');
      await loadAll();
    } catch (e) {
      showToast('操作失败: ' + getErrorMessage(e), 'err');
    }
  }

  // ============================================================
  // 删除功能（仅 admin）
  // ============================================================
  function attachDeleteHandlers(container) {
    container.querySelectorAll('.del-btn').forEach(btn => {
      btn.addEventListener('click', async function() {
        if (!isAdmin()) { showToast('无权操作', 'err'); return; }
        showToast('正式版暂不允许直接删除，请用取消/作废流程保留审计记录', 'err');
      });
    });
  }

  // ============================================================
  // 新增用户（仅 admin）
  // ============================================================
  async function submitAddUser() {
    if (!isAdmin()) { showToast('无权操作', 'err'); return; }
    const email = document.getElementById('au-user').value.trim();
    const displayName = document.getElementById('au-display').value.trim();
    const password = document.getElementById('au-pass').value.trim();
    const role = document.getElementById('au-role').value;
    if (!email || !displayName || !password || !role) {
      showToast('请填写所有员工资料', 'err');
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      showToast('请输入正确的 Email', 'err');
      return;
    }
    if (password.length < 6) {
      showToast('密码至少需要 6 位', 'err');
      return;
    }

    const btn = document.getElementById('btn-adduser');
    btn.disabled = true;
    btn.textContent = '添加中...';
    try {
      const signupRes = await fetch(AUTH + '/signup', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': SUPABASE_KEY,
          'Authorization': 'Bearer ' + SUPABASE_KEY
        },
        body: JSON.stringify({ email, password })
      });
      if (!signupRes.ok) {
        const signupText = await signupRes.text();
        if (!signupText.includes('already registered') && !signupText.includes('already exists')) {
          throw new Error(signupText);
        }
      }

      await createStaffProfileWithRetry({
        p_email: email,
        p_display_name: displayName,
        p_role: role,
        p_active: true
      });

      showToast('用户已创建。如无法登录，请检查邮箱确认设置。', 'ok');
      document.getElementById('au-user').value = '';
      document.getElementById('au-display').value = '';
      document.getElementById('au-pass').value = '';
      document.getElementById('au-role').value = 'sales';
      closeModal();
    } catch (e) {
      const msg = getErrorMessage(e);
      if (msg.includes('row-level security') || msg.includes('permission denied')) {
        showToast('创建失败：请先执行员工创建 SQL', 'err');
      } else if (msg.includes('User already registered') || msg.includes('already registered')) {
        showToast('这个 Email 已经注册过', 'err');
      } else if (msg.includes('Auth user not found')) {
        showToast('Auth 账号未创建，请检查 Supabase 是否允许注册', 'err');
      } else {
        showToast('创建失败: ' + msg, 'err');
      }
    }
    btn.disabled = false;
    btn.textContent = '添加用户';
  }

  // ============================================================
  // 修改密码（所有人可用）
  // ============================================================
  async function submitChangePassword() {
    const oldPw = document.getElementById('cp-old').value.trim();
    const newPw = document.getElementById('cp-new').value.trim();
    const confirmPw = document.getElementById('cp-confirm').value.trim();
    if (!oldPw || !newPw || !confirmPw) { showToast('请填写所有字段', 'err'); return; }
    if (newPw !== confirmPw) { showToast('两次新密码不一致', 'err'); return; }
    const btn = document.getElementById('btn-changepw');
    btn.disabled = true;
    btn.textContent = '修改中...';
    try {
      const verify = await fetch(AUTH + '/token?grant_type=password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_KEY },
        body: JSON.stringify({ email: currentUser.Username, password: oldPw })
      });
      if (!verify.ok) { showToast('当前密码错误', 'err'); btn.disabled = false; btn.textContent = '修改密码'; return; }
      const res = await fetch(AUTH + '/user', {
        method: 'PUT',
        headers: sbHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ password: newPw })
      });
      if (!res.ok) throw new Error(await res.text());
      showToast('密码修改成功！', 'ok');
      document.getElementById('cp-old').value = '';
      document.getElementById('cp-new').value = '';
      document.getElementById('cp-confirm').value = '';
      closeModal();
    } catch (e) {
      showToast('修改失败: ' + getErrorMessage(e), 'err');
    }
    btn.disabled = false;
    btn.textContent = '修改密码';
  }

  // ============================================================
  // 初始化
  // ============================================================
  function init() {
    // 处理登录/登出
    document.getElementById('login-btn').addEventListener('click', doLogin);
    document.getElementById('login-pass').addEventListener('keydown', e => {
      if (e.key === 'Enter') doLogin();
    });
    document.getElementById('user-display').addEventListener('click', doLogout);

    // 添加用户 / 修改密码按钮
    document.getElementById('btn-add-user').addEventListener('click', function() {
      if (!isAdmin()) { showToast('无权操作', 'err'); return; }
      state.currentModal = 'modal-adduser';
      document.getElementById('modal-adduser').classList.add('open');
    });
    document.getElementById('btn-change-pw').addEventListener('click', function() {
      state.currentModal = 'modal-changepw';
      document.getElementById('modal-changepw').classList.add('open');
    });

    // 导航
    document.querySelector('.nav').addEventListener('click', function(e) {
      const btn = e.target.closest('.nav-btn');
      if (!btn) return;
      e.preventDefault();
      const page = btn.dataset.page;
      if (page) switchPage(page, btn);
    });

    // 搜索
    document.getElementById('product-search').addEventListener('input', debouncedRenderProducts);
    document.getElementById('supplier-search').addEventListener('input', debouncedRenderSuppliers);
    document.getElementById('customer-search').addEventListener('input', debouncedRenderCustomers);
    document.getElementById('stockin-date-from').addEventListener('change', function() {
      state.stockInFilter.from = this.value;
      renderStockIn();
    });
    document.getElementById('stockin-date-to').addEventListener('change', function() {
      state.stockInFilter.to = this.value;
      renderStockIn();
    });
    document.getElementById('btn-stockin-clear').addEventListener('click', function() {
      state.stockInFilter = { from: '', to: '' };
      document.getElementById('stockin-date-from').value = '';
      document.getElementById('stockin-date-to').value = '';
      renderStockIn();
    });
    document.getElementById('order-date-from').addEventListener('change', function() {
      state.orderFilter.from = this.value;
      renderOrders();
    });
    document.getElementById('order-date-to').addEventListener('change', function() {
      state.orderFilter.to = this.value;
      renderOrders();
    });
    document.getElementById('btn-order-clear').addEventListener('click', function() {
      state.orderFilter = { from: '', to: '' };
      document.getElementById('order-date-from').value = '';
      document.getElementById('order-date-to').value = '';
      renderOrders();
    });
    document.getElementById('cr-date-from').addEventListener('change', function() {
      state.crFilter.from = this.value;
      renderCustomerRequests();
    });
    document.getElementById('cr-date-to').addEventListener('change', function() {
      state.crFilter.to = this.value;
      renderCustomerRequests();
    });
    document.getElementById('cr-status-filter').addEventListener('change', function() {
      state.crFilter.status = this.value;
      renderCustomerRequests();
    });
    document.getElementById('btn-cr-clear').addEventListener('click', function() {
      state.crFilter = { from: '', to: '', status: '' };
      document.getElementById('cr-date-from').value = '';
      document.getElementById('cr-date-to').value = '';
      document.getElementById('cr-status-filter').value = '';
      renderCustomerRequests();
    });

    // 产品选择 change 事件 → 更新数量单位标签
    document.getElementById('f-prod').addEventListener('change', updateQtyLabels);
    document.getElementById('o-prod').addEventListener('change', updateQtyLabels);
    document.getElementById('pr-source').addEventListener('change', function() {
      selectSuggestedProcessingTarget();
      updateProcessingPreview();
    });
    document.getElementById('pr-target').addEventListener('change', updateProcessingPreview);
    ['pr-input', 'pr-other-loss'].forEach(id => {
      document.getElementById(id).addEventListener('input', updateProcessingPreview);
    });

    // 按钮
    document.getElementById('fab').addEventListener('click', openModal);
    document.getElementById('sync-btn').addEventListener('click', () => loadAll());

    // 正式录单时不允许点背景关闭，避免误触导致资料丢失。

    // 表单提交
    document.getElementById('btn-si').addEventListener('click', submitStockIn);
    document.getElementById('btn-prod').addEventListener('click', submitProduct);
    document.getElementById('btn-customer').addEventListener('click', submitCustomer);
    document.getElementById('btn-supplier').addEventListener('click', submitSupplier);
    document.getElementById('btn-order-add-line').addEventListener('click', addOrderLine);
    document.getElementById('btn-order').addEventListener('click', submitOrder);
    document.getElementById('btn-processing').addEventListener('click', submitProcessing);
    document.getElementById('btn-adduser').addEventListener('click', submitAddUser);
    document.getElementById('btn-changepw').addEventListener('click', submitChangePassword);

    // 取消按钮关闭
    document.querySelectorAll('.btn-cancel').forEach(btn => {
      btn.addEventListener('click', closeModal);
    });

    // Sales 审核 — 仅保存不改变状态
    document.getElementById('btn-cr-save').addEventListener('click', function () {
      var requestId = state.currentCRRequestID;
      if (!requestId) return;
      var items = collectCRReviewItems();
      var note = (document.getElementById('cr-review-sales-note').value || '').trim();
      var errEl = document.getElementById('cr-review-error');
      errEl.style.display = 'none';

      // 前端校验
      for (var i = 0; i < items.length; i++) {
        if (items[i].sales_qty !== null && items[i].sales_qty <= 0) {
          errEl.textContent = 'Sales 数量必须大于 0';
          errEl.style.display = 'block';
          return;
        }
        if (items[i].unit_price !== null && items[i].unit_price < 0) {
          errEl.textContent = '单价不能为负数';
          errEl.style.display = 'block';
          return;
        }
      }

      sbRpc('sales_update_customer_request', {
        p_request_id: requestId,
        p_items: items.length ? items : null,
        p_sales_note: note || null
      }).then(function () {
        document.getElementById('modal-cr-review').classList.remove('open');
        loadCustomerRequests().then(renderCustomerRequests);
      }).catch(function (e) {
        errEl.textContent = e.message || '保存失败';
        errEl.style.display = 'block';
      });
    });

    // Warehouse 查货保存
    document.getElementById('btn-cr-wh-save').addEventListener('click', submitCRWarehouse);

    // 联系客户 / 拒绝
    document.getElementById('btn-cr-contact-save').addEventListener('click', submitCRContact);
    document.getElementById('btn-cr-reject').addEventListener('click', submitCRReject);

    // Service Worker
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }

    // 检查登录状态
    if (currentUser) {
      // 已登录，直接加载
      document.getElementById('page-login').classList.remove('active');
      document.getElementById('app-main').style.display = 'flex';
      applyPermissions();
      loadAll();
    } else {
      // 未登录，显示登录页
      document.getElementById('page-login').classList.add('active');
      document.getElementById('app-main').style.display = 'none';
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
