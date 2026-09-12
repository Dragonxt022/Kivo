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
      '<div class="kivo-tour-actions">' +
      '<button type="button" class="btn secondary small" data-tour="skip">Pular</button>' +
      '<span class="kivo-tour-spacer"></span>' +
      (primeiro ? '' : '<button type="button" class="btn secondary small" data-tour="prev">Anterior</button>') +
      '<button type="button" class="btn small" data-tour="next">' +
      (ultimo ? 'Concluir' : 'Próximo') +
      '</button>' +
      '</div>';
    pop.querySelector('.kivo-tour-count').textContent = 'Passo ' + (index + 1) + ' de ' + total;
    pop.querySelector('.kivo-tour-title').textContent = step.title || '';
    pop.querySelector('.kivo-tour-body').textContent = step.body || '';
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
  }

  function start(list, options) {
    if (root) return;
    var validos = (list || []).filter(function (s) {
      return s && s.el;
    });
    if (!validos.length) return;
    steps = validos;
    index = 0;
    options = options || {};
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
    start(list, {
      onDone: function (reason) {
        try {
          localStorage.setItem(key, '1');
        } catch {
          // segue
        }
        if (options && typeof options.onDone === 'function') options.onDone(reason);
      },
    });
    return true;
  }

  window.KivoTour = {
    start: start,
    autoStart: autoStart,
    isActive: function () {
      return !!root;
    },
  };
})();
