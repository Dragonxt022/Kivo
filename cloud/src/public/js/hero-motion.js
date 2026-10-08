/*
 * Entrada do hero da landing (GSAP).
 *
 * Título com flip 3D, chips em "pop", orbes de fundo flutuando e a screenshot
 * entrando em profundidade — depois ela segue o mouse com tilt 3D e flutua.
 *
 * Só roda quando o GSAP carregou e o usuário não pediu "reduzir animações".
 * Em qualquer outro caso, remove a classe que esconde o conteúdo — assim a
 * página nunca fica em branco se o CDN falhar ou o JS estiver desligado.
 */
(function () {
  var root = document.documentElement;
  var gsap = window.gsap;
  var prefersReduced =
    window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  if (!gsap || prefersReduced) {
    root.classList.remove('hero-motion');
    return;
  }

  var shot = document.querySelector('.hero-media-3d .shot-frame');
  var media = document.querySelector('.hero-media-3d');

  var tl = gsap.timeline({ defaults: { ease: 'power3.out' }, onComplete: startIdle });

  tl.fromTo('.hero-orb', { scale: 0.6, opacity: 0 }, { scale: 1, opacity: 1, duration: 1.4, stagger: 0.2 }, 0)
    .fromTo(
      '[data-hero-line]',
      { yPercent: 110, rotateX: -80, opacity: 0, transformPerspective: 800, transformOrigin: '50% 100%' },
      { yPercent: 0, rotateX: 0, opacity: 1, duration: 0.9, stagger: 0.14 },
      0.15,
    )
    .fromTo(
      '[data-hero-fade]',
      { y: 22, opacity: 0 },
      { y: 0, opacity: 1, duration: 0.6, stagger: 0.1 },
      '-=0.5',
    )
    .fromTo(
      '[data-hero-chips] .chip',
      { y: 18, scale: 0.8, opacity: 0 },
      { y: 0, scale: 1, opacity: 1, duration: 0.55, stagger: 0.08, ease: 'back.out(1.7)' },
      '-=0.3',
    )
    .fromTo(
      '[data-hero-media]',
      { y: 70, opacity: 0, rotateX: 16, scale: 0.94 },
      { y: 0, opacity: 1, rotateX: 0, scale: 1, duration: 1, ease: 'power3.out' },
      '-=0.5',
    );

  // O GSAP já fixou os valores iniciais inline; pode soltar o estado "escondido"
  // do CSS sem risco de piscar.
  root.classList.remove('hero-motion');

  /** Flutuação contínua + tilt 3D interativo, começando após a entrada. */
  function startIdle() {
    gsap.to('.hero-orb.a', { x: 26, y: 30, duration: 7, ease: 'sine.inOut', yoyo: true, repeat: -1 });
    gsap.to('.hero-orb.b', { x: -30, y: -22, duration: 8, ease: 'sine.inOut', yoyo: true, repeat: -1 });

    if (!shot) return;
    gsap.to(shot, { y: -12, duration: 3.2, ease: 'sine.inOut', yoyo: true, repeat: -1 });

    var finePointer =
      window.matchMedia && window.matchMedia('(hover: hover) and (pointer: fine)').matches;
    if (!media || !finePointer) return;

    var rotX = gsap.quickTo(shot, 'rotateX', { duration: 0.5, ease: 'power2.out' });
    var rotY = gsap.quickTo(shot, 'rotateY', { duration: 0.5, ease: 'power2.out' });

    media.addEventListener('pointermove', function (e) {
      var r = media.getBoundingClientRect();
      var px = (e.clientX - r.left) / r.width - 0.5;
      var py = (e.clientY - r.top) / r.height - 0.5;
      rotY(px * 12);
      rotX(-py * 10);
    });
    media.addEventListener('pointerleave', function () {
      rotX(0);
      rotY(0);
    });
  }
})();
