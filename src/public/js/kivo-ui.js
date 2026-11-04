/*
  Camada de interface compartilhada do Kivo.

  As telas são EJS + Alpine, sem bundler. Em vez de importar uma biblioteca em cada
  página, este arquivo carrega o que a página realmente usa (script/CSS sob demanda,
  uma única vez) e liga o comportamento por atributo:

    <input type="date" data-picker>        → calendário (flatpickr) no desktop
    <select data-search>                   → busca digitável (Tom Select)
    <button data-tip="Texto">              → tooltip (Floating UI)
    KivoUI.trendChart(el, buckets)         → gráfico de barras (uPlot)

  Regras deliberadas:
  - Tudo é progressivo: sem JS, o input nativo e o <select> continuam funcionando.
  - No toque (celular/tablet) o date picker nativo é MELHOR que qualquer lib — o
    flatpickr só é aplicado com ponteiro fino.
  - `data-lite` (máquina fraca) desliga só as animações, não a funcionalidade.
  - Nenhum HTML é injetado a partir de dado do usuário: os textos vão por textContent.
*/
(function () {
  'use strict';

  var VENDOR = '/vendor/';
  var cache = {};

  var lite = false;
  try {
    lite = document.documentElement.getAttribute('data-lite') === '1';
  } catch {}

  function loadScript(src) {
    if (cache[src]) return cache[src];
    cache[src] = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src;
      s.async = false;
      s.onload = function () {
        resolve();
      };
      s.onerror = function () {
        reject(new Error('Falha ao carregar ' + src));
      };
      document.head.appendChild(s);
    });
    return cache[src];
  }

  function loadStyle(href) {
    if (cache[href]) return cache[href];
    cache[href] = new Promise(function (resolve) {
      var link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = href;
      link.onload = function () {
        resolve();
      };
      link.onerror = function () {
        resolve();
      };
      document.head.appendChild(link);
    });
    return cache[href];
  }

  function cssVar(name, fallback) {
    try {
      var v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      return v || fallback;
    } catch {
      return fallback;
    }
  }

  function toDate(value) {
    if (!value) return null;
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value));
    if (!m) return null;
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  }

  function shortMoney(cents) {
    var v = (Number(cents) || 0) / 100;
    if (Math.abs(v) >= 1000000) return 'R$ ' + (v / 1000000).toFixed(1).replace('.', ',') + ' mi';
    if (Math.abs(v) >= 1000) return 'R$ ' + (v / 1000).toFixed(1).replace('.', ',') + ' mil';
    return 'R$ ' + v.toFixed(0);
  }

  // ─── Calendário (flatpickr) ────────────────────────────────────────────────

  var coarsePointer = false;
  try {
    coarsePointer = window.matchMedia('(pointer: coarse)').matches;
  } catch {}

  function enhanceDates(root) {
    var list = root.querySelectorAll('input[data-picker]:not([data-picker-ready])');
    if (!list.length) return Promise.resolve();

    // Teclado nativo do celular é melhor e não tem custo de biblioteca.
    if (coarsePointer) {
      for (var i = 0; i < list.length; i++) list[i].setAttribute('data-picker-ready', '1');
      return Promise.resolve();
    }

    return Promise.all([
      loadStyle(VENDOR + 'flatpickr/flatpickr.min.css'),
      loadScript(VENDOR + 'flatpickr/flatpickr.min.js'),
    ])
      .then(function () {
        // O locale é opcional: se o arquivo falhar, o calendário continua em inglês.
        return loadScript(VENDOR + 'flatpickr/l10n/pt.js').catch(function () {});
      })
      .then(function () {
        list = root.querySelectorAll('input[data-picker]:not([data-picker-ready])');
        for (var i = 0; i < list.length; i++) {
          // `const` (e não `var`) para cada input guardar o PRÓPRIO `el`/`fp`: com `var`
          // todas as closures do loop apontariam para o último input da página.
          const el = list[i];
          if (el._flatpickr) {
            el.setAttribute('data-picker-ready', '1');
            continue;
          }
          el.setAttribute('data-picker-ready', '1');
          // O input type=date nativo mostra "dd/mm/aaaa"; ao virar texto, sem placeholder
          // ficaria uma caixa vazia sem pista do formato.
          if (!el.getAttribute('placeholder')) el.setAttribute('placeholder', 'dd/mm/aaaa');
          try {
            const opcoes = {
              locale: window.flatpickr.l10ns && window.flatpickr.l10ns.pt ? 'pt' : 'default',
              dateFormat: 'Y-m-d',
              allowInput: true,
              disableMobile: true,
              monthSelectorType: 'static',
              animate: !lite,
              // O Alpine escreve em `input.value` (atalhos de período, limpar filtros).
              // Ao abrir, o calendário relê o valor real para não mostrar o mês antigo.
              onOpen: function () {
                if (el.value) fp.setDate(el.value, false);
                else fp.clear(false);
              },
            };

            /*
              Input dentro de <dialog> (filtros de período) precisa do calendário DENTRO
              do diálogo: <dialog> vive na top layer e qualquer elemento anexado ao body
              fica atrás do backdrop. A posição é calculada em relação ao diálogo —
              as coordenadas de página do flatpickr errariam o alvo.
            */
            const host = el.closest ? el.closest('dialog') : null;
            if (host) {
              opcoes.appendTo = host;
              // <dialog> tem `overflow: auto` no padrão do navegador e cortaria o
              // calendário no rodapé. A classe libera só enquanto ele está aberto.
              opcoes.onClose = function () {
                host.classList.remove('kivo-fp-host');
              };
              // O flatpickr chama `position(instância, elemento)` — não passa o DOM do
              // calendário. O elemento de referência é o próprio input.
              opcoes.position = function (inst) {
                var cal = inst.calendarContainer;
                if (!cal) return;
                host.classList.add('kivo-fp-host');
                var r = el.getBoundingClientRect();
                var d = host.getBoundingClientRect();
                var altura = cal.offsetHeight || 320;
                var abaixo = r.bottom + 6 + altura <= window.innerHeight;
                var top = abaixo ? r.bottom - d.top + 6 : r.top - d.top - altura - 6;
                var left = r.left - d.left;
                left = Math.max(
                  8,
                  Math.min(left, window.innerWidth - cal.offsetWidth - 8 - d.left),
                );
                cal.style.left = left + 'px';
                cal.style.top = Math.max(8, top) + 'px';
                cal.classList.toggle('arrowTop', abaixo);
                cal.classList.toggle('arrowBottom', !abaixo);
              };
            }

            const fp = window.flatpickr(el, opcoes);
            el.addEventListener('change', function () {
              // Flatpickr já dispara change; o listener existe para leitores de tela e
              // para quem escreve no input sem passar pelo calendário.
              if (el.value === '' && fp.selectedDates.length) fp.clear(false);
            });
          } catch {
            // Input que a lib recusou continua nativo.
          }
        }
      })
      .catch(function () {
        // Sem o arquivo (instalação incompleta): o input nativo segue valendo.
      });
  }

  // ─── Select com busca (Tom Select) ─────────────────────────────────────────

  function normalizeValue(v) {
    return v == null ? '' : String(v);
  }

  function enhanceSelects(root) {
    var list = root.querySelectorAll('select[data-search]:not([data-select-ready])');
    if (!list.length) return Promise.resolve();

    return Promise.all([
      loadStyle(VENDOR + 'tom-select/tom-select.min.css'),
      loadScript(VENDOR + 'tom-select/tom-select.complete.min.js'),
    ])
      .then(function () {
        list = root.querySelectorAll('select[data-search]:not([data-select-ready])');
        for (var i = 0; i < list.length; i++) {
          // Mesmo motivo do calendário: `const` para cada select guardar o próprio `ts`.
          const el = list[i];
          if (el.tomselect) {
            el.setAttribute('data-select-ready', '1');
            continue;
          }
          el.setAttribute('data-select-ready', '1');
          try {
            const nativeValue = Object.getOwnPropertyDescriptor(
              HTMLSelectElement.prototype,
              'value',
            );
            const ts = new window.TomSelect(el, {
              maxItems: 1,
              create: false,
              closeAfterSelect: true,
              allowEmptyOption: true,
              placeholder: el.getAttribute('data-placeholder') || 'Buscar…',
              render: {
                no_results: function () {
                  return '<div class="ts-no-results">Nada encontrado</div>';
                },
              },
            });

            // Largura definida inline no <select> (ex.: filtro de auditoria com
            // max-width:200px) não é herdada pelo wrapper; sem isto o campo estica.
            if (el.style.maxWidth) ts.wrapper.style.maxWidth = el.style.maxWidth;
            if (el.style.width) ts.wrapper.style.width = el.style.width;
            // O select pode já nascer desabilitado (município esperando a UF).
            if (el.disabled) ts.disable();

            // O Alpine define `select.value` ao carregar dados. Sem espelhar no Tom Select,
            // o componente mostraria a opção anterior. O `fromTs` corta a recursão: o
            // próprio setValue do Tom Select escreve no select original.
            let fromTs = false;
            try {
              Object.defineProperty(el, 'value', {
                configurable: true,
                get: function () {
                  return nativeValue.get.call(el);
                },
                set: function (v) {
                  nativeValue.set.call(el, v);
                  if (fromTs) return;
                  var nv = normalizeValue(v);
                  if (ts.getValue() !== nv) {
                    fromTs = true;
                    try {
                      ts.setValue(nv, true);
                    } finally {
                      fromTs = false;
                    }
                  }
                },
              });
            } catch {
              /* navegador sem descritor: cai no sync por evento */
            }

            // Opções criadas depois (x-for) e disabled aplicado pelo Alpine. O observer é
            // desconectado durante o sync: o próprio Tom Select mexe no select, e sem isso
            // um sync dispararia o observer que chamaria sync de novo (loop travando a aba).
            let agendado = null;
            const mo = new MutationObserver(function () {
              if (agendado) return;
              agendado = setTimeout(function () {
                agendado = null;
                mo.disconnect();
                try {
                  if (typeof ts.sync === 'function') ts.sync();
                  if (el.disabled) ts.disable();
                  else ts.enable();
                } finally {
                  mo.observe(el, {
                    childList: true,
                    subtree: true,
                    attributes: true,
                    attributeFilter: ['disabled'],
                  });
                }
              }, 20);
            });
            mo.observe(el, {
              childList: true,
              subtree: true,
              attributes: true,
              attributeFilter: ['disabled'],
            });

            el.addEventListener('focus', function () {
              var nv = getCurrentSelectValue(el);
              if (ts.getValue() !== nv) ts.setValue(nv, true);
            });
          } catch {
            el.removeAttribute('data-select-ready');
          }
        }
      })
      .catch(function () {
        // Sem Tom Select: <select> nativo.
      });
  }

  function getCurrentSelectValue(el) {
    try {
      var d = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
      return normalizeValue(d.get.call(el));
    } catch {
      return normalizeValue(el.value);
    }
  }

  // ─── Tooltips (Floating UI) ────────────────────────────────────────────────

  var tipEl = null;
  var tipTarget = null;

  function ensureTooltip() {
    if (tipEl) return tipEl;
    tipEl = document.createElement('div');
    tipEl.className = 'kivo-tip';
    tipEl.setAttribute('role', 'tooltip');
    tipEl.hidden = true;
    document.body.appendChild(tipEl);
    return tipEl;
  }

  function showTip(target) {
    var text = target.getAttribute('data-tip');
    if (!text) return;
    tipTarget = target;
    var el = ensureTooltip();
    el.textContent = text;
    el.hidden = false;
    // O bundle DOM depende do core (middleware flip/shift/offset). Os dois UMD são
    // carregados em ordem; sem o core, `computePosition` estoura em detectOverflow.
    loadScript(VENDOR + 'floating-ui/floating-ui.core.umd.min.js')
      .then(function () {
        return loadScript(VENDOR + 'floating-ui/floating-ui.dom.umd.min.js');
      })
      .then(function () {
        var f = window.FloatingUIDOM;
        if (!f || tipTarget !== target) return;
        f.computePosition(target, el, {
          placement: target.getAttribute('data-tip-placement') || 'top',
          middleware: [f.offset(8), f.flip({ padding: 8 }), f.shift({ padding: 8 })],
        }).then(function (pos) {
          if (tipTarget !== target) return;
          el.style.left = pos.x + 'px';
          el.style.top = pos.y + 'px';
        });
      })
      .catch(function () {});
  }

  function hideTip() {
    tipTarget = null;
    if (tipEl) tipEl.hidden = true;
  }

  function bindTooltips() {
    document.addEventListener(
      'pointerover',
      function (e) {
        var t = e.target.closest ? e.target.closest('[data-tip]') : null;
        if (t) showTip(t);
      },
      { passive: true },
    );
    document.addEventListener(
      'pointerout',
      function (e) {
        var t = e.target.closest ? e.target.closest('[data-tip]') : null;
        if (t) hideTip();
      },
      { passive: true },
    );
    document.addEventListener('focusin', function (e) {
      var t = e.target.closest ? e.target.closest('[data-tip]') : null;
      if (t) showTip(t);
    });
    document.addEventListener('focusout', hideTip);
    window.addEventListener('scroll', hideTip, { passive: true });
  }

  // ─── Gráfico de evolução (uPlot) ───────────────────────────────────────────

  function renderTrend(el, buckets) {
    if (!el) return;
    var rows = Array.isArray(buckets) ? buckets : [];
    el._kivoTrendData = rows.slice();

    // Destrói antes de limpar o container: o uPlot guarda referências ao próprio DOM
    // (canvas/over). Limpar primeiro deixaria listeners e observers órfãos.
    if (el._kivoUplot) {
      try {
        el._kivoUplot.destroy();
      } catch {}
      el._kivoUplot = null;
    }
    el.textContent = '';

    if (!rows.length) {
      el.textContent = 'Sem vendas no período.';
      el.classList.add('kivo-chart-empty');
      return;
    }

    return Promise.all([
      loadStyle(VENDOR + 'uplot/uPlot.min.css'),
      loadScript(VENDOR + 'uplot/uPlot.iife.min.js'),
    ])
      .then(function () {
        if (!window.uPlot) return;
        el.classList.remove('kivo-chart-empty');

        var labels = rows.map(function (b) {
          return String(b.label || '');
        });
        var values = rows.map(function (b) {
          return Number(b.totalCents) || 0;
        });
        var xs = rows.map(function (_, i) {
          return i;
        });
        var max = Math.max.apply(null, values.concat([0]));
        if (max <= 0) {
          // Período sem venda: um gráfico plano com cinco "R$ 0" no eixo confunde mais
          // do que explica. Mostra o mesmo vazio das listas.
          el.textContent = 'Sem vendas no período.';
          el.classList.add('kivo-chart-empty');
          return;
        }
        var primary = cssVar('--primary', '#ff8000');
        var grid = cssVar('--border-light', 'rgba(0,0,0,.08)');
        var muted = cssVar('--text-muted', '#8a8a98');

        var tip = document.createElement('div');
        tip.className = 'kivo-chart-tip';
        tip.hidden = true;

        var tooltipPlugin = {
          hooks: {
            init: function (u) {
              u.over.appendChild(tip);
            },
            setCursor: function (u) {
              var idx = u.cursor.idx;
              if (idx == null || idx < 0 || idx >= labels.length) {
                tip.hidden = true;
                return;
              }
              tip.hidden = false;
              tip.textContent = labels[idx] + ' · ' + window.brl(values[idx]);
              var left = u.cursor.left || 0;
              var top = u.cursor.top || 0;
              tip.style.left = Math.max(4, Math.min(left + 10, el.clientWidth - 150)) + 'px';
              tip.style.top = Math.max(4, top - 30) + 'px';
            },
          },
        };

        var opts = {
          width: Math.max(240, el.clientWidth),
          height: 190,
          padding: [14, 10, 4, 4],
          legend: { show: false },
          cursor: { y: false, points: { size: 6 } },
          scales: {
            x: {
              time: false,
              range: function (u, min, maxi) {
                return [min - 0.7, maxi + 0.7];
              },
            },
            y: {
              range: function (u, min, maxi) {
                return [0, Math.max(maxi * 1.18, max > 0 ? max * 1.18 : 1)];
              },
            },
          },
          axes: [
            {
              stroke: muted,
              grid: { stroke: grid, width: 1 },
              ticks: { stroke: grid, width: 1 },
              font: '11px system-ui, sans-serif',
              splits: function (u) {
                var n = labels.length;
                var maxTicks = Math.max(2, Math.floor((u.width || 300) / 62));
                var step = Math.max(1, Math.ceil(n / maxTicks));
                var out = [];
                for (var i = 0; i < n; i += step) out.push(i);
                if (out[out.length - 1] !== n - 1) out.push(n - 1);
                return out;
              },
              values: function (u, splits) {
                return splits.map(function (i) {
                  return labels[Math.round(i)] || '';
                });
              },
            },
            {
              stroke: muted,
              grid: { stroke: grid, width: 1 },
              ticks: { stroke: grid, width: 1 },
              font: '11px system-ui, sans-serif',
              size: 62,
              values: function (u, splits) {
                return splits.map(function (v) {
                  return shortMoney(v);
                });
              },
            },
          ],
          series: [
            {},
            {
              label: 'Vendas',
              stroke: primary,
              // Só acrescenta alfa quando a variável é hex; tema personalizado pode
              // chegar em outro formato e continuaria válido sem transparência.
              fill: /^#[0-9a-f]{6}$/i.test(primary) ? primary + 'cc' : primary,
              width: 1,
              // Construtor oficial: devolve { stroke, fill } (um Path2D solto seria
              // ignorado pelo uPlot e as barras não apareceriam).
              paths: window.uPlot.paths.bars({ size: [0.62, 46], radius: [4, 0] }),
              points: { show: false },
            },
          ],
          plugins: [tooltipPlugin],
        };

        try {
          el._kivoUplot = new window.uPlot(opts, [xs, values], el);
        } catch {
          el.textContent = 'Não foi possível desenhar o gráfico.';
          el.classList.add('kivo-chart-empty');
          return;
        }

        // Recalcula na troca de tema (as cores saem das variáveis CSS) e no resize.
        if (!el._kivoResize) {
          var pending = null;
          el._kivoResize = new ResizeObserver(function () {
            if (pending) cancelAnimationFrame(pending);
            pending = requestAnimationFrame(function () {
              var u = el._kivoUplot;
              if (!u) return;
              u.setSize({ width: Math.max(240, el.clientWidth), height: 190 });
            });
          });
          el._kivoResize.observe(el);
        }
      })
      .catch(function () {
        el.textContent = 'Gráfico indisponível.';
        el.classList.add('kivo-chart-empty');
      });
  }

  // ─── SortableJS (usado por telas que precisam de arraste no toque) ─────────

  function sortable(el, options) {
    if (!el) return Promise.resolve(null);
    return loadScript(VENDOR + 'sortablejs/Sortable.min.js')
      .then(function () {
        if (!window.Sortable) return null;
        if (el._kivoSortable) {
          try {
            el._kivoSortable.destroy();
          } catch {}
        }
        el._kivoSortable = new window.Sortable(el, options || {});
        return el._kivoSortable;
      })
      .catch(function () {
        return null;
      });
  }

  // ─── Bootstrap ─────────────────────────────────────────────────────────────

  function enhanceAll(root) {
    root = root || document;
    enhanceDates(root);
    enhanceSelects(root);
  }

  function boot() {
    bindTooltips();
    enhanceAll(document);

    // Alpine cria/recria nós via x-for e x-if. O observer só reage a elementos que
    // contenham os atributos que nos interessam — evita reprocessar toda a página.
    var pending = null;
    var mo = new MutationObserver(function (mutations) {
      var relevant = false;
      for (var i = 0; i < mutations.length && !relevant; i++) {
        var nodes = mutations[i].addedNodes;
        for (var j = 0; j < nodes.length; j++) {
          var n = nodes[j];
          if (n.nodeType !== 1) continue;
          if (n.matches && n.matches('input[data-picker], select[data-search]')) {
            relevant = true;
            break;
          }
          if (n.querySelector && n.querySelector('input[data-picker], select[data-search]')) {
            relevant = true;
            break;
          }
        }
      }
      if (!relevant) return;
      if (pending) clearTimeout(pending);
      pending = setTimeout(function () {
        enhanceAll(document);
      }, 80);
    });
    mo.observe(document.body, { childList: true, subtree: true });

    // As cores do gráfico saem das variáveis CSS. Trocar de tema (claro/escuro) não
    // redesenha o canvas sozinho — refaz o gráfico com os dados já buscados.
    new MutationObserver(function () {
      var charts = document.querySelectorAll('.trend-chart');
      for (var i = 0; i < charts.length; i++) {
        if (charts[i]._kivoTrendData) renderTrend(charts[i], charts[i]._kivoTrendData);
      }
    }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  }

  window.KivoUI = {
    enhance: enhanceAll,
    sortable: sortable,
    trendChart: renderTrend,
    toDate: toDate,
    shortMoney: shortMoney,
    loadScript: loadScript,
    loadStyle: loadStyle,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
