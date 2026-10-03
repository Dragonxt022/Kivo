/**
 * Tour guiado do Kivo — spotlight com balões, sem dependência externa.
 *
 * Como funciona o "holofote": um retângulo posicionado exatamente sobre o elemento-alvo
 * recebe `box-shadow: 0 0 0 9999px <escuro>`, o que escurece tudo ao redor sem precisar
 * montar quatro painéis. Uma camada de captura em tela cheia bloqueia os cliques fora do
 * balão; o balão e seus botões ficam acima dela.
 *
 * Uso:
 *   KivoTour.start([{ el: '#botao', title: '...', body: '...' }], { onDone });
 *   KivoTour.autoStart('chave-localStorage', steps);
 *
 * `el` aceita seletor CSS ou o próprio elemento. Passos cujo alvo não existe na hora são
 * pulados — assim o mesmo tour serve para quem tem ou não permissão, e para lista vazia.
 *
 * O visual vem dos tokens do tema (ver a seção "Tour guiado" em app.css), então o modo leve
 * desliga transição e sombra sozinho, e `prefers-reduced-motion` também é respeitado.
 */
(function () {
  'use strict';

  var root = null;
  var ultimaLista = null;
  var celebraOpts = null;
  var cartaoFinal = null;
  var mask = null;
  var pop = null;
  var steps = [];
  var index = 0;
  var onDone = null;
  var moveHandler = null;
  var renderTimer = null;

  function el(ref) {
    if (!ref) return null;
    return typeof ref === 'string' ? document.querySelector(ref) : ref;
  }

  function reduced() {
    return (
      window.matchMedia('(prefers-reduced-motion: reduce)').matches ||
      document.documentElement.getAttribute('data-lite') === '1'
    );
  }

  function build() {
    root = document.createElement('div');
    root.className = 'kivo-tour';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-label', 'Tour guiado');

    var capture = document.createElement('div');
    capture.className = 'kivo-tour-capture';

    mask = document.createElement('div');
    mask.className = 'kivo-tour-mask';

    pop = document.createElement('div');
    pop.className = 'kivo-tour-pop';

    pop.addEventListener('click', function (e) {
      var b = e.target.closest('[data-tour]');
      if (!b) return;
      var acao = b.getAttribute('data-tour');
      if (acao === 'skip') finish('skip');
      else if (acao === 'prev') prev();
      else if (acao === 'next') next();
    });

    root.appendChild(capture);
    root.appendChild(mask);
    root.appendChild(pop);
    document.body.appendChild(root);
  }

  function fill(step) {
    var total = steps.length;
    var ultimo = index === total - 1;
    var primeiro = index === 0;
    pop.innerHTML =
      '<div class="kivo-tour-count"></div>' +
      '<h3 class="kivo-tour-title"></h3>' +
      '<p class="kivo-tour-body"></p>' +
      '<div class="kivo-tour-progress"><i></i></div>' +
      '<div class="kivo-tour-actions">' +
      '<button type="button" class="btn secondary small" data-tour="skip">Pular</button>' +
      '<span class="kivo-tour-spacer"></span>' +
      (primeiro ? '' : '<button type="button" class="btn secondary small" data-tour="prev">Anterior</button>') +
      '<button type="button" class="btn small" data-tour="next">' +
      (ultimo ? 'Concluir 🎉' : 'Próximo') +
      '</button>' +
      '</div>';
    pop.querySelector('.kivo-tour-count').textContent = 'Passo ' + (index + 1) + ' de ' + total;
    pop.querySelector('.kivo-tour-title').textContent = step.title || '';
    pop.querySelector('.kivo-tour-body').textContent = step.body || '';
    // Barra de progresso: mostra o quanto falta, sem precisar ler o contador.
    var barra = pop.querySelector('.kivo-tour-progress > i');
    if (barra) barra.style.width = Math.round(((index + 1) / total) * 100) + '%';
    // Reanima a entrada do balão a cada passo (a classe é removida e recolocada no próximo frame).
    pop.classList.remove('kivo-tour-pop--in');
    void pop.offsetWidth;
    if (!reduced()) pop.classList.add('kivo-tour-pop--in');
    var primario = pop.querySelector('[data-tour="next"]');
    if (primario) primario.focus();
  }

  function position(target) {
    var r = target.getBoundingClientRect();
    var pad = 6;
    var top = Math.max(0, r.top - pad);
    var left = Math.max(0, r.left - pad);
    var width = Math.max(0, Math.min(window.innerWidth - left, r.width + pad * 2));
    var height = Math.max(0, Math.min(window.innerHeight - top, r.height + pad * 2));
    mask.style.top = top + 'px';
    mask.style.left = left + 'px';
    mask.style.width = width + 'px';
    mask.style.height = height + 'px';

    var gap = 14;
    var pw = pop.offsetWidth;
    var ph = pop.offsetHeight;
    var abaixo = window.innerHeight - r.bottom >= ph + gap || r.top < ph + gap;
    var pt = abaixo ? r.bottom + gap : r.top - gap - ph;
    var pl = r.left + r.width / 2 - pw / 2;
    pt = Math.max(12, Math.min(window.innerHeight - ph - 12, pt));
    pl = Math.max(12, Math.min(window.innerWidth - pw - 12, pl));
    pop.style.top = pt + 'px';
    pop.style.left = pl + 'px';
    pop.classList.toggle('kivo-tour-pop--acima', !abaixo);
  }

  function render() {
    clearTimeout(renderTimer);
    var step;
    var target;
    // Alvos dinâmicos (linha de tabela, botão sem permissão): pula os que não existem.
    while (index < steps.length) {
      step = steps[index];
      target = el(step.el);
      if (target) break;
      index++;
    }
    if (!target || index >= steps.length) {
      finish('finish');
      return;
    }
    try {
      target.scrollIntoView({ block: 'center', inline: 'nearest', behavior: reduced() ? 'auto' : 'smooth' });
    } catch {
      target.scrollIntoView();
    }
    // Espera o scroll suave terminar antes de medir o alvo, senão o holofote sai do lugar.
    renderTimer = setTimeout(
      function () {
        fill(step);
        position(target);
        root.classList.add('kivo-tour--pronto');
      },
      reduced() ? 0 : 280,
    );
  }

  function next() {
    if (index < steps.length - 1) {
      index++;
      render();
    } else {
      finish('finish');
    }
  }

  function prev() {
    var i = index - 1;
    while (i >= 0 && !el(steps[i].el)) i--;
    if (i >= 0) {
      index = i;
      render();
    }
  }

  function onKey(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      finish('esc');
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      next();
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      prev();
    }
  }

  function reposicionar() {
    var step = steps[index];
    var target = step && el(step.el);
    if (target) position(target);
  }

  function finish(reason) {
    clearTimeout(renderTimer);
    document.removeEventListener('keydown', onKey, true);
    if (moveHandler) {
      window.removeEventListener('resize', moveHandler);
      window.removeEventListener('scroll', moveHandler, true);
    }
    if (root && root.parentNode) root.parentNode.removeChild(root);
    root = mask = pop = null;
    var cb = onDone;
    var celebrar = reason === 'finish';
    var lista = ultimaLista;
    var cfg = celebraOpts;
    steps = [];
    index = 0;
    onDone = null;
    moveHandler = null;
    if (cb) {
      try {
        cb(reason);
      } catch {
        // O callback não pode travar a limpeza da tela.
      }
    }
    // Terminou o tutorial inteiro (não pulou): comemora. Pular não merece confete.
    if (celebrar) parabenizar(lista, cfg);
  }

  /** Fim do tutorial: confete + cartão de parabéns, com opção de rever. */
  function parabenizar(lista, cfg) {
    cfg = cfg || {};
    limparFinal();
    var final = document.createElement('div');
    final.className = 'kivo-tour-final';
    final.innerHTML =
      '<div class="kivo-tour-final-emoji">' + (cfg.emoji || '🎉') + '</div>' +
      '<h3></h3><p></p>' +
      '<div class="kivo-tour-actions">' +
      '<button type="button" class="btn secondary small" data-final="close">Fechar</button>' +
      '<button type="button" class="btn small" data-final="again">Ver de novo</button>' +
      '</div>';
    final.querySelector('h3').textContent = cfg.title || 'Tutorial concluído!';
    final.querySelector('p').textContent = cfg.body
      || 'Pronto: você já conhece esta parte do Kivo. O tutorial fica disponível no botão "Rever tutorial".';
    final.addEventListener('click', function (e) {
      var b = e.target.closest('[data-final]');
      if (!b) return;
      var acao = b.getAttribute('data-final');
      limparFinal();
      if (acao === 'again' && lista && lista.length) start(lista, { celebrate: cfg });
    });
    document.body.appendChild(final);
    cartaoFinal = final;
    // Escape fecha o cartão de parabéns (o ouvinte do tour já foi removido no finish).
    function escFinal(e) {
      if (e.key === 'Escape') {
        document.removeEventListener('keydown', escFinal, true);
        limparFinal();
      }
    }
    document.addEventListener('keydown', escFinal, true);
    soltarConfete(cfg);
  }

  function limparFinal() {
    if (cartaoFinal && cartaoFinal.parentNode) cartaoFinal.parentNode.removeChild(cartaoFinal);
    cartaoFinal = null;
    var c = document.querySelector('.kivo-tour-confetti');
    if (c && c.parentNode) c.parentNode.removeChild(c);
  }

  /**
   * Confete em canvas, sem biblioteca: partículas com gravidade, giro e cores do tema.
   * Sai cedo (sem animar) para quem pediu menos movimento.
   */
  function soltarConfete(cfg) {
    if (reduced()) return;
    var canvas = document.createElement('canvas');
    canvas.className = 'kivo-tour-confetti';
    document.body.appendChild(canvas);
    var ctx = canvas.getContext('2d');
    if (!ctx) return;
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    function medir() {
      canvas.width = window.innerWidth * dpr;
      canvas.height = window.innerHeight * dpr;
      canvas.style.width = window.innerWidth + 'px';
      canvas.style.height = window.innerHeight + 'px';
    }
    medir();
    var tokens = getComputedStyle(document.documentElement);
    var cores = ['--primary', '--success', '--warning', '--info', '--danger']
      .map(function (t) { return tokens.getPropertyValue(t).trim(); })
      .filter(Boolean);
    if (!cores.length) cores = ['#f97316', '#22c55e', '#3b82f6', '#eab308'];
    // Confete caindo do alto: duas "explosões" dão sensação de festa sem poluir.
    var pecas = [];
    function explodir(qtd, origemX) {
      for (var i = 0; i < qtd; i++) {
        pecas.push({
          x: (origemX === undefined ? Math.random() * canvas.width : origemX + (Math.random() - 0.5) * 160 * dpr),
          y: -20 * dpr - Math.random() * 80 * dpr,
          vx: (Math.random() - 0.5) * 2.2 * dpr,
          vy: (1.6 + Math.random() * 2.4) * dpr,
          w: (5 + Math.random() * 6) * dpr,
          h: (8 + Math.random() * 8) * dpr,
          cor: cores[Math.floor(Math.random() * cores.length)],
          giro: Math.random() * Math.PI * 2,
          vGiro: (Math.random() - 0.5) * 0.22,
          onda: Math.random() * Math.PI * 2,
        });
      }
    }
    explodir(150);
    var inicio = performance.now();
    var fim = inicio + (cfg.duracao || 2600);
    function quadro(agora) {
      if (!canvas.parentNode) return;
      var t = agora - inicio;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (t > 900 && t < 1000) explodir(60, canvas.width * 0.5);
      var restantes = 0;
      for (var i = 0; i < pecas.length; i++) {
        var p = pecas[i];
        p.onda += 0.08;
        p.x += p.vx + Math.sin(p.onda) * 1.1 * dpr;
        p.y += p.vy;
        p.vy += 0.035 * dpr;
        p.giro += p.vGiro;
        if (p.y < canvas.height + 40 * dpr) restantes++;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.giro);
        ctx.fillStyle = p.cor;
        ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        ctx.restore();
      }
      if (restantes > 0 && agora < fim) requestAnimationFrame(quadro);
      else if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
    }
    requestAnimationFrame(quadro);
    window.addEventListener('resize', medir, { once: true });
  }

  function start(list, options) {
    if (root) return;
    var validos = (list || []).filter(function (s) {
      return s && s.el;
    });
    if (!validos.length) return;
    steps = validos;
    // Guarda a lista e a celebração: "Ver de novo" no cartão de parabéns reusa as duas.
    ultimaLista = validos.slice();
    index = 0;
    options = options || {};
    celebraOpts = options.celebrate || null;
    onDone = typeof options.onDone === 'function' ? options.onDone : null;
    build();
    document.addEventListener('keydown', onKey, true);
    moveHandler = function () {
      if (moveHandler._raf) return;
      moveHandler._raf = requestAnimationFrame(function () {
        moveHandler._raf = 0;
        reposicionar();
      });
    };
    window.addEventListener('resize', moveHandler);
    window.addEventListener('scroll', moveHandler, true);
    render();
  }

  /** Mostra uma vez por máquina; grava a chave quando o tour termina OU é pulado. */
  function autoStart(key, list, options) {
    try {
      if (localStorage.getItem(key) === '1') return false;
    } catch {
      // Sem localStorage: mostra sempre, é melhor que não mostrar.
    }
    options = options || {};
    start(list, {
      celebrate: options.celebrate,
      onDone: function (reason) {
        try {
          localStorage.setItem(key, '1');
        } catch {
          // segue
        }
        if (typeof options.onDone === 'function') options.onDone(reason);
      },
    });
    return true;
  }

  window.KivoTour = {
    start: start,
    autoStart: autoStart,
    celebrate: function (cfg) {
      parabenizar(ultimaLista, cfg);
    },
    isActive: function () {
      return !!root;
    },
  };
})();
