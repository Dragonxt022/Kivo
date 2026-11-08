(function () {
  'use strict';

  var dataEl = document.getElementById('menu-data');
  if (!dataEl) return;
  var menu = null;
  try { menu = JSON.parse(dataEl.textContent || 'null'); } catch (e) { menu = null; }
  if (!menu || !Array.isArray(menu.categories)) return;

  var cfg = window.__PEDIDO__ || {};
  var token = cfg.token;
  if (!token) return;

  var state = {
    cart: [],
    item: null,
    selections: {},
    qty: 1,
    notes: '',
    takeaway: false,
    clientRequestId: uuid(),
    orderUuid: null,
    poll: null,
  };

  function byId(id) { return document.getElementById(id); }
  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function brl(cents) {
    return (Number(cents || 0) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  }
  function uuid() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0;
      var v = c === 'x' ? r : ((r & 0x3) | 0x8);
      return v.toString(16);
    });
  }
  function slug(s) {
    return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'cat';
  }
  var toastTimer = null;
  function toast(msg) {
    var old = document.querySelector('.pedido-toast');
    if (old) old.remove();
    var el = document.createElement('div');
    el.className = 'pedido-toast';
    el.textContent = msg;
    document.body.appendChild(el);
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.remove(); }, 3200);
  }
  function thumb(item, big) {
    var cls = 'pedido-thumb' + (big ? ' big' : '');
    if (item.imageUrl) {
      return '<span class="' + cls + '"><img src="' + esc(item.imageUrl) + '" alt="' + esc(item.name) +
        '" loading="lazy" onerror="this.remove()"></span>';
    }
    return '<span class="' + cls + '"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" ' +
      'stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M3 2v7c0 1.1.9 2 2 2h4a2 2 0 0 0 2-2V2"/><path d="M7 2v20"/><path d="M21 15V2a5 5 0 0 0-5 5v6c0 1.1.9 2 2 2h3Zm0 0v7"/>' +
      '</svg></span>';
  }
  function itemByUuid(uuidValue) {
    for (var i = 0; i < menu.categories.length; i++) {
      var items = menu.categories[i].items;
      for (var j = 0; j < items.length; j++) if (items[j].productUuid === uuidValue) return items[j];
    }
    return null;
  }

  // ─── Histórico local (por loja, no navegador do cliente) ───────────────────
  var HISTORY_KEY = 'kivo:pedido-historico:v1:' + (cfg.companyUuid || 'loja');

  function makeLineKey(item, notes, takeaway, complements) {
    return item.productUuid + '|' + (takeaway ? '1' : '0') + '|' + (notes || '') + '|' +
      (complements || []).map(function (c) { return c.productUuid + 'x' + c.qty; }).sort().join(',');
  }

  function readHistory() {
    try {
      var raw = window.localStorage.getItem(HISTORY_KEY);
      var parsed = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(function (o) {
        return o && typeof o === 'object' && Array.isArray(o.items) && o.items.length;
      }).slice(0, 8);
    } catch (e) {
      return [];
    }
  }

  function writeHistory(list) {
    try {
      window.localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, 8)));
    } catch (e) { /* navegador sem localStorage/quota: o pedido continua funcionando */ }
  }

  function formatHistoryDate(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleString('pt-BR', {
      day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
    });
  }

  function saveOrderHistory(order) {
    var list = readHistory().filter(function (o) { return o.orderUuid !== order.orderUuid; });
    list.unshift(order);
    writeHistory(list);
    renderHistory();
  }

  var historyDetailIndex = 0;

  function statusInfo(status) {
    var s = String(status || '');
    if (s === 'confirmado') {
      return {
        label: 'Confirmado', cls: 'is-ok',
        icon: '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
      };
    }
    if (s === 'recusado') {
      return {
        label: 'Recusado', cls: 'is-bad',
        icon: '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="m15 9-6 6M9 9l6 6"/></svg>',
      };
    }
    if (s === 'erro') {
      return {
        label: 'Falhou', cls: 'is-bad',
        icon: '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v4M12 16h.01"/></svg>',
      };
    }
    if (s === 'aplicado') {
      return {
        label: 'Aguardando atendente', cls: 'is-wait',
        icon: '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
      };
    }
    return {
      label: 'Enviado', cls: 'is-sent',
      icon: '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/></svg>',
    };
  }

  function statusChip(status) {
    var info = statusInfo(status);
    return '<span class="pedido-status-chip ' + info.cls + '">' + info.icon + esc(info.label) + '</span>';
  }

  function orderItemsSummary(order) {
    return (order.items || []).map(function (i) {
      return (Number(i.qty) || 1) + '× ' + (i.name || 'item');
    }).join(', ');
  }

  function orderMeta(order) {
    var meta = formatHistoryDate(order.createdAt);
    if (order.tableLabel) meta += (meta ? ' · ' : '') + order.tableLabel;
    return meta;
  }

  function renderHistory() {
    var list = readHistory();

    var count = byId('historyCount');
    if (count) {
      count.textContent = String(list.length);
      count.hidden = list.length === 0;
    }

    var last = list[0];
    var lastSection = byId('lastOrderSection');
    if (lastSection) {
      lastSection.hidden = !last;
      if (last) {
        if (byId('lastOrderTitle')) byId('lastOrderTitle').textContent = orderItemsSummary(last);
        if (byId('lastOrderMeta')) byId('lastOrderMeta').textContent = orderMeta(last);
        if (byId('lastOrderTotal')) byId('lastOrderTotal').textContent = brl(last.totalCents);
        if (byId('lastOrderStatus')) byId('lastOrderStatus').innerHTML = statusChip(last.status);
      }
    }

    var listEl = byId('historyList');
    var empty = byId('historyEmpty');
    if (!listEl) return;
    if (empty) empty.hidden = list.length > 0;
    listEl.innerHTML = list.map(function (order, idx) {
      return '<div class="pedido-history-card">' +
        '<div class="pedido-history-card-top">' +
        '<div class="pedido-history-main">' +
        '<div class="pedido-history-title">' + esc(orderItemsSummary(order)) + '</div>' +
        '<div class="pedido-history-meta">' + esc(orderMeta(order)) + '</div>' +
        '</div>' +
        statusChip(order.status) +
        '</div>' +
        '<div class="pedido-history-foot">' +
        '<strong class="pedido-history-total">' + brl(order.totalCents) + '</strong>' +
        '<div class="pedido-history-actions">' +
        '<button type="button" class="pedido-history-detail" data-detail="' + idx + '">' +
        '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg> Detalhes</button>' +
        '<button type="button" class="pedido-history-reorder" data-reorder="' + idx + '">' +
        '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg> Pedir novamente</button>' +
        '</div></div></div>';
    }).join('');
  }

  function renderHistoryDetail(order) {
    var head = byId('historyDetailHeadline');
    if (head) {
      head.innerHTML = statusChip(order.status) +
        '<span class="pedido-history-meta">' + esc(orderMeta(order)) + '</span>';
    }
    var body = byId('historyDetailBody');
    if (!body) return;
    var rows = (order.items || []).map(function (item) {
      var complements = (item.complements || []).map(function (c) {
        return '<div class="pedido-detail-complement">+ ' + (Number(c.qty) || 1) + '× ' + esc(c.name) +
          '<span>' + brl(Number(c.unitPriceCents) * (Number(c.qty) || 1)) + '</span></div>';
      }).join('');
      var total = Number(item.unitPriceCents) * (Number(item.qty) || 1);
      (item.complements || []).forEach(function (c) {
        total += Number(c.unitPriceCents) * (Number(c.qty) || 1);
      });
      return '<div class="pedido-detail-item">' +
        '<div class="pedido-detail-line"><strong>' + (Number(item.qty) || 1) + '× ' + esc(item.name) + '</strong>' +
        '<span>' + brl(total) + '</span></div>' +
        (item.takeaway ? '<div class="pedido-detail-tag">' +
          '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4Z"/><path d="M3 6h18"/><path d="M16 10a4 4 0 0 1-8 0"/></svg> Para viagem</div>' : '') +
        complements +
        (item.notes ? '<div class="pedido-detail-note">' +
          '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg> ' + esc(item.notes) + '</div>' : '') +
        '</div>';
    }).join('');
    body.innerHTML = rows +
      '<div class="pedido-detail-total"><span>Total</span><strong>' + brl(order.totalCents) + '</strong></div>' +
      (order.note ? '<div class="pedido-detail-note pedido-detail-general">' +
        '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg> ' + esc(order.note) + '</div>' : '');
  }

  function openHistory() {
    renderHistory();
    var dlg = byId('historyDlg');
    if (dlg) dlg.showModal();
  }

  function openHistoryDetail(index) {
    var order = readHistory()[index];
    if (!order) return;
    historyDetailIndex = index;
    renderHistoryDetail(order);
    var historyDlg = byId('historyDlg');
    if (historyDlg && historyDlg.open) historyDlg.close();
    var dlg = byId('historyDetailDlg');
    if (dlg) dlg.showModal();
  }

  function updateHistoryStatus(orderUuid, status) {
    if (!orderUuid || !status) return;
    var list = readHistory();
    var changed = false;
    for (var i = 0; i < list.length; i++) {
      if (list[i].orderUuid === orderUuid) {
        list[i].status = status;
        list[i].statusUpdatedAt = new Date().toISOString();
        changed = true;
      }
    }
    if (changed) {
      writeHistory(list);
      renderHistory();
    }
  }

  function showReorderNote(messages) {
    var el = byId('reorderNote');
    if (!el) return;
    var unique = [];
    messages.forEach(function (m) { if (unique.indexOf(m) === -1) unique.push(m); });
    if (!unique.length) {
      el.hidden = true;
      el.innerHTML = '';
      return;
    }
    el.hidden = false;
    el.innerHTML = '<strong>Revisão do pedido anterior</strong>' +
      unique.map(function (m) { return '<span>• ' + esc(m) + '</span>'; }).join('');
  }

  function reorder(index) {
    var order = readHistory()[index];
    if (!order) return;
    var messages = [];
    var added = 0;

    (order.items || []).forEach(function (saved) {
      var item = itemByUuid(saved.productUuid);
      if (!item) {
        messages.push('Indisponível agora: ' + (saved.name || 'item'));
        return;
      }

      var chosen = [];
      (saved.complements || []).forEach(function (sc) {
        var group = (item.complements || []).find(function (g) {
          return g.options.some(function (o) { return o.productUuid === sc.productUuid; });
        });
        var opt = group && group.options.find(function (o) { return o.productUuid === sc.productUuid; });
        if (!opt) {
          messages.push('Adicional indisponível: ' + (sc.name || 'item') + ' (' + item.name + ')');
          return;
        }
        if (Number(sc.unitPriceCents) !== Number(opt.priceCents)) {
          messages.push('Adicional ' + opt.name + ': ' + brl(sc.unitPriceCents) + ' → ' + brl(opt.priceCents));
        }
        chosen.push({
          productUuid: opt.productUuid, name: opt.name, priceCents: opt.priceCents,
          qty: Math.min(10, Math.max(1, Number(sc.qty) || 1)),
        });
      });

      // Revalida os grupos depois de remover adicionais que sumiram do cardápio.
      var invalidGroup = false;
      (item.complements || []).forEach(function (group) {
        var groupChosen = chosen.filter(function (c) {
          return group.options.some(function (o) { return o.productUuid === c.productUuid; });
        });
        if (group.maxSelect != null && groupChosen.length > group.maxSelect) {
          var extra = groupChosen.slice(group.maxSelect);
          extra.forEach(function (c) {
            var pos = chosen.indexOf(c);
            if (pos >= 0) chosen.splice(pos, 1);
          });
          messages.push('Removemos adicional(is) de ' + item.name + ' (limite do grupo).');
          groupChosen = groupChosen.slice(0, group.maxSelect);
        }
        if (group.minSelect > 0 && groupChosen.length < group.minSelect) {
          messages.push('Escolha os adicionais de ' + item.name + ' novamente.');
          invalidGroup = true;
        }
      });
      if (invalidGroup) return;

      if (Number(saved.unitPriceCents) !== Number(item.priceCents)) {
        messages.push('Preço de ' + item.name + ': ' + brl(saved.unitPriceCents) + ' → ' + brl(item.priceCents));
      }

      var qty = Math.min(20, Math.max(1, Number(saved.qty) || 1));
      var notes = saved.notes || null;
      var takeaway = saved.takeaway === true;
      var key = makeLineKey(item, notes, takeaway, chosen);
      var existing = state.cart.find(function (l) { return l.key === key; });
      if (existing) {
        existing.qty = Math.min(20, existing.qty + qty);
      } else {
        state.cart.push({
          key: key,
          productUuid: item.productUuid,
          name: item.name,
          priceCents: item.priceCents,
          qty: qty,
          notes: notes,
          takeaway: takeaway,
          complements: chosen,
        });
      }
      added++;
    });

    if (!added) {
      toast(messages[0] || 'Nenhum item deste pedido está disponível agora.');
      return;
    }
    if (byId('orderNote')) byId('orderNote').value = order.note || '';
    renderCart();
    showReorderNote(messages);
    cartDlg.showModal();
  }

  // ─── Menu ──────────────────────────────────────────────────────────────────
  var menuEl = byId('menu');
  var navEl = byId('catNav');
  var noResults = byId('noResults');

  (function renderMenu() {
    var html = '';
    var nav = '';
    menu.categories.forEach(function (cat, ci) {
      var id = 'cat-' + slug(cat.name) + '-' + ci;
      nav += '<a href="#' + id + '" data-cat="' + id + '">' + esc(cat.name) + '</a>';
      html += '<section class="pedido-category" id="' + id + '" data-category>';
      html += '<h2>' + esc(cat.name) + '</h2>';
      cat.items.forEach(function (item) {
        html += '<button type="button" class="pedido-item" data-product="' + esc(item.productUuid) +
          '" data-search="' + esc((item.name + ' ' + (item.description || '')).toLowerCase()) + '">' +
          thumb(item) +
          '<span class="pedido-item-main">' +
          '<span class="pedido-item-name">' + esc(item.name) + '</span>' +
          (item.description ? '<span class="pedido-item-desc">' + esc(item.description) + '</span>' : '') +
          '<span class="pedido-item-bottom"><span class="pedido-item-price">' + brl(item.priceCents) +
          '</span><span class="pedido-add" aria-hidden="true">+</span></span>' +
          '</span></button>';
      });
      html += '</section>';
    });
    menuEl.innerHTML = html;
    navEl.innerHTML = nav;

    menuEl.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-product]');
      if (!btn) return;
      openItem(btn.getAttribute('data-product'));
    });
  })();

  (function search() {
    var input = byId('menuSearch');
    if (!input) return;
    input.addEventListener('input', function () {
      var q = input.value.trim().toLowerCase();
      var any = false;
      var sections = menuEl.querySelectorAll('[data-category]');
      for (var i = 0; i < sections.length; i++) {
        var section = sections[i];
        var items = section.querySelectorAll('[data-product]');
        var visible = 0;
        for (var j = 0; j < items.length; j++) {
          var match = !q || (items[j].getAttribute('data-search') || '').indexOf(q) !== -1;
          items[j].hidden = !match;
          if (match) visible++;
        }
        section.hidden = visible === 0;
        if (visible) any = true;
      }
      if (noResults) noResults.hidden = !(q && !any);
    });
  })();

  (function navHighlight() {
    var links = Array.prototype.slice.call(navEl.querySelectorAll('a'));
    if (!links.length || !('IntersectionObserver' in window)) return;
    var byIdMap = {};
    links.forEach(function (a) { byIdMap[a.getAttribute('data-cat')] = a; });
    var obs = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        var link = byIdMap[entry.target.id];
        if (!link) return;
        links.forEach(function (a) { a.classList.remove('active'); });
        link.classList.add('active');
        var left = link.offsetLeft - navEl.clientWidth / 2 + link.clientWidth / 2;
        navEl.scrollTo({ left: Math.max(0, left), behavior: 'smooth' });
      });
    }, { rootMargin: '-30% 0px -60% 0px', threshold: 0 });
    menuEl.querySelectorAll('[data-category]').forEach(function (s) { obs.observe(s); });
  })();

  // ─── Item / complementos ───────────────────────────────────────────────────
  var itemDlg = byId('itemDlg');
  var itemBody = byId('itemBody');
  var itemTitle = byId('itemTitle');

  function groupKey(group) { return group.groupUuid || ('g:' + group.name); }

  function ruleText(group) {
    if (group.maxSelect != null && group.maxSelect === group.minSelect) {
      return 'Escolha ' + group.minSelect;
    }
    if (group.minSelect > 0 && group.maxSelect != null) {
      return 'Obrigatório · ' + group.minSelect + ' a ' + group.maxSelect;
    }
    if (group.minSelect > 0) return 'Obrigatório · ao menos ' + group.minSelect;
    if (group.maxSelect != null) return 'Até ' + group.maxSelect;
    return 'Opcional';
  }

  function openItem(productUuid) {
    var item = itemByUuid(productUuid);
    if (!item) return;
    state.item = item;
    state.qty = 1;
    state.notes = '';
    state.takeaway = false;
    state.selections = {};
    itemTitle.textContent = item.name;

    var groupsHtml = '';
    if (item.complements && item.complements.length) {
      groupsHtml = item.complements.map(function (group) {
        var gk = groupKey(group);
        var opts = group.options.map(function (opt) {
          return '<label class="pedido-option">' +
            '<input type="checkbox" data-group-opt="' + esc(gk) + '" data-option="' + esc(opt.productUuid) + '">' +
            '<span class="pedido-option-main"><span class="pedido-option-name">' + esc(opt.name) + '</span>' +
            (opt.priceCents > 0 ? '<span class="pedido-option-price">+ ' + brl(opt.priceCents) + '</span>' : '') +
            '</span>' +
            '<span class="pedido-option-qty" data-qty-for="' + esc(opt.productUuid) + '" hidden>' +
            '<button type="button" data-opt-minus="' + esc(opt.productUuid) + '" aria-label="Menos ' + esc(opt.name) + '">−</button>' +
            '<span data-opt-qty="' + esc(opt.productUuid) + '">1</span>' +
            '<button type="button" data-opt-plus="' + esc(opt.productUuid) + '" aria-label="Mais ' + esc(opt.name) + '">+</button>' +
            '</span></label>';
        }).join('');
        return '<div class="pedido-group" data-group="' + esc(gk) + '">' +
          '<div class="pedido-group-head"><strong>' + esc(group.name) + '</strong><small>' + ruleText(group) + '</small></div>' +
          opts + '</div>';
      }).join('');
    }

    itemBody.innerHTML =
      '<div class="pedido-item-hero">' + thumb(item, true) +
      '<div><h3>' + esc(item.name) + '</h3>' +
      (item.description ? '<p>' + esc(item.description) + '</p>' : '') +
      '<div class="pedido-qty"><button type="button" data-main-minus aria-label="Menos">−</button>' +
      '<span id="itemQty">1</span><button type="button" data-main-plus aria-label="Mais">+</button></div>' +
      '</div></div>' +
      groupsHtml +
      '<label class="pedido-field"><span>Observação deste item</span>' +
      '<textarea id="itemNotes" maxlength="200" rows="2" placeholder="Ex.: sem cebola, ponto da carne…"></textarea></label>' +
      '<label class="pedido-toggle"><input type="checkbox" id="itemTakeaway">' +
      '<span>Para viagem<small>O item será embalado para você levar.</small></span></label>';

    itemDlg.showModal();
  }

  function findGroup(gk) {
    if (!state.item || !state.item.complements) return null;
    return state.item.complements.find(function (g) { return groupKey(g) === gk; }) || null;
  }

  itemBody.addEventListener('change', function (e) {
    var cb = e.target.closest('input[data-option]');
    if (!cb) return;
    var gk = cb.getAttribute('data-group-opt');
    var opt = cb.getAttribute('data-option');
    var group = findGroup(gk);
    if (!group) return;
    var sel = state.selections[gk] || (state.selections[gk] = {});

    if (cb.checked) {
      if (group.maxSelect === 1) {
        Object.keys(sel).forEach(function (k) {
          delete sel[k];
          var other = itemBody.querySelector('input[data-group-opt="' + cssEsc(gk) + '"][data-option="' + cssEsc(k) + '"]');
          if (other) other.checked = false;
          var q = itemBody.querySelector('[data-qty-for="' + cssEsc(k) + '"]');
          if (q) q.hidden = true;
        });
      } else if (group.maxSelect != null && Object.keys(sel).length >= group.maxSelect) {
        cb.checked = false;
        toast('Escolha no máximo ' + group.maxSelect + ' opção(ões) em ' + group.name + '.');
        return;
      }
      sel[opt] = 1;
      var qtyEl = itemBody.querySelector('[data-qty-for="' + cssEsc(opt) + '"]');
      if (qtyEl) qtyEl.hidden = false;
    } else {
      delete sel[opt];
      var q2 = itemBody.querySelector('[data-qty-for="' + cssEsc(opt) + '"]');
      if (q2) q2.hidden = true;
    }
  });

  itemBody.addEventListener('click', function (e) {
    var mainPlus = e.target.closest('[data-main-plus]');
    var mainMinus = e.target.closest('[data-main-minus]');
    if (mainPlus) {
      state.qty += 1;
      byId('itemQty').textContent = String(state.qty);
      return;
    }
    if (mainMinus) {
      state.qty = Math.max(1, state.qty - 1);
      byId('itemQty').textContent = String(state.qty);
      return;
    }
    var plus = e.target.closest('[data-opt-plus]');
    var minus = e.target.closest('[data-opt-minus]');
    var key = plus ? plus.getAttribute('data-opt-plus') : (minus ? minus.getAttribute('data-opt-minus') : null);
    if (!key) return;
    var group = state.item && state.item.complements
      ? state.item.complements.find(function (g) { return g.options.some(function (o) { return o.productUuid === key; }); })
      : null;
    if (!group) return;
    var gk = groupKey(group);
    var sel = state.selections[gk] || (state.selections[gk] = {});
    var current = sel[key] || 1;
    sel[key] = Math.min(10, Math.max(1, current + (plus ? 1 : -1)));
    var span = itemBody.querySelector('[data-opt-qty="' + cssEsc(key) + '"]');
    if (span) span.textContent = String(sel[key]);
  });

  function cssEsc(v) {
    return String(v).replace(/["\\]/g, '\\$&');
  }

  byId('addItem').addEventListener('click', function () {
    var item = state.item;
    if (!item) return;
    // Valida mínimo por grupo e monta os complementos escolhidos.
    var chosen = [];
    for (var gi = 0; gi < (item.complements || []).length; gi++) {
      var group = item.complements[gi];
      var gk = groupKey(group);
      var sel = state.selections[gk] || {};
      var count = Object.keys(sel).length;
      if (group.minSelect > 0 && count < group.minSelect) {
        toast('Escolha ao menos ' + group.minSelect + ' opção(ões) em "' + group.name + '".');
        return;
      }
      Object.keys(sel).forEach(function (optUuid) {
        var opt = group.options.find(function (o) { return o.productUuid === optUuid; });
        if (opt) chosen.push({ productUuid: opt.productUuid, name: opt.name, priceCents: opt.priceCents, qty: sel[optUuid] || 1 });
      });
    }
    var notes = (byId('itemNotes').value || '').trim().slice(0, 200);
    var takeaway = byId('itemTakeaway').checked;
    var key = item.productUuid + '|' + (takeaway ? '1' : '0') + '|' + notes + '|' +
      chosen.map(function (c) { return c.productUuid + 'x' + c.qty; }).sort().join(',');

    var existing = state.cart.find(function (l) { return l.key === key; });
    if (existing) {
      existing.qty += state.qty;
    } else {
      state.cart.push({
        key: key,
        productUuid: item.productUuid,
        name: item.name,
        priceCents: item.priceCents,
        qty: state.qty,
        notes: notes || null,
        takeaway: takeaway,
        complements: chosen,
      });
    }
    itemDlg.close();
    renderCart();
    toast(item.name + ' adicionado.');
  });

  // ─── Carrinho ──────────────────────────────────────────────────────────────
  var cartBar = byId('cartBar');
  var cartDlg = byId('cartDlg');
  var cartBody = byId('cartBody');

  function lineTotal(line) {
    var total = line.priceCents * line.qty;
    (line.complements || []).forEach(function (c) { total += c.priceCents * c.qty; });
    return total;
  }
  function cartCount() {
    return state.cart.reduce(function (n, l) { return n + l.qty; }, 0);
  }
  function cartTotal() {
    return state.cart.reduce(function (n, l) { return n + lineTotal(l); }, 0);
  }

  function renderCart() {
    if (!cartBar) return;
    var count = cartCount();
    cartBar.hidden = count === 0;
    if (byId('cartCount')) byId('cartCount').textContent = String(count);
    if (byId('cartTotal')) byId('cartTotal').textContent = brl(cartTotal());
    if (!cartBody) return;

    if (!state.cart.length) {
      showReorderNote([]);
      cartBody.innerHTML = '<p class="pedido-cart-empty">Seu pedido está vazio.</p>';
    } else {
      cartBody.innerHTML = state.cart.map(function (line, idx) {
        var comps = (line.complements || []).map(function (c) { return c.qty + '× ' + esc(c.name); }).join(', ');
        return '<div class="pedido-cart-line">' +
          '<div class="pedido-cart-line-main">' +
          '<div class="pedido-cart-line-name">' + esc(line.name) +
          (line.takeaway ? '<span class="pedido-tag">viagem</span>' : '') + '</div>' +
          (comps ? '<div class="pedido-cart-line-meta">' + comps + '</div>' : '') +
          (line.notes ? '<div class="pedido-cart-line-meta">Obs.: ' + esc(line.notes) + '</div>' : '') +
          '<div class="pedido-qty"><button type="button" data-line-minus="' + idx + '" aria-label="Menos">−</button>' +
          '<span>' + line.qty + '</span>' +
          '<button type="button" data-line-plus="' + idx + '" aria-label="Mais">+</button></div>' +
          '</div>' +
          '<div style="display:grid;gap:.3rem;justify-items:end">' +
          '<span class="pedido-cart-line-total">' + brl(lineTotal(line)) + '</span>' +
          '<button type="button" class="pedido-cart-line-remove" data-line-remove="' + idx + '">remover</button>' +
          '</div></div>';
      }).join('') + '<div class="pedido-cart-sum"><span>Total</span><span>' + brl(cartTotal()) + '</span></div>';
    }
    if (byId('sendOrder')) byId('sendOrder').disabled = state.cart.length === 0;
  }

  cartBody.addEventListener('click', function (e) {
    var plus = e.target.closest('[data-line-plus]');
    var minus = e.target.closest('[data-line-minus]');
    var remove = e.target.closest('[data-line-remove]');
    if (plus) {
      var i = Number(plus.getAttribute('data-line-plus'));
      if (state.cart[i]) state.cart[i].qty = Math.min(20, state.cart[i].qty + 1);
    } else if (minus) {
      var j = Number(minus.getAttribute('data-line-minus'));
      if (state.cart[j]) state.cart[j].qty = Math.max(1, state.cart[j].qty - 1);
    } else if (remove) {
      var k = Number(remove.getAttribute('data-line-remove'));
      state.cart.splice(k, 1);
    } else {
      return;
    }
    renderCart();
  });

  if (byId('openCart')) {
    byId('openCart').addEventListener('click', function () {
      renderCart();
      cartDlg.showModal();
    });
  }

  // ─── Envio e status ────────────────────────────────────────────────────────
  var statusDlg = byId('statusDlg');
  var sending = false;

  if (byId('sendOrder')) {
    byId('sendOrder').addEventListener('click', function () {
      if (sending || !state.cart.length) return;
      sending = true;
      var btn = byId('sendOrder');
      btn.disabled = true;
      btn.textContent = 'Enviando…';
      var note = (byId('orderNote').value || '').trim().slice(0, 500) || null;
      var payload = {
        clientRequestId: state.clientRequestId,
        note: note,
        items: state.cart.map(function (line) {
          return {
            productUuid: line.productUuid,
            qty: line.qty,
            notes: line.notes,
            takeaway: line.takeaway,
            complements: (line.complements || []).map(function (c) {
              return { productUuid: c.productUuid, qty: c.qty };
            }),
          };
        }),
      };

      fetch('/api/pedido/' + encodeURIComponent(token) + '/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }).then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (body) {
          if (!r.ok) throw new Error(body.error || 'Não foi possível enviar o pedido.');
          return body;
        });
      }).then(function (body) {
        // Guarda no navegador ANTES de limpar o carrinho: é o "pedir novamente".
        saveOrderHistory({
          orderUuid: body.orderUuid,
          createdAt: new Date().toISOString(),
          status: 'recebido',
          totalCents: body.totalCents || cartTotal(),
          tableLabel: cfg.tableLabel || null,
          note: note,
          items: state.cart.map(function (line) {
            return {
              productUuid: line.productUuid,
              name: line.name,
              qty: line.qty,
              notes: line.notes,
              takeaway: line.takeaway,
              unitPriceCents: line.priceCents,
              complements: (line.complements || []).map(function (c) {
                return {
                  productUuid: c.productUuid, name: c.name, qty: c.qty,
                  unitPriceCents: c.priceCents,
                };
              }),
            };
          }),
        });
        state.orderUuid = body.orderUuid;
        state.clientRequestId = uuid();
        state.cart = [];
        if (byId('orderNote')) byId('orderNote').value = '';
        showReorderNote([]);
        renderCart();
        cartDlg.close();
        showStatus('recebido', null, body.desktopOnline === false);
        startPolling();
      }).catch(function (err) {
        toast(err.message || 'Falha ao enviar. Tente de novo.');
      }).then(function () {
        sending = false;
        btn.disabled = state.cart.length === 0;
        btn.textContent = 'Enviar pedido';
      });
    });
  }

  function statusContent(status, reason) {
    if (status === 'confirmado') {
      return {
        icon: '<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
        title: 'Pedido confirmado!',
        text: 'O atendente confirmou e o pedido já foi para a cozinha.',
      };
    }
    if (status === 'recusado') {
      return {
        icon: '<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="m15 9-6 6M9 9l6 6"/></svg>',
        title: 'Pedido não confirmado',
        text: reason || 'Fale com o atendente para ajustar o pedido.',
      };
    }
    if (status === 'erro') {
      return {
        icon: '<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v4M12 16h.01"/></svg>',
        title: 'Não foi possível enviar',
        text: reason || 'Chame o atendente para fazer o pedido.',
      };
    }
    if (status === 'aplicado') {
      return {
        icon: '<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
        title: 'Pedido recebido',
        text: 'Aguardando confirmação do atendente.',
      };
    }
    return {
      icon: '<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/></svg>',
      title: 'Pedido enviado!',
      text: 'Aguardando confirmação do atendente.',
    };
  }

  function showStatus(status, reason, offline) {
    var content = statusContent(status, reason);
    byId('statusIcon').innerHTML = content.icon;
    byId('statusTitle').textContent = content.title;
    byId('statusText').textContent = content.text;
    byId('statusOffline').hidden = !offline;
    if (statusDlg) statusDlg.showModal();
  }

  function startPolling() {
    if (state.poll) clearInterval(state.poll);
    if (!state.orderUuid) return;
    state.poll = setInterval(function () {
      fetch('/api/pedido/' + encodeURIComponent(token) + '/orders/' + encodeURIComponent(state.orderUuid))
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (body) {
          if (!body) return;
          var content = statusContent(body.status, body.reason);
          byId('statusIcon').innerHTML = content.icon;
          byId('statusTitle').textContent = content.title;
          byId('statusText').textContent = content.text;
          updateHistoryStatus(state.orderUuid, body.status);
          if (body.status === 'confirmado' || body.status === 'recusado' || body.status === 'erro') {
            clearInterval(state.poll);
            state.poll = null;
          }
        })
        .catch(function () { /* rede oscilou: tenta no próximo tick */ });
    }, 4000);
  }

  if (byId('orderMore')) {
    byId('orderMore').addEventListener('click', function () {
      statusDlg.close();
      if (state.poll) { clearInterval(state.poll); state.poll = null; }
      state.orderUuid = null;
    });
  }

  // ─── Histórico: render inicial, "pedir novamente" e limpar ───
  var openHistoryBtn = byId('openHistory');
  if (openHistoryBtn) openHistoryBtn.addEventListener('click', openHistory);
  var lastOrderAllBtn = byId('lastOrderAll');
  if (lastOrderAllBtn) lastOrderAllBtn.addEventListener('click', openHistory);
  var lastOrderDetailsBtn = byId('lastOrderDetails');
  if (lastOrderDetailsBtn) lastOrderDetailsBtn.addEventListener('click', function () { openHistoryDetail(0); });
  var lastOrderReorderBtn = byId('lastOrderReorder');
  if (lastOrderReorderBtn) lastOrderReorderBtn.addEventListener('click', function () { reorder(0); });

  var clearHistoryBtn = byId('clearHistory');
  if (clearHistoryBtn) {
    clearHistoryBtn.addEventListener('click', function () {
      if (!window.confirm('Apagar o histórico de pedidos deste navegador?')) return;
      try { window.localStorage.removeItem(HISTORY_KEY); } catch (e) { /* sem localStorage */ }
      renderHistory();
      toast('Histórico apagado.');
    });
  }
  var historyListEl = byId('historyList');
  if (historyListEl) {
    historyListEl.addEventListener('click', function (e) {
      var detailBtn = e.target.closest('[data-detail]');
      if (detailBtn) {
        openHistoryDetail(Number(detailBtn.getAttribute('data-detail')));
        return;
      }
      var reorderBtn = e.target.closest('[data-reorder]');
      if (!reorderBtn) return;
      reorder(Number(reorderBtn.getAttribute('data-reorder')));
    });
  }
  var historyBackBtn = byId('historyBack');
  if (historyBackBtn) {
    historyBackBtn.addEventListener('click', function () {
      var detail = byId('historyDetailDlg');
      if (detail && detail.open) detail.close();
      openHistory();
    });
  }
  var detailReorderBtn = byId('detailReorder');
  if (detailReorderBtn) {
    detailReorderBtn.addEventListener('click', function () {
      var detail = byId('historyDetailDlg');
      if (detail && detail.open) detail.close();
      var history = byId('historyDlg');
      if (history && history.open) history.close();
      reorder(historyDetailIndex);
    });
  }
  renderHistory();

  // Fecha diálogos no botão e no clique fora.
  document.addEventListener('click', function (e) {
    var close = e.target.closest('[data-close]');
    if (close) {
      var dlg = byId(close.getAttribute('data-close'));
      if (dlg) dlg.close();
    }
  });
  Array.prototype.forEach.call(document.querySelectorAll('dialog'), function (dlg) {
    dlg.addEventListener('click', function (e) {
      if (e.target === dlg) dlg.close();
    });
  });
})();
