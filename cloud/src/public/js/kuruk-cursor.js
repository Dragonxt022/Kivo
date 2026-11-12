/*
 * Cursor personalizado do site Kuruk.
 *
 * Um ponto laranja segue o mouse de perto e um anel acompanha com atraso,
 * crescendo sobre links, botões, cards e nas letras do nome "Kuruk".
 * É decorativo: não captura clique, não aparece em touch e respeita
 * "reduzir animações". Se o JS falhar ou o navegador não tiver ponteiro fino,
 * o cursor normal continua funcionando.
 */
(function () {
  var root = document.documentElement;
  var finePointer =
    window.matchMedia && window.matchMedia('(hover: hover) and (pointer: fine)').matches;
  var prefersReduced =
    window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  if (!finePointer || prefersReduced) return;

  var dot = document.createElement('div');
  var ring = document.createElement('div');
  dot.className = 'kuruk-cursor-dot';
  ring.className = 'kuruk-cursor-ring';
  dot.setAttribute('aria-hidden', 'true');
  ring.setAttribute('aria-hidden', 'true');
  document.body.appendChild(dot);
  document.body.appendChild(ring);

  var mouse = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
  var dotPos = { x: mouse.x, y: mouse.y };
  var ringPos = { x: mouse.x, y: mouse.y };
  var ready = false;
  var raf = null;

  var interactiveSelector =
    'a, button, .product-card, .brand-letter, [role="button"], summary, input, textarea, select';

  function draw() {
    raf = null;
    dotPos.x += (mouse.x - dotPos.x) * 0.35;
    dotPos.y += (mouse.y - dotPos.y) * 0.35;
    ringPos.x += (mouse.x - ringPos.x) * 0.15;
    ringPos.y += (mouse.y - ringPos.y) * 0.15;

    dot.style.transform =
      'translate3d(' + dotPos.x + 'px,' + dotPos.y + 'px,0) translate(-50%,-50%)';
    ring.style.transform =
      'translate3d(' + ringPos.x + 'px,' + ringPos.y + 'px,0) translate(-50%,-50%)';

    // Continua enquanto houver diferença perceptível; parado, não gasta frame.
    if (
      Math.abs(mouse.x - dotPos.x) > 0.1 ||
      Math.abs(mouse.y - dotPos.y) > 0.1 ||
      Math.abs(mouse.x - ringPos.x) > 0.1 ||
      Math.abs(mouse.y - ringPos.y) > 0.1
    ) {
      raf = window.requestAnimationFrame(draw);
    }
  }

  function onMove(event) {
    mouse.x = event.clientX;
    mouse.y = event.clientY;
    if (!ready) {
      ready = true;
      dotPos.x = mouse.x;
      dotPos.y = mouse.y;
      ringPos.x = mouse.x;
      ringPos.y = mouse.y;
      root.classList.add('kuruk-cursor-on');
    }
    if (!raf) raf = window.requestAnimationFrame(draw);
  }

  function onOver(event) {
    if (!(event.target instanceof Element)) return;
    var hit = event.target.closest(interactiveSelector);
    var isTextField =
      hit && /^(INPUT|TEXTAREA|SELECT)$/.test(hit.tagName.toUpperCase());
    root.classList.toggle('kuruk-cursor-hover', Boolean(hit) && !isTextField);
  }

  document.addEventListener('pointermove', onMove, { passive: true });
  document.addEventListener('pointerover', onOver, { passive: true });
  document.addEventListener('pointerdown', function () {
    root.classList.add('kuruk-cursor-down');
  });
  document.addEventListener('pointerup', function () {
    root.classList.remove('kuruk-cursor-down');
  });
  document.addEventListener('mouseleave', function () {
    root.classList.remove('kuruk-cursor-on', 'kuruk-cursor-hover', 'kuruk-cursor-down');
    ready = false;
  });
})();
