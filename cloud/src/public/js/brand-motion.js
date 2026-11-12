/*
 * Microinterações da marca Kuruk.
 *
 * - Letras do nome: efeito magnético no hover (cada letra reage à distância
 *   do ponteiro) e brilho que acompanha o mouse.
 * - Números: contagem crescente quando entram na tela.
 *
 * Tudo é progressivo: sem GSAP ou com "reduzir animações", o conteúdo já
 * aparece no HTML com os valores finais e nada fica invisível.
 */
(function () {
  var gsap = window.gsap;
  var prefersReduced =
    window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!gsap || prefersReduced) return;

  var finePointer =
    window.matchMedia && window.matchMedia('(hover: hover) and (pointer: fine)').matches;

  /* ── Letras do nome ── */
  var word = document.querySelector('[data-brand-word]');
  var letters = word ? Array.prototype.slice.call(word.querySelectorAll('[data-brand-letter]')) : [];

  if (word && letters.length && finePointer) {
    var movers = letters.map(function (letter) {
      gsap.set(letter, { transformOrigin: '50% 80%' });
      return {
        el: letter,
        x: gsap.quickTo(letter, 'x', { duration: 0.55, ease: 'power3' }),
        y: gsap.quickTo(letter, 'y', { duration: 0.55, ease: 'power3' }),
        scale: gsap.quickTo(letter, 'scale', { duration: 0.55, ease: 'power3' }),
      };
    });

    word.addEventListener('pointermove', function (event) {
      var wordRect = word.getBoundingClientRect();
      word.style.setProperty('--mx', ((event.clientX - wordRect.left) / wordRect.width) * 100 + '%');
      word.style.setProperty('--my', ((event.clientY - wordRect.top) / wordRect.height) * 100 + '%');

      movers.forEach(function (mover) {
        // Mede o wrapper, que não recebe o transform magnético — assim o alvo
        // não se move junto com a letra e o efeito não vira um vaivém.
        var rect = mover.el.parentElement.getBoundingClientRect();
        var cx = rect.left + rect.width / 2;
        var cy = rect.top + rect.height / 2;
        var dx = event.clientX - cx;
        var dy = event.clientY - cy;
        var distance = Math.sqrt(dx * dx + dy * dy);
        var reach = Math.max(130, wordRect.width * 0.18);
        var force = Math.max(0, 1 - distance / reach);
        mover.x(dx * 0.16 * force);
        mover.y(dy * 0.2 * force);
        mover.scale(1 + force * 0.22);
      });
    });

    word.addEventListener('pointerleave', function () {
      word.style.setProperty('--mx', '50%');
      word.style.setProperty('--my', '50%');
      movers.forEach(function (mover) {
        mover.x(0);
        mover.y(0);
        mover.scale(1);
      });
    });
  }

  /* ── Contagem dos números ── */
  var counters = document.querySelectorAll('[data-count]');
  if (!counters.length) return;

  var format = new Intl.NumberFormat('pt-BR');
  var observer = new IntersectionObserver(
    function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        var el = entry.target;
        observer.unobserve(el);
        if (el.getAttribute('data-counted') === '1') return;
        el.setAttribute('data-counted', '1');

        var target = Number(el.getAttribute('data-count')) || 0;
        if (target <= 0) return;

        var proxy = { value: 0 };
        gsap.to(proxy, {
          value: target,
          duration: target > 100 ? 1.55 : 1.05,
          ease: 'power2.out',
          onUpdate: function () {
            el.textContent = format.format(Math.round(proxy.value));
          },
          onComplete: function () {
            el.textContent = format.format(target);
          },
        });
      });
    },
    { threshold: 0.35 },
  );

  counters.forEach(function (el) {
    observer.observe(el);
  });
})();
