/**
 * Estoque por lote (FIFO/FEFO) e validade.
 *
 * Cobre o núcleo pedido: entrada cria lote, saída consome do lote mais antigo/vencimento
 * mais próximo para o mais novo, política de vencimento (bloquear) e lote obrigatório.
 * Não sobe servidor HTTP: chama `moveStock` direto após migrateUp + runSeeds.
 *
 *   node scripts/test-isolated.js src/tests/stock-lots.ts
 */
import type { Request } from 'express';
import { migrateUp } from '../core/database/migrator';
import { runSeeds } from '../core/database/seeds';
import { getSqlite, closeDb } from '../core/database/connection';
import { resetTestDb } from './resetTestDb';
import { moveStock } from '../modules/commercial/stock';

let failures = 0;
function check(label: string, ok: boolean, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures++;
}

const req = { user: { id: 1, username: 'teste' }, ip: '127.0.0.1' } as unknown as Request;

function setSetting(key: string, value: string): void {
  const db = getSqlite();
  db.prepare(
    `INSERT INTO settings (key, value, uuid) VALUES (?, ?, lower(hex(randomblob(16))))
     ON CONFLICT(key) DO UPDATE SET value = ?, deleted_at = NULL`,
  ).run(key, value, value);
}

async function main() {
  resetTestDb();
  migrateUp();
  runSeeds();
  const db = getSqlite();

  // ── Produto que controla lote ──────────────────────────────────────────────
  const prodId = Number(db.prepare(
    `INSERT INTO products (name, cost_cents, price_cents, track_stock, controla_lote, uuid)
     VALUES ('Iogurte', 100, 300, 1, 1, lower(hex(randomblob(16))))`,
  ).run().lastInsertRowid);

  const future = new Date(Date.now() + 365 * 86400000).toISOString().slice(0, 10);
  const near = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
  const past = '2020-01-01';

  // Duas entradas em lotes diferentes; o lote "near" vence antes e deve sair primeiro.
  const e1 = moveStock(req, prodId, 'entrada', 10, 'compra', undefined, undefined,
    { code: 'L-A', expiresAt: future, costCents: 100 });
  const e2 = moveStock(req, prodId, 'entrada', 5, 'compra', undefined, undefined,
    { code: 'L-B', expiresAt: near, costCents: 200 });
  check('entrada de dois lotes ok', e1.ok && e2.ok, JSON.stringify([e1, e2]));
  const lots1 = db.prepare('SELECT code, qty, cost_cents FROM product_lots WHERE product_id = ? ORDER BY code').all(prodId) as
    { code: string; qty: number; cost_cents: number }[];
  check('dois lotes criados', lots1.length === 2, JSON.stringify(lots1));
  check('lote A com 10 un', lots1.find((l) => l.code === 'L-A')?.qty === 10);
  check('lote B com 5 un', lots1.find((l) => l.code === 'L-B')?.qty === 5);

  // Saída de 12: consome 5 do lote B (vence antes) + 7 do lote A.
  const s1 = moveStock(req, prodId, 'saida', 12, 'venda');
  check('saída de 12 ok', s1.ok && s1.balance === 3, JSON.stringify(s1));
  const lots2 = db.prepare('SELECT code, qty FROM product_lots WHERE product_id = ? AND qty > 0').all(prodId) as
    { code: string; qty: number }[];
  check('só o lote A permanece, com 3 un', lots2.length === 1 && lots2[0].code === 'L-A' && lots2[0].qty === 3, JSON.stringify(lots2));

  const consumos = db.prepare(
    'SELECT lc.qty, lc.unit_cost_cents, pl.code FROM lot_consumptions lc JOIN product_lots pl ON pl.id = lc.lot_id ORDER BY lc.id',
  ).all() as { qty: number; unit_cost_cents: number; code: string }[];
  check('consumo do lote B primeiro (5 @ 200)', consumos[0]?.code === 'L-B' && consumos[0]?.qty === 5 && consumos[0]?.unit_cost_cents === 200, JSON.stringify(consumos));
  check('consumo do lote A depois (7 @ 100)', consumos[1]?.code === 'L-A' && consumos[1]?.qty === 7 && consumos[1]?.unit_cost_cents === 100, JSON.stringify(consumos));

  // ── Lote obrigatório na entrada manual ─────────────────────────────────────
  setSetting('estoque.lote_obrigatorio', '1');
  const semLote = moveStock(req, prodId, 'entrada', 1, 'ajuste manual');
  check('entrada manual sem lote é recusada', !semLote.ok, JSON.stringify(semLote));
  // Entrada automática (com refEntity) não é barrada — devoluções/estornos não têm lote.
  const auto = moveStock(req, prodId, 'entrada', 1, 'devolução', 'sale_return', 99);
  check('entrada automática sem lote é aceita', auto.ok, JSON.stringify(auto));
  setSetting('estoque.lote_obrigatorio', '0');

  // ── Bloqueio de lote vencido ───────────────────────────────────────────────
  const exp = moveStock(req, prodId, 'entrada', 4, 'compra', undefined, undefined,
    { code: 'L-VENCIDO', expiresAt: past, costCents: 50 });
  check('lote vencido pode ser recebido', exp.ok, JSON.stringify(exp));

  const semBloqueio = moveStock(req, prodId, 'saida', 2, 'venda');
  check('com política padrão, venda de lote vencido passa (só alerta)', semBloqueio.ok, JSON.stringify(semBloqueio));

  setSetting('estoque.validade_acao', 'bloquear');
  // Recria o lote vencido consumido no teste anterior.
  moveStock(req, prodId, 'entrada', 4, 'compra', undefined, undefined, { code: 'L-VENCIDO', expiresAt: past, costCents: 50 });
  const saldoAntesBloqueio = Number((db.prepare('SELECT stock_qty FROM products WHERE id = ?').get(prodId) as { stock_qty: number }).stock_qty);
  const bloqueado = moveStock(req, prodId, 'saida', 1, 'venda');
  const saldoDepois = Number((db.prepare('SELECT stock_qty FROM products WHERE id = ?').get(prodId) as { stock_qty: number }).stock_qty);
  check('com política bloquear, saída de lote vencido é recusada', !bloqueado.ok, JSON.stringify(bloqueado));
  check('saldo não mudou ao bloquear', saldoDepois === saldoAntesBloqueio, `${saldoAntesBloqueio} → ${saldoDepois}`);
  setSetting('estoque.validade_acao', 'sugerir_baixa');

  // ── Produto SEM controle de lote segue o comportamento antigo ──────────────
  const simplesId = Number(db.prepare(
    `INSERT INTO products (name, cost_cents, price_cents, track_stock, controla_lote, uuid)
     VALUES ('Simples', 100, 200, 1, 0, lower(hex(randomblob(16))))`,
  ).run().lastInsertRowid);
  const se = moveStock(req, simplesId, 'entrada', 7, 'compra');
  const ss = moveStock(req, simplesId, 'saida', 3, 'venda');
  check('produto sem lote movimenta normalmente', se.ok && ss.ok && ss.balance === 4, JSON.stringify([se, ss]));
  const lotsSimples = db.prepare('SELECT COUNT(*) c FROM product_lots WHERE product_id = ?').get(simplesId) as { c: number };
  check('produto sem lote não cria lote', lotsSimples.c === 0);

  // ── Baixa de lote (perda/vencimento) ───────────────────────────────────────
  {
    const { writeOffLot, listLots } = await import('../modules/commercial/stock');
    const prod2 = Number(db.prepare(
      `INSERT INTO products (name, cost_cents, track_stock, controla_lote, uuid)
       VALUES ('Perecível', 100, 1, 1, lower(hex(randomblob(16))))`,
    ).run().lastInsertRowid);
    moveStock(req, prod2, 'entrada', 6, 'compra', undefined, undefined, { code: 'X1', expiresAt: past, costCents: 100 });
    const lotId = listLots(prod2)[0].id;
    const w = writeOffLot(req, lotId, 'vencido');
    check('baixa de lote ok', w.ok, JSON.stringify(w));
    const saldo2 = Number((db.prepare('SELECT stock_qty FROM products WHERE id = ?').get(prod2) as { stock_qty: number }).stock_qty);
    check('saldo zerado após baixa', saldo2 === 0, `${saldo2}`);
    const lote2 = db.prepare('SELECT qty FROM product_lots WHERE id = ?').get(lotId) as { qty: number };
    check('lote zerado após baixa', lote2.qty === 0);
    const movBaixa = db.prepare("SELECT COUNT(*) c FROM stock_movements WHERE product_id = ? AND ref_entity = 'lot_writeoff'").get(prod2) as { c: number };
    check('movimento de baixa registrado', movBaixa.c === 1);
  }

  // ── Compra recebida com lote ───────────────────────────────────────────────
  {
    const { createPurchaseInbound } = await import('../modules/commercial/purchaseInbound');
    const supId = Number(db.prepare(
      "INSERT INTO suppliers (name, document, uuid) VALUES ('Fornecedor Teste', '11222333000181', lower(hex(randomblob(16))))",
    ).run().lastInsertRowid);
    const prod3 = Number(db.prepare(
      `INSERT INTO products (name, cost_cents, track_stock, controla_lote, uuid)
       VALUES ('Compra Lote', 0, 1, 1, lower(hex(randomblob(16))))`,
    ).run().lastInsertRowid);
    const pid = createPurchaseInbound(req, {
      supplierId: supId,
      items: [{ productId: prod3, qty: 8, unitCostCents: 250, lot: { code: 'CL-1', expiresAt: future } }],
      status: 'recebida',
    });
    check('compra com lote criada', pid > 0);
    const lote3 = db.prepare('SELECT code, qty, cost_cents FROM product_lots WHERE product_id = ?').get(prod3) as
      { code: string; qty: number; cost_cents: number } | undefined;
    check('lote da compra criado', lote3?.code === 'CL-1' && lote3?.qty === 8 && lote3?.cost_cents === 250, JSON.stringify(lote3));
  }

  // ── Custo FIFO (espelha o consumo, sem consumir) ───────────────────────────
  {
    const { fifoUnitCostCents, fifoCostEnabled } = await import('../modules/commercial/stock');
    setSetting('estoque.metodo_custo', 'fifo');
    check('método de custo FIFO ligado', fifoCostEnabled() === true);
    const prodF = Number(db.prepare(
      `INSERT INTO products (name, cost_cents, track_stock, controla_lote, uuid)
       VALUES ('Custo FIFO', 999, 1, 1, lower(hex(randomblob(16))))`,
    ).run().lastInsertRowid);
    moveStock(req, prodF, 'entrada', 10, 'compra', undefined, undefined, { code: 'F1', expiresAt: future, costCents: 100 });
    moveStock(req, prodF, 'entrada', 5, 'compra', undefined, undefined, { code: 'F2', expiresAt: near, costCents: 200 });
    // F2 vence antes: 5 @ 200 + 7 @ 100 = 1700 / 12 = 141,67 → 142.
    check('custo FIFO de 12 un = 142', fifoUnitCostCents(prodF, 12, 999) === 142, `${fifoUnitCostCents(prodF, 12, 999)}`);
    const esperado = Math.round((5 * 200 + 10 * 100 + 5 * 999) / 20);
    check('custo FIFO usa fallback no que falta', fifoUnitCostCents(prodF, 20, 999) === esperado, `${fifoUnitCostCents(prodF, 20, 999)} vs ${esperado}`);
    const lf = db.prepare('SELECT SUM(qty) s FROM product_lots WHERE product_id = ?').get(prodF) as { s: number };
    check('custo FIFO não consome lote', lf.s === 15, `${lf.s}`);
    setSetting('estoque.metodo_custo', 'medio');
  }

  // ── Estorno devolve ao lote de origem (devolução/cancelamento) ─────────────
  {
    const { restoreLotsForSale } = await import('../modules/commercial/stock');
    const prodR = Number(db.prepare(
      `INSERT INTO products (name, cost_cents, track_stock, controla_lote, uuid)
       VALUES ('Estorno Lote', 100, 1, 1, lower(hex(randomblob(16))))`,
    ).run().lastInsertRowid);
    moveStock(req, prodR, 'entrada', 10, 'compra', undefined, undefined, { code: 'RA', expiresAt: future, costCents: 100 });
    moveStock(req, prodR, 'entrada', 5, 'compra', undefined, undefined, { code: 'RB', expiresAt: near, costCents: 200 });
    moveStock(req, prodR, 'saida', 12, 'venda', 'sale', 777);

    const lotSum = () => Number((db.prepare('SELECT COALESCE(SUM(qty),0) s FROM product_lots WHERE product_id = ?').get(prodR) as { s: number }).s);
    const stockQty = () => Number((db.prepare('SELECT stock_qty FROM products WHERE id = ?').get(prodR) as { stock_qty: number }).stock_qty);
    check('venda consumiu os lotes (saldo 3)', stockQty() === 3 && lotSum() === 3, `stock=${stockQty()} lotes=${lotSum()}`);

    // Devolve 6: entrada SEM lote novo + restauração ao lote de origem.
    const e1 = moveStock(req, prodR, 'entrada', 6, 'devolução', 'sale_return', 1, null, { skipLot: true });
    const r1 = restoreLotsForSale(prodR, 6, 'sale', 777);
    check('devolução restaurou 6 no lote', e1.ok && r1 === 6, `restored=${r1}`);
    check('devolução mantém soma dos lotes = saldo', lotSum() === stockQty(), `lotes=${lotSum()} stock=${stockQty()}`);
    const countLots = db.prepare('SELECT COUNT(*) c FROM product_lots WHERE product_id = ? AND deleted_at IS NULL').get(prodR) as { c: number };
    check('devolução não cria lote novo (2 lotes)', countLots.c === 2, `${countLots.c}`);

    // Cancela o restante (6): devolve tudo aos lotes originais.
    moveStock(req, prodR, 'entrada', 6, 'cancelamento', 'sale', 777, null, { skipLot: true });
    restoreLotsForSale(prodR, 6, 'sale', 777);
    const lots = db.prepare('SELECT code, qty FROM product_lots WHERE product_id = ? ORDER BY code').all(prodR) as { code: string; qty: number }[];
    check('cancelamento devolveu os lotes de origem',
      lots.length === 2 && lots[0].code === 'RA' && lots[0].qty === 10 && lots[1].code === 'RB' && lots[1].qty === 5,
      JSON.stringify(lots));
    check('soma dos lotes = saldo após cancelar', lotSum() === stockQty() && stockQty() === 15, `lotes=${lotSum()} stock=${stockQty()}`);
  }

  closeDb();
  console.log(failures === 0 ? '\nEstoque por lote: TODOS OS TESTES PASSARAM' : `\n${failures} falha(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
