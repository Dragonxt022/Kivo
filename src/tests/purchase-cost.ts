/**
 * Custo médio ponderado móvel na entrada de compra.
 *
 * Por que este teste existe: o DRE calcula o CMV somando `qty × cost_cents` de
 * `sale_items`, e esse cost_cents é um RETRATO de `products.cost_cents` tirado no
 * momento da venda (ver store/sales.ts). Custo errado no cadastro vira CMV errado
 * gravado na venda — e corrigir o cadastro depois não conserta o passado.
 * Lógica pura: roda em milissegundos, sem banco.
 */
import { weightedAverageCostCents as avg } from '../modules/commercial/purchasesRoutes';

let failures = 0;
function eq(label: string, actual: number, expected: number): void {
  const ok = actual === expected;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : ` — esperado ${expected}, veio ${actual}`}`);
  if (!ok) failures++;
}

// ── O caso que motivou a mudança ──
// 100un a R$10 em estoque + 1un a R$14 → o custo quase não se move.
// Antes (sobrescrita) virava 1400, inflando o CMV de todo o estoque.
eq('100un@R$10 + 1un@R$14 → ~R$10,04', avg(100, 1000, 1, 1400), 1004);

// ── Ponderação básica ──
eq('10un@R$10 + 10un@R$20 → R$15 (meio a meio)', avg(10, 1000, 10, 2000), 1500);
eq('1un@R$10 + 3un@R$20 → R$17,50', avg(1, 1000, 3, 2000), 1750);
eq('mesmo custo não muda nada', avg(50, 1000, 50, 1000), 1000);
eq('compra mais barata puxa o custo para baixo', avg(10, 2000, 10, 1000), 1500);

// ── Casos onde ponderar não faz sentido: vale o custo da compra ──
eq('estoque zerado → assume o custo da compra', avg(0, 1000, 5, 1400), 1400);
eq('estoque negativo → assume o custo da compra', avg(-3, 1000, 5, 1400), 1400);
eq('produto nunca custeado (custo 0) → 1ª compra define', avg(10, 0, 5, 1400), 1400);
eq('estoque zerado E sem custo → custo da compra', avg(0, 0, 5, 1400), 1400);

// ── Entradas inválidas não podem corromper o custo ──
eq('quantidade zero mantém o custo atual', avg(10, 1000, 0, 9999), 1000);
eq('quantidade negativa mantém o custo atual', avg(10, 1000, -5, 9999), 1000);

// ── Arredondamento: custo é INTEGER em centavos, nunca fração ──
eq('3un@R$10 + 1un@R$14 arredonda para centavo inteiro', avg(3, 1000, 1, 1400), 1100);
eq('média de dízima arredonda (não trunca)', avg(3, 1000, 1, 1401), 1100);
const r = avg(7, 333, 5, 777);
eq('resultado é sempre inteiro', Number.isInteger(r) ? 1 : 0, 1);

// ── Fracionado: quantidade decimal (kg) ──
eq('0,5kg@R$10 + 0,5kg@R$20 → R$15', avg(0.5, 1000, 0.5, 2000), 1500);
eq('2,5kg@R$8 + 2,5kg@R$12 → R$10', avg(2.5, 800, 2.5, 1200), 1000);

// ── Sequência real: três compras seguidas ──
{
  let custo = 0, saldo = 0;
  custo = avg(saldo, custo, 100, 1000); saldo += 100;   // 1ª: define R$10
  eq('sequência — após 1ª compra (100@R$10)', custo, 1000);
  custo = avg(saldo, custo, 100, 1200); saldo += 100;   // 2ª: R$12
  eq('sequência — após 2ª compra (100@R$12)', custo, 1100);
  custo = avg(saldo, custo, 200, 900); saldo += 200;    // 3ª: R$9 em dobro
  eq('sequência — após 3ª compra (200@R$9)', custo, 1000);
}

console.log(failures ? `\n${failures} FALHA(S)` : '\nTodos os testes passaram.');
process.exit(failures ? 1 : 0);
