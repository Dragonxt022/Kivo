/**
 * Dinheiro no navegador (Kivo) — cópia client-side de shared/money (sem bundler),
 * no mesmo espírito de barcode.js.
 *
 * Existia uma cópia de `brl()` dentro de CADA tela — 24 no total — e duas já tinham
 * divergido: o cupom da venda e a tela de documentos fiscais imprimiam "R$ 1234,56"
 * enquanto o resto do sistema mostrava "R$ 1.234,56" para o mesmo valor. As telas agora
 * delegam para esta função, e o servidor usa `formatBRL` (app.locals.brl) nas views de
 * impressão: uma regra de formatação só, dos dois lados.
 *
 * O formato tem de bater com `formatBRL` de src/shared/money — inclusive o negativo,
 * que sai como "-R$ 10,00" (e não "R$ -10,00"), que é a forma coberta por testes.
 */
window.brl = function (cents) {
  var n = Number(cents ?? 0);
  if (!Number.isFinite(n)) n = 0;
  var negative = n < 0;
  var abs = Math.abs(Math.round(n));
  var int = Math.floor(abs / 100).toString();
  var dec = (abs % 100).toString().padStart(2, '0');
  var grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return (negative ? '-' : '') + 'R$ ' + grouped + ',' + dec;
};
