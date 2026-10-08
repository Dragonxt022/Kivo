/*
 * Motion das seções do site (GSAP).
 *
 * - `[data-reveal]`: o próprio elemento entra (fade + subida) quando aparece.
 * - `[data-reveal-children]`: os filhos entram em cascata.
 * - `[data-motion-media]` (o `.tilt-stage` de cada screenshot): a moldura entra
 *   em profundidade e, depois, flutua e segue o mouse com tilt 3D.
 *
 * Só roda quando o GSAP carregou e o usuário não pediu "reduzir animações"; em
 * qualquer outro caso remove a classe que esconde os alvos (nada fica invisível).
 */
(function () {
  var root = document.documentElement;
  var gsap = window.gsap;
  var prefersReduced =
    window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function bail() {
    root.classList.remove('motion-js');
  }

  if (!gsap || prefersReduced) {
    bail();
    return;
  }

  var finePointer =
    window.matchMedia && window.matchMedia('(hover: hover) and (pointer: fine)').matches;

  var io = new IntersectionObserver(
    function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        var el = entry.target;
        io.unobserve(el);
        if (el.hasAttribute('data-motion-media')) {
          revealMedia(el);
        } else if (el.hasAttribute('data-reveal-children')) {
          gsap.to(el.children, {
            opacity: 1,
            y: 0,
            duration: 0.6,
            ease: 'power3.out',
            stagger: 0.08,
          });
        } else {
          gsap.to(el, { opacity: 1, y: 0, duration: 0.7, ease: 'power3.out' });
        }
      });
    },
    { rootMargin: '0px 0px -8% 0px', threshold: 0.08 },
  );

  // Estado inicial escondido + observação de cada alvo. Feito antes de soltar a
  // classe `.motion-js`, então não há piscada do conteúdo.
  document.querySelectorAll('[data-reveal]').forEach(function (el) {
    gsap.set(el, { opacity: 0, y: 22 });
    io.observe(el);
  });

  document.querySelectorAll('[data-reveal-children]').forEach(function (el) {
    if (el.children.length) {
      gsap.set(el.children, { opacity: 0, y: 22 });
      io.observe(el);
    }
  });

  document.querySelectorAll('[data-motion-media]').forEach(function (stage) {
    var frame = stage.querySelector('.shot-frame');
    if (!frame) return;
    gsap.set(frame, { opacity: 0, y: 48, rotateX: 14, scale: 0.96 });
    io.observe(stage);
  });

  root.classList.remove('motion-js');

  /** Entrada em profundidade da moldura e, em seguida, flutuação + tilt. */
  function revealMedia(stage) {
    var frame = stage.querySelector('.shot-frame');
    if (!frame) return;
    gsap.to(frame, {
      opacity: 1,
      y: 0,
      rotateX: 0,
      scale: 1,
      duration: 1,
      ease: 'power3.out',
      onComplete: function () {
        startMediaIdle(stage, frame);
      },
    });
  }

  function startMediaIdle(stage, frame) {
    gsap.to(frame, { y: -10, duration: 3.4, ease: 'sine.inOut', yoyo: true, repeat: -1 });
    if (!finePointer) return;

    var targetX = 0;
    var targetY = 0;
    var ticking = false;

    function apply() {
      ticking = false;
      gsap.to(frame, {
        rotateX: targetX,
        rotateY: targetY,
        duration: 0.6,
        ease: 'power2.out',
        overwrite: 'auto',
      });
    }

    stage.addEventListener('pointermove', function (e) {
      var r = stage.getBoundingClientRect();
      targetY = ((e.clientX - r.left) / r.width - 0.5) * 10;
      targetX = -((e.clientY - r.top) / r.height - 0.5) * 8;
      if (!ticking) {
        ticking = true;
        requestAnimationFrame(apply);
      }
    });
    stage.addEventListener('pointerleave', function () {
      targetX = 0;
      targetY = 0;
      gsap.to(frame, { rotateX: 0, rotateY: 0, duration: 0.7, ease: 'power2.out', overwrite: 'auto' });
    });
  }
})();
