/**
 * Calculadora do Kivo — ferramenta rápida, disponível em qualquer tela.
 *
 * Vanilla de propósito, e não um componente Alpine: ela é aberta de dentro de escopos
 * Alpine diferentes (o PDV, o formulário de produto) e às vezes de dentro de um <dialog>
 * que já está aberto. Um `x-data` próprio herdaria o escopo de quem a incluiu e o
 * `x-model` do campo de destino ficaria fora de alcance — enquanto uma função global
 * recebendo um callback funciona igual de qualquer lugar.
 *
 * Uso:
 *   abrirCalculadora()                                  // calculadora comum
 *   abrirCalculadora({ modo: 'margem', custo: 12.5, preco: 25,
 *                      onAplicar: (reais) => ... })     // preço a partir da margem
 *
 * Sobre a definição de MARGEM: aqui ela é sobre o PREÇO DE VENDA — (preço−custo)/preço —
 * a mesma conta do rótulo "Margem: ..." que o cadastro de produto já mostra embaixo dos
 * campos. Usar markup sobre o custo daria um número diferente do que a tela ao lado exibe
 * para o mesmo produto, e o lojista não teria como saber qual dos dois está certo. O
 * markup aparece junto, como linha secundária, porque muita gente pensa por ele.
 */
(function () {
  'use strict';

  var dlg = null;
  var estado = {
    modo: 'livre',
    expressao: '',
    // Última expressão resolvida, mostrada pequena acima do visor.
    historico: '',
    custo: '',
    preco: '',
    margem: '',
    // Qual campo o lojista está calculando a partir dos outros dois.
    alvo: 'preco',
    onAplicar: null,
  };

  // ── Números no padrão brasileiro ─────────────────────────────────────────────
  function paraNumero(txt) {
    var n = Number(String(txt == null ? '' : txt).replace(/\./g, '').replace(',', '.'));
    return isFinite(n) ? n : 0;
  }
  function formatar(n) {
    if (!isFinite(n)) return '—';
    return n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  /**
   * Avalia a expressão do visor sem `eval`: um interpretador pequeno é menos código do que
   * as salvaguardas que `eval` exigiria, e não abre a porta para executar o que estiver
   * colado na área de transferência.
   */
  function calcular(expr) {
    var limpa = String(expr).replace(/\s+/g, '').replace(/×/g, '*').replace(/÷/g, '/').replace(/,/g, '.');
    if (!limpa) return null;
    if (!/^[0-9+\-*/.()%]+$/.test(limpa)) return null;

    var pos = 0;
    function espiar() { return limpa[pos]; }
    function numero() {
      var ini = pos;
      if (espiar() === '-' || espiar() === '+') pos++;
      while (pos < limpa.length && /[0-9.]/.test(limpa[pos])) pos++;
      if (pos === ini) return NaN;
      return parseFloat(limpa.slice(ini, pos));
    }
    function fator() {
      if (espiar() === '(') {
        pos++;
        var v = soma();
        if (espiar() === ')') pos++;
        return v;
      }
      return numero();
    }
    function produto() {
      var v = fator();
      while (pos < limpa.length) {
        var op = espiar();
        if (op === '*' || op === '/') {
          pos++;
          var d = fator();
          v = op === '*' ? v * d : d === 0 ? NaN : v / d;
        } else if (op === '%') {
          // "50%" vira 0,5 — o uso comum é multiplicar/dividir por uma porcentagem.
          pos++;
          v = v / 100;
        } else break;
      }
      return v;
    }
    function soma() {
      var v = produto();
      while (pos < limpa.length && (espiar() === '+' || espiar() === '-')) {
        var op = limpa[pos++];
        var d = produto();
        v = op === '+' ? v + d : v - d;
      }
      return v;
    }
    var r = soma();
    if (pos !== limpa.length || !isFinite(r)) return null;
    return r;
  }

  // ── Modo margem ──────────────────────────────────────────────────────────────
  /** Resolve o campo escolhido em `alvo` a partir dos outros dois. */
  function resolverMargem() {
    var custo = paraNumero(estado.custo);
    var preco = paraNumero(estado.preco);
    var margem = paraNumero(estado.margem);

    if (estado.alvo === 'preco') {
      // margem sobre o preço: preço = custo / (1 − margem/100)
      if (custo <= 0 || margem >= 100) return null;
      return { campo: 'preco', valor: custo / (1 - margem / 100) };
    }
    if (estado.alvo === 'margem') {
      if (preco <= 0 || custo <= 0) return null;
      return { campo: 'margem', valor: ((preco - custo) / preco) * 100 };
    }
    // alvo === 'custo'
    if (preco <= 0 || margem >= 100) return null;
    return { campo: 'custo', valor: preco * (1 - margem / 100) };
  }

  function markupDe(custo, preco) {
    if (custo <= 0 || preco <= 0) return null;
    return ((preco - custo) / custo) * 100;
  }

  // ── Renderização ─────────────────────────────────────────────────────────────
  var TECLAS = [
    ['C', '⌫', '%', '÷'],
    ['7', '8', '9', '×'],
    ['4', '5', '6', '−'],
    ['1', '2', '3', '+'],
    ['0', '00', ',', '='],
  ];

  function garantirDialogo() {
    if (dlg) return dlg;
    dlg = document.createElement('dialog');
    dlg.className = 'calc-dialog';
    dlg.setAttribute('aria-label', 'Calculadora');
    document.body.appendChild(dlg);

    dlg.addEventListener('click', function (e) {
      var b = e.target.closest('[data-calc]');
      if (!b) return;
      acao(b.getAttribute('data-calc'));
    });
    dlg.addEventListener('input', function (e) {
      var campo = e.target.getAttribute('data-campo');
      if (!campo) return;
      estado[campo] = e.target.value;
      atualizarResultado();
    });
    dlg.addEventListener('keydown', function (e) {
      if (estado.modo !== 'livre') return;
      // Teclado físico no modo livre: é uma calculadora, digitar tem de funcionar.
      if (/^[0-9]$/.test(e.key)) { e.preventDefault(); acao(e.key); return; }
      var mapa = { '+': '+', '-': '−', '*': '×', '/': '÷', ',': ',', '.': ',', '%': '%' };
      if (mapa[e.key]) { e.preventDefault(); acao(mapa[e.key]); return; }
      if (e.key === 'Enter' || e.key === '=') { e.preventDefault(); acao('='); return; }
      if (e.key === 'Backspace') { e.preventDefault(); acao('⌫'); return; }
      if (e.key === 'Delete') { e.preventDefault(); acao('C'); return; }
    });
    return dlg;
  }

  function htmlTeclado() {
    return TECLAS.map(function (linha) {
      return (
        '<div class="calc-row">' +
        linha
          .map(function (t) {
            var cls = 'calc-key';
            if ('÷×−+='.indexOf(t) !== -1) cls += ' op';
            if (t === 'C' || t === '⌫') cls += ' aux';
            if (t === '=') cls += ' igual';
            return '<button type="button" class="' + cls + '" data-calc="' + t + '">' + t + '</button>';
          })
          .join('') +
        '</div>'
      );
    }).join('');
  }

  function htmlMargem() {
    var alvos = [
      { id: 'preco', label: 'Preço de venda' },
      { id: 'margem', label: 'Margem (%)' },
      { id: 'custo', label: 'Custo' },
    ];
    return (
      '<p class="calc-margem-intro">O que você quer descobrir?</p>' +
      '<div class="calc-alvos">' +
      alvos
        .map(function (a) {
          return (
            '<button type="button" class="calc-alvo' + (estado.alvo === a.id ? ' selected' : '') +
            '" data-calc="alvo:' + a.id + '">' + a.label + '</button>'
          );
        })
        .join('') +
      '</div>' +
      campoMargem('custo', 'Custo (R$)', estado.alvo === 'custo') +
      campoMargem('margem', 'Margem sobre o preço (%)', estado.alvo === 'margem') +
      campoMargem('preco', 'Preço de venda (R$)', estado.alvo === 'preco') +
      '<div class="calc-resultado" data-resultado></div>'
    );
  }

  function campoMargem(id, label, ehAlvo) {
    return (
      '<label class="calc-campo' + (ehAlvo ? ' alvo' : '') + '">' +
      '<span>' + label + (ehAlvo ? ' <em>— calculado</em>' : '') + '</span>' +
      '<input type="text" inputmode="decimal" data-campo="' + id + '"' +
      (ehAlvo ? ' readonly tabindex="-1"' : '') +
      ' value="' + String(estado[id] || '').replace(/"/g, '&quot;') + '" placeholder="0,00" />' +
      '</label>'
    );
  }

  function render() {
    var d = garantirDialogo();
    d.innerHTML =
      '<div class="calc-head">' +
      '<h1>Calculadora</h1>' +
      '<div class="calc-modos">' +
      '<button type="button" class="calc-modo' + (estado.modo === 'livre' ? ' selected' : '') + '" data-calc="modo:livre">Livre</button>' +
      '<button type="button" class="calc-modo' + (estado.modo === 'margem' ? ' selected' : '') + '" data-calc="modo:margem">Margem de lucro</button>' +
      '</div>' +
      '</div>' +
      (estado.modo === 'livre'
        ? '<div class="calc-visor"><span class="calc-historico" data-historico></span>' +
          '<span class="calc-valor" data-visor>0</span></div>' +
          '<div class="calc-teclado">' + htmlTeclado() + '</div>'
        : '<div class="calc-margem">' + htmlMargem() + '</div>') +
      '<div class="actions">' +
      '<button type="button" class="btn secondary" data-calc="fechar">Fechar</button>' +
      (estado.onAplicar
        ? '<button type="button" class="btn" data-calc="aplicar" data-aplicar>Usar este valor</button>'
        : '') +
      '</div>';
    atualizarResultado();
  }

  function atualizarResultado() {
    if (!dlg) return;
    var btn = dlg.querySelector('[data-aplicar]');

    if (estado.modo === 'livre') {
      var visor = dlg.querySelector('[data-visor]');
      var hist = dlg.querySelector('[data-historico]');
      if (visor) visor.textContent = estado.expressao || '0';
      if (hist) hist.textContent = estado.historico;
      if (btn) btn.disabled = calcular(estado.expressao) === null && !estado.expressao;
      return;
    }

    var alvo = dlg.querySelector('[data-resultado]');
    var r = resolverMargem();
    if (!alvo) return;
    if (!r) {
      alvo.innerHTML = '<span class="calc-resultado-vazio">Preencha os outros dois campos para calcular.</span>';
      if (btn) btn.disabled = true;
      return;
    }

    // Espelha o valor calculado no campo correspondente, para o lojista ler o número no
    // lugar onde ele já estava olhando.
    var input = dlg.querySelector('[data-campo="' + r.campo + '"]');
    var texto = r.campo === 'margem'
      ? String(Math.round(r.valor * 10) / 10).replace('.', ',')
      : formatar(r.valor);
    if (input) input.value = texto;
    estado[r.campo] = texto;

    var custo = paraNumero(estado.custo);
    var preco = paraNumero(estado.preco);
    var lucro = preco - custo;
    var mk = markupDe(custo, preco);
    alvo.innerHTML =
      '<div class="calc-resultado-linha"><span>' +
      (r.campo === 'margem' ? 'Margem' : r.campo === 'custo' ? 'Custo' : 'Preço de venda') +
      '</span><strong>' + (r.campo === 'margem' ? texto + '%' : 'R$ ' + texto) + '</strong></div>' +
      (lucro > 0
        ? '<div class="calc-resultado-linha sub"><span>Lucro por unidade</span><span>R$ ' + formatar(lucro) + '</span></div>'
        : '') +
      (mk != null && isFinite(mk)
        ? '<div class="calc-resultado-linha sub"><span>Equivale a markup sobre o custo</span><span>' +
          String(Math.round(mk * 10) / 10).replace('.', ',') + '%</span></div>'
        : '');
    if (btn) btn.disabled = false;
  }

  function acao(tecla) {
    if (tecla === 'fechar') { dlg.close(); return; }

    if (tecla.indexOf('modo:') === 0) {
      estado.modo = tecla.slice(5);
      render();
      return;
    }
    if (tecla.indexOf('alvo:') === 0) {
      estado.alvo = tecla.slice(5);
      render();
      return;
    }
    if (tecla === 'aplicar') { aplicar(); return; }

    // ── teclado da calculadora livre ──
    if (tecla === 'C') { estado.expressao = ''; estado.historico = ''; }
    else if (tecla === '⌫') { estado.expressao = estado.expressao.slice(0, -1); }
    else if (tecla === '=') {
      var r = calcular(estado.expressao);
      if (r === null) { estado.historico = 'expressão inválida'; }
      else {
        estado.historico = estado.expressao + ' =';
        estado.expressao = formatar(r);
      }
    } else {
      // Depois de um "=", digitar número recomeça; digitar operador continua da conta.
      if (estado.historico && estado.historico.indexOf('=') !== -1 && /[0-9]/.test(tecla)) {
        estado.expressao = '';
        estado.historico = '';
      }
      estado.expressao += tecla;
    }
    atualizarResultado();
  }

  function aplicar() {
    if (!estado.onAplicar) return;
    var valor;
    if (estado.modo === 'livre') {
      var r = calcular(estado.expressao);
      valor = r === null ? paraNumero(estado.expressao) : r;
    } else {
      var m = resolverMargem();
      if (!m) return;
      valor = m.campo === 'margem' ? m.valor : paraNumero(estado[m.campo]);
    }
    var cb = estado.onAplicar;
    dlg.close();
    cb(valor, estado.modo === 'margem' ? estado.alvo : 'livre');
  }

  /**
   * @param {object} [opts]
   * @param {'livre'|'margem'} [opts.modo]
   * @param {number|string} [opts.custo]  valor inicial em reais
   * @param {number|string} [opts.preco]  valor inicial em reais
   * @param {(valor:number, campo:string)=>void} [opts.onAplicar] recebe o valor escolhido
   */
  window.abrirCalculadora = function (opts) {
    opts = opts || {};
    var comoTexto = function (v) {
      if (v == null || v === '') return '';
      return typeof v === 'number' ? formatar(v) : String(v);
    };
    estado.modo = opts.modo === 'margem' ? 'margem' : 'livre';
    estado.expressao = '';
    estado.historico = '';
    estado.custo = comoTexto(opts.custo);
    estado.preco = comoTexto(opts.preco);
    estado.margem = '';
    // Com custo já preenchido, o que falta descobrir quase sempre é o preço; com preço e
    // custo preenchidos, o que interessa é a margem que isso dá.
    estado.alvo = paraNumero(estado.custo) > 0 && paraNumero(estado.preco) > 0 ? 'margem' : 'preco';
    estado.onAplicar = typeof opts.onAplicar === 'function' ? opts.onAplicar : null;
    render();
    dlg.showModal();
    var primeiro = dlg.querySelector('input:not([readonly])');
    if (primeiro) primeiro.focus();
    else dlg.focus();
  };
})();
