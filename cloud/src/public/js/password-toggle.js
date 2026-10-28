/**
 * Revelador de senha das telas de login.
 *
 * Sem Alpine no cloud: este arquivo cuida dos botões `[data-password-toggle]` e do
 * input que está dentro do mesmo `.password-field`. O estado visual (olho aberto x
 * riscado) fica nos dois SVGs e o `aria-pressed` anuncia a troca para leitores de tela.
 */
(function () {
  document.querySelectorAll('[data-password-toggle]').forEach(function (button) {
    var field = button.closest('.password-field');
    var input = field && field.querySelector('input');
    if (!input) return;

    var eyeOpen = button.querySelector('[data-eye-open]');
    var eyeOff = button.querySelector('[data-eye-off]');

    function render(visible) {
      input.type = visible ? 'text' : 'password';
      button.setAttribute('aria-pressed', visible ? 'true' : 'false');
      button.setAttribute('aria-label', visible ? 'Ocultar senha' : 'Mostrar senha');
      button.setAttribute('title', visible ? 'Ocultar senha' : 'Mostrar senha');
      if (eyeOpen) eyeOpen.hidden = visible;
      if (eyeOff) eyeOff.hidden = !visible;
    }

    button.addEventListener('click', function () {
      render(input.type === 'password');
    });

    // Se o navegador restaurar o campo já como texto (ex.: voltar pelo histórico),
    // os ícones começam coerentes com o que está na tela.
    render(input.type === 'text');
  });
})();
