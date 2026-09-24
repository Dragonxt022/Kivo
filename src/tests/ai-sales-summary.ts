/**
 * Teste: resumo local de vendas para a ferramenta "Insights de vendas" (KIVO IA).
 *
 * Monta um banco descartável com produtos, vendas (no período e no anterior), itens e formas de
 * pagamento, e confere o que `buildSalesInsightsInput` produz: totais, ticket médio, ranking,
 * formas de pagamento (com rótulo amigável), série por dia, período anterior de comparação e as
 * exclusões (venda cancelada / deletada). Roda contra banco descartável:
 *   node scripts/test-isolated.js src/tests/ai-sales-summary.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { migrateUp } from '../core/database/migrator';
import { getSqlite, closeDb } from '../core/database/connection';
import { buildSalesInsightsInput } from '../core/ai/salesSummary';

let failures = 0;
function check(label: string, ok: boolean, extra = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures++;
}

function main(): void {
  const tmp = process.env.KIVO_DB_PATH;
  if (!tmp) throw new Error('KIVO_DB_PATH não definida. Rode via scripts/test-isolated.js.');
  if (path.resolve(tmp) === path.resolve(process.cwd(), 'database', 'kivo.db')) {
    throw new Error('Recusado: KIVO_DB_PATH aponta para o banco de dev.');
  }
  fs.mkdirSync(path.dirname(tmp), { recursive: true });
  fs.rmSync(tmp, { force: true });

  migrateUp();
  const db = getSqlite();

  const mkProduct = (name: string): number => Number(db.prepare(
    `INSERT INTO products (name, unit, price_cents, cost_cents, track_stock, stock_qty, min_stock, active, uuid)
     VALUES (?, 'un', 1000, 500, 0, 0, 0, 1, ?)`,
  ).run(name, randomUUID()).lastInsertRowid);

  const pizza = mkProduct('Pizza');
  const refri = mkProduct('Refrigerante');

  const mkSale = (when: string, total: number, method: string, status = 'concluida', deleted = false): number => Number(db.prepare(
    `INSERT INTO sales (status, subtotal_cents, discount_cents, surcharge_cents, total_cents, payment_method, paid_cents, change_cents, user_id, uuid, created_at, deleted_at)
     VALUES (?, ?, 0, 0, ?, ?, ?, 0, NULL, ?, ?, ?)`,
  ).run(status, total, total, method, total, randomUUID(), when, deleted ? when : null).lastInsertRowid);

  const addItem = (saleId: number, productId: number, name: string, qty: number, total: number): void => {
    db.prepare(
      `INSERT INTO sale_items (sale_id, product_id, product_name, qty, unit_price_cents, total_cents, cost_cents)
       VALUES (?, ?, ?, ?, ?, ?, 0)`,
    ).run(saleId, productId, name, qty, Math.round(total / qty), total);
  };

  // Período: 01–30/09/2026 (12:00 UTC mantém o dia estável em qualquer fuso razoável).
  const saleA = mkSale('2026-09-10 12:00:00', 5000, 'dinheiro');
  addItem(saleA, pizza, 'Pizza', 2, 5000);
  const saleB = mkSale('2026-09-11 12:00:00', 3000, 'pix');
  addItem(saleB, refri, 'Refrigerante', 3, 3000);

  // Período anterior de mesmo tamanho (02–31/08/2026): uma venda de 4.000.
  const salePrev = mkSale('2026-08-15 12:00:00', 4000, 'dinheiro');
  addItem(salePrev, pizza, 'Pizza', 1, 4000);

  // Ruídos que NÃO devem entrar: cancelada e deletada, ambas dentro do período.
  const saleCanceled = mkSale('2026-09-12 12:00:00', 9900, 'dinheiro', 'cancelada');
  addItem(saleCanceled, pizza, 'Pizza', 5, 9900);
  const saleDeleted = mkSale('2026-09-13 12:00:00', 8800, 'pix', 'concluida', true);
  addItem(saleDeleted, refri, 'Refrigerante', 4, 8800);

  const out = buildSalesInsightsInput('2026-09-01', '2026-09-30');

  check('período ecoado', out.from === '2026-09-01' && out.to === '2026-09-30', `${out.from}..${out.to}`);
  check('conta 2 vendas (ignora cancelada/deletada)', out.salesCount === 2, String(out.salesCount));
  check('soma o faturamento (8.000)', out.totalCents === 8000, String(out.totalCents));
  check('ticket médio (4.000)', out.ticketCents === 4000, String(out.ticketCents));
  check('ranking ordenado por valor', out.topProducts[0]?.name === 'Pizza' && out.topProducts[0]?.totalCents === 5000 && out.topProducts[0]?.qty === 2, JSON.stringify(out.topProducts));
  check('formas de pagamento com rótulo amigável', out.byPayment.some((p) => p.method === 'Dinheiro' && p.totalCents === 5000) && out.byPayment.some((p) => p.method === 'Pix' && p.totalCents === 3000), JSON.stringify(out.byPayment));
  check('série por dia com 2 dias', out.daily.length === 2, JSON.stringify(out.daily));
  check('período anterior (4.000 / 1 venda)', out.previous?.totalCents === 4000 && out.previous?.salesCount === 1, JSON.stringify(out.previous));

  // Sem argumentos: cai no mês corrente (from = 1º dia, to = hoje).
  const def = buildSalesInsightsInput(undefined, undefined);
  check('período padrão = mês corrente', /^\d{4}-\d{2}-01$/.test(def.from) && /^\d{4}-\d{2}-\d{2}$/.test(def.to), `${def.from}..${def.to}`);

  // Período sem vendas: tudo zerado e sem estourar.
  const empty = buildSalesInsightsInput('2020-01-01', '2020-01-31');
  check('período vazio zera os totais', empty.salesCount === 0 && empty.totalCents === 0 && empty.ticketCents === 0 && empty.topProducts.length === 0, JSON.stringify(empty));

  closeDb();
  console.log(failures === 0 ? '\nResumo de vendas (IA): TODOS OS TESTES PASSARAM' : `\n${failures} falha(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
