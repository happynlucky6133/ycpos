/* ===== FreshStack Order 客户订货页面 ===== */
(function () {
  'use strict';

  // ============================================================
  // Supabase 配置（anon key — 仅可调用已授权的客户 RPC）
  // ============================================================
  var SUPABASE_URL = 'https://qmgguevkxnheyjlagcoi.supabase.co';
  var SUPABASE_KEY = 'sb_publishable_NbWgnMsQVRHc1l1USwIYhQ_nX_eXOUS';

  var sb = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

  // ============================================================
  // 状态
  // ============================================================
  var token = '';
  var customer = null;
  var products = [];        // [{ ProductID, ProductName, Unit }]
  var draftItems = [];      // [{ product_id, qty, note }]
  var requests = [];        // 客户自己的申请列表
  var requestItems = [];    // 申请明细（平铺，按 RequestID 关联）

  // 产品 id → { ProductName, Unit } 查找表
  var productMap = {};

  // 状态中文映射
  var STATUS_LABELS = {
    submitted:         '已提交',
    sales_review:      'Sales 审核中',
    warehouse_check:   '仓库查货中',
    waiting_customer:  '等待回复',
    confirmed:         '已确认',
    converted:         '已转正式订单',
    rejected:          '已拒绝',
    cancelled:         '已取消'
  };

  // ============================================================
  // DOM 引用
  // ============================================================
  var $loading   = document.getElementById('loading');
  var $error     = document.getElementById('error');
  var $main      = document.getElementById('main');
  var $custBadge = document.getElementById('customer-badge');
  var $itemList  = document.getElementById('item-list');
  var $orderNote = document.getElementById('order-note');
  var $btnAdd    = document.getElementById('btn-add-item');
  var $btnSubmit = document.getElementById('btn-submit');
  var $submitErr = document.getElementById('submit-error');
  var $toast     = document.getElementById('success-toast');
  var $histList  = document.getElementById('history-list');
  var $histEmpty = document.getElementById('history-empty');

  // ============================================================
  // 初始化
  // ============================================================
  function init() {
    token = getTokenFromURL();
    if (!token) {
      showError();
      return;
    }
    loadPortal();
  }

  function getTokenFromURL() {
    var params = new URLSearchParams(window.location.search);
    return (params.get('token') || '').trim();
  }

  // ============================================================
  // API 调用（只允许这 3 个 RPC）
  // ============================================================
  function callRPC(name, params) {
    return sb.rpc(name, params);
  }

  function loadPortal() {
    showLoading();
    callRPC('get_customer_portal_context', { p_token: token })
      .then(function (res) {
        if (res.error) throw res.error;
        var data = res.data;
        if (!data || !data.customer) throw new Error('无效响应');
        customer = data.customer;
        products = data.products || [];
        buildProductMap();
        showMain();
        renderCustomerBadge();
        addDraftRow();
        loadHistory();
      })
      .catch(function (err) {
        console.error('Portal load error:', err);
        showError();
      });
  }

  function submitOrder() {
    var draft = collectDraftItems();
    var validation = validateItems(draft);
    if (!validation.valid) {
      showSubmitError(validation.message);
      return;
    }

    var note = ($orderNote.value || '').trim();

    setSubmitting(true);
    showSubmitError('');

    callRPC('submit_customer_order_request', {
      p_token: token,
      p_items: draft.items,
      p_note: note
    })
      .then(function (res) {
        if (res.error) throw res.error;
        setSubmitting(false);
        showToast();
        clearForm();
        loadHistory();
        window.scrollTo({ top: 0, behavior: 'smooth' });
      })
      .catch(function (err) {
        console.error('Submit error:', err);
        setSubmitting(false);
        showSubmitError(err.message || '提交失败，请稍后重试');
      });
  }

  function loadHistory() {
    callRPC('get_customer_order_requests', { p_token: token })
      .then(function (res) {
        if (res.error) throw res.error;
        var data = res.data;
        requests = data.requests || [];
        requestItems = data.items || [];
        renderHistory();
      })
      .catch(function (err) {
        console.error('History load error:', err);
      });
  }

  // ============================================================
  // 产品查找表
  // ============================================================
  function buildProductMap() {
    productMap = {};
    products.forEach(function (p) {
      productMap[p.ProductID] = { ProductName: p.ProductName, Unit: p.Unit };
    });
  }

  // ============================================================
  // 界面切换
  // ============================================================
  function showLoading() {
    $loading.style.display = 'flex';
    $error.style.display = 'none';
    $main.style.display = 'none';
  }

  function showError() {
    $loading.style.display = 'none';
    $error.style.display = 'flex';
    $main.style.display = 'none';
  }

  function showMain() {
    $loading.style.display = 'none';
    $error.style.display = 'none';
    $main.style.display = 'block';
  }

  function renderCustomerBadge() {
    $custBadge.textContent = customer.CustomerName || customer.CustomerID;
  }

  // ============================================================
  // 下单草稿行
  // ============================================================
  function createItemRow() {
    var row = document.createElement('div');
    row.className = 'item-row';

    // 产品下拉
    var sel = document.createElement('select');
    sel.className = 'item-product';
    sel.innerHTML = '<option value="">选择产品</option>';
    products.forEach(function (p) {
      var opt = document.createElement('option');
      opt.value = p.ProductID;
      opt.textContent = p.ProductName + ' (' + (p.Unit || '-') + ')';
      sel.appendChild(opt);
    });

    // 数量
    var qty = document.createElement('input');
    qty.type = 'number';
    qty.className = 'item-qty';
    qty.placeholder = '数量';
    qty.min = '0';
    qty.step = 'any';

    // 行备注
    var note = document.createElement('input');
    note.type = 'text';
    note.className = 'item-note';
    note.placeholder = '备注';

    // 删除
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn-remove';
    btn.textContent = '×';
    btn.title = '移除此行';
    btn.addEventListener('click', function () {
      if ($itemList.children.length > 1) {
        row.remove();
      } else {
        sel.value = '';
        qty.value = '';
        note.value = '';
      }
    });

    row.appendChild(sel);
    row.appendChild(qty);
    row.appendChild(note);
    row.appendChild(btn);
    return row;
  }

  function addDraftRow() {
    $itemList.appendChild(createItemRow());
  }

  function collectDraftItems() {
    var items = [];
    var hasIncomplete = false;
    var rows = $itemList.querySelectorAll('.item-row');
    rows.forEach(function (row) {
      var sel  = row.querySelector('.item-product');
      var qty  = row.querySelector('.item-qty');
      var note = row.querySelector('.item-note');
      var pid  = (sel.value || '').trim();
      var q    = parseFloat(qty.value);
      var n    = (note.value || '').trim();
      if (pid) {
        if (!isNaN(q) && q > 0) {
          items.push({ product_id: pid, qty: q, note: n });
        } else {
          hasIncomplete = true;
        }
      }
    });
    return { items: items, hasIncomplete: hasIncomplete };
  }

  function validateItems(result) {
    if (result.items.length === 0) {
      if (result.hasIncomplete) {
        return { valid: false, message: '请为已选择的产品填写有效数量（必须大于 0）' };
      }
      return { valid: false, message: '请至少选择一个产品并填写数量' };
    }
    if (result.hasIncomplete) {
      return { valid: false, message: '部分已选产品未填写有效数量，请修正后再提交' };
    }
    return { valid: true };
  }

  function clearForm() {
    $itemList.innerHTML = '';
    $orderNote.value = '';
    addDraftRow();
  }

  function setSubmitting(disabled) {
    $btnSubmit.disabled = disabled;
    $btnSubmit.textContent = disabled ? '提交中…' : '提交申请';
  }

  function showSubmitError(msg) {
    $submitErr.textContent = msg;
    $submitErr.style.display = msg ? 'block' : 'none';
  }

  function showToast() {
    $toast.style.display = 'block';
    setTimeout(function () {
      $toast.style.display = 'none';
    }, 5000);
  }

  // ============================================================
  // 历史申请列表
  // ============================================================
  function renderHistory() {
    $histList.innerHTML = '';

    if (!requests.length) {
      $histEmpty.style.display = 'block';
      return;
    }
    $histEmpty.style.display = 'none';

    requests.forEach(function (r) {
      var items = requestItems.filter(function (i) {
        return i.RequestID === r.RequestID;
      });

      var card = document.createElement('div');
      card.className = 'request-card';

      var header = document.createElement('div');
      header.className = 'request-header';

      var left = document.createElement('div');
      var rid = document.createElement('span');
      rid.className = 'request-id';
      rid.textContent = r.RequestID;

      var date = document.createElement('span');
      date.className = 'request-date';
      date.textContent = '  ' + formatDate(r.SubmittedAt);

      left.appendChild(rid);
      left.appendChild(date);

      var badge = document.createElement('span');
      badge.className = 'status-badge status-' + r.Status;
      badge.textContent = STATUS_LABELS[r.Status] || r.Status;

      header.appendChild(left);
      header.appendChild(badge);

      // 展开详情
      var detail = document.createElement('div');
      detail.className = 'request-detail';

      if (items.length) {
        var table = document.createElement('table');
        table.className = 'detail-table';
        var thead = document.createElement('thead');
        thead.innerHTML = '<tr><th>产品</th><th>单位</th><th>数量</th></tr>';
        var tbody = document.createElement('tbody');
        items.forEach(function (it) {
          var tr = document.createElement('tr');
          var td1 = document.createElement('td');
          td1.textContent = it.ProductName || it.ProductID;
          var td2 = document.createElement('td');
          td2.textContent = it.Unit || '-';
          var td3 = document.createElement('td');
          td3.textContent = it.Qty;
          tr.appendChild(td1);
          tr.appendChild(td2);
          tr.appendChild(td3);
          tbody.appendChild(tr);
        });
        table.appendChild(thead);
        table.appendChild(tbody);
        detail.appendChild(table);
      }

      if (r.CustomerNote) {
        var noteP = document.createElement('p');
        noteP.className = 'request-note';
        noteP.textContent = '备注：' + r.CustomerNote;
        detail.appendChild(noteP);
      }

      if (r.Status === 'rejected' && r.RejectReason) {
        var rejectP = document.createElement('p');
        rejectP.className = 'request-note';
        rejectP.style.color = 'var(--c-danger)';
        rejectP.textContent = '拒绝原因：' + r.RejectReason;
        detail.appendChild(rejectP);
      }

      card.appendChild(header);
      card.appendChild(detail);

      card.addEventListener('click', function () {
        var open = detail.classList.contains('open');
        // 关闭所有其他卡片
        document.querySelectorAll('.request-detail.open').forEach(function (d) {
          d.classList.remove('open');
        });
        if (!open) detail.classList.add('open');
      });

      $histList.appendChild(card);
    });
  }

  // ============================================================
  // 工具函数
  // ============================================================
  function formatDate(ts) {
    if (!ts) return '';
    var d = new Date(ts);
    var yyyy = d.getFullYear();
    var mm = String(d.getMonth() + 1).padStart(2, '0');
    var dd = String(d.getDate()).padStart(2, '0');
    return yyyy + '-' + mm + '-' + dd;
  }

  // ============================================================
  // 事件绑定
  // ============================================================
  $btnAdd.addEventListener('click', addDraftRow);
  $btnSubmit.addEventListener('click', submitOrder);

  // ============================================================
  // 启动
  // ============================================================
  init();
})();
