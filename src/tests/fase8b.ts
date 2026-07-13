/**
 * Fase 8b — Testes unitários de funções financeiras/comerciais críticas.
 *
 * 1. computeLateCharges — edge cases (futuro, zero config, valores extremos)
 * 2. recomputeStockForProducts — replay do ledger de estoque
 * 3. recomputeForCustomers — replay do ledger de crédito/pontos
 *
 * Estes testes NÃO sobem servidor HTTP: chamam as funções diretamente
 * após migrateUp + runSeeds.
 */
import { migrateUp } from '../core/database/migrator';
import { runSeeds } from '../core/database/seeds';
import { getSqlite, closeDb } from '../core/database/connection';
import { resetTestDb } from './resetTestDb';

let failures = 0;

function check(label: string, ok: boolean, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures++;
}

async function main() {
  resetTestDb();
  migrateUp();
  runSeeds();
  const db = getSqlite();

  // ====================================================================
  // 1. computeLateCharges
  // ====================================================================
  {
    const { computeLateCharges, readLateFeeConfig } = await import('../modules/finance/lateFees');

    // Helper: limpa e insere configuração
    function setCfg(multaAtiva: boolean, multaPct: number, jurosAtivo: boolean, jurosPctDia: number) {
      db.prepare(`UPDATE settings SET value = ?, deleted_at = datetime('now') WHERE key IN (
        'financeiro.multa_atraso.ativa','financeiro.multa_atraso.percentual',
        'financeiro.juros_atraso.ativo','financeiro.juros_atraso.percentual_dia'
      )`).run('0');
      const upsert = (key: string, val: string) =>
        db.prepare(`INSERT INTO settings (key, value, uuid) VALUES (?, ?, lower(hex(randomblob(16))))
          ON CONFLICT(key) DO UPDATE SET value = ?, deleted_at = NULL`).run(key, val, val);
      upsert('financeiro.multa_atraso.ativa', multaAtiva ? '1' : '0');
      upsert('financeiro.multa_atraso.percentual', String(multaPct));
      upsert('financeiro.juros_atraso.ativo', jurosAtivo ? '1' : '0');
      upsert('financeiro.juros_atraso.percentual_dia', String(jurosPctDia));
    }

    // Configurar multa 2% + juros 0,033%/dia ativos
    setCfg(true, 2, true, 0.033);

    // Conta vencida há 10 dias
    const hoje = new Date().toISOString().slice(0, 10);
    const dezDiasAtras = new Date(Date.now() - 10 * 86400000).toISOString().slice(0, 10);
    // baseCents=100000, multa=2%, 10 dias de juros a 0,033%/dia
    const res = computeLateCharges(100000, dezDiasAtras);
    check('multa = 2000 (2% de 100000)', res.multaCents === 2000, `${res.multaCents}`);
    check('juros = 330 (0,033% * 10 dias * 100000)', res.jurosCents === 330, `${res.jurosCents}`);
    check('diasAtraso = 10', res.diasAtraso === 10, `${res.diasAtraso}`);

    // Conta com vencimento FUTURO → sem encargos
    const futuro = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
    const fut = computeLateCharges(50000, futuro);
    check('conta futura: multa=0', fut.multaCents === 0);
    check('conta futura: juros=0', fut.jurosCents === 0);
    check('conta futura: diasAtraso=0', fut.diasAtraso === 0);

    // Conta VENCIDA HOJE → sem encargos
    const hojeRes = computeLateCharges(50000, hoje);
    check('conta vence hoje: multa=0', hojeRes.multaCents === 0);
    check('conta vence hoje: juros=0', hojeRes.jurosCents === 0);

    // Multa zero, juros desligado
    setCfg(false, 0, false, 0);
    const zeroCfg = computeLateCharges(100000, dezDiasAtras);
    check('config zero: multa=0', zeroCfg.multaCents === 0);
    check('config zero: juros=0', zeroCfg.jurosCents === 0);

    // Arredondamento: valores com centavos quebrados
    setCfg(true, 3, true, 0.1);
    const edge = computeLateCharges(333, dezDiasAtras);
    check('multa 3% de 333 = 10 (Math.round(9.99))', edge.multaCents === 10, `${edge.multaCents}`);
    // juros 0,1% * 10 dias * 333 = 3,33 → Math.round = 3
    check('juros 0,1%*10d*333 = 3', edge.jurosCents === 3, `${edge.jurosCents}`);

    // Configuração faltando (settings deletados) — deve tratar como desligado
    db.prepare(`DELETE FROM settings WHERE key LIKE 'financeiro.multa%' OR key LIKE 'financeiro.juros%'`).run();
    const noCfg = computeLateCharges(100000, dezDiasAtras);
    check('sem config: multa=0', noCfg.multaCents === 0);
    check('sem config: juros=0', noCfg.jurosCents === 0);

    const config = readLateFeeConfig();
    check('readLateFeeConfig retorna objeto com defaults', !config.multaAtiva && config.multaPercentual === 0);
  }

  // ====================================================================
  // 2. recomputeStockForProducts
  // ====================================================================
  {
    const { moveStockRaw, recomputeStockForProducts } = await import('../modules/commercial/stock');

    // Mock minimal do Request (moveStockRaw precisa de req.user?.id)
    const mockReq = { user: { id: 999 } } as any;

    // Criar produto com estoque inicial
    const prod = db.prepare(
      `INSERT INTO products (name, price_cents, track_stock, uuid)
       VALUES ('Estoque Test', 1000, 1, lower(hex(randomblob(16))))`,
    ).run();
    const prodId = Number(prod.lastInsertRowid);

    // Inserir movimentos DIRETAMENTE (simula sync de duas máquinas conflitantes)
    const ins = db.prepare(
      `INSERT INTO stock_movements (product_id, type, qty, balance_after, ref_entity, uuid, created_at)
       VALUES (?, ?, ?, 0, 'unit_test', lower(hex(randomblob(16))), ?)`,
    );
    ins.run(prodId, 'entrada', 10, '2026-07-01T00:00:00.000Z');
    ins.run(prodId, 'entrada', 5, '2026-07-02T00:00:00.000Z');
    ins.run(prodId, 'saida', 3, '2026-07-03T00:00:00.000Z');
    ins.run(prodId, 'entrada', 8, '2026-07-04T00:00:00.000Z');
    ins.run(prodId, 'saida', 2, '2026-07-05T00:00:00.000Z');

    // estado antes do recompute: product.stock_qty pode estar errado
    db.prepare('UPDATE products SET stock_qty = 999 WHERE id = ?').run(prodId);

    await recomputeStockForProducts([prodId]);
    const after = db.prepare('SELECT stock_qty FROM products WHERE id = ?').get(prodId) as { stock_qty: number };
    const expected = 10 + 5 - 3 + 8 - 2; // = 18
    check('recomputeStock: saldo correto (18)', after.stock_qty === expected, `${after.stock_qty}`);

    // Verificar balance_after nas movimentações
    const movs = db.prepare(
      'SELECT type, qty, balance_after FROM stock_movements WHERE product_id = ? ORDER BY created_at, uuid',
    ).all(prodId) as { type: string; qty: number; balance_after: number }[];
    check('recomputeStock: 5 movimentos', movs.length === 5);
    check('mov1 entrada 10 → balance=10', movs[0].balance_after === 10);
    check('mov2 entrada 5 → balance=15', movs[1].balance_after === 15);
    check('mov3 saida 3 → balance=12', movs[2].balance_after === 12);
    check('mov4 entrada 8 → balance=20', movs[3].balance_after === 20);
    check('mov5 saida 2 → balance=18', movs[4].balance_after === 18);

    // Ajuste (type='ajuste') sobrescreve o saldo
    const insAjuste = db.prepare(
      `INSERT INTO stock_movements (product_id, type, qty, balance_after, ref_entity, uuid, created_at)
       VALUES (?, 'ajuste', 100, 0, 'unit_test', lower(hex(randomblob(16))), ?)`,
    );
    insAjuste.run(prodId, '2026-07-06T00:00:00.000Z');
    await recomputeStockForProducts([prodId]);
    const afterAjuste = db.prepare('SELECT stock_qty FROM products WHERE id = ?').get(prodId) as { stock_qty: number };
    check('ajuste redefine saldo para 100', afterAjuste.stock_qty === 100, `${afterAjuste.stock_qty}`);
  }

  // ====================================================================
  // 3. recomputeForCustomers (customer ledger)
  // ====================================================================
  {
    const { recomputeForCustomers } = await import('../modules/commercial/customerLedger');
    const { STORE_CREDIT_CFG } = await import('../modules/commercial/storeCredit');
    const { LOYALTY_CFG } = await import('../modules/commercial/loyalty');

    // Criar cliente
    const cust = db.prepare(
      "INSERT INTO customers (name, store_credit_cents, loyalty_points, uuid) VALUES ('Ledger Test', 99999, 99999, lower(hex(randomblob(16))))",
    ).run();
    const custId = Number(cust.lastInsertRowid);

    // Inserir movimentos de crédito de loja manualmente (simula sync)
    const insCredit = db.prepare(
      `INSERT INTO customer_credit_movements (customer_id, type, amount_cents, balance_after, ref_entity, uuid, created_at)
       VALUES (?, ?, ?, 0, 'unit_test', lower(hex(randomblob(16))), ?)`,
    );
    insCredit.run(custId, 'concessao', 10000, '2026-07-01T00:00:00.000Z');
    insCredit.run(custId, 'resgate', 3000, '2026-07-02T00:00:00.000Z');
    insCredit.run(custId, 'concessao', 5000, '2026-07-03T00:00:00.000Z');
    insCredit.run(custId, 'estorno_resgate', 3000, '2026-07-04T00:00:00.000Z');

    await recomputeForCustomers(STORE_CREDIT_CFG, [custId]);
    const bal = db.prepare('SELECT store_credit_cents FROM customers WHERE id = ?').get(custId) as { store_credit_cents: number };
    const expectedCredit = 10000 - 3000 + 5000 + 3000; // = 15000
    check('store credit recompute: saldo 15000', bal.store_credit_cents === expectedCredit, `${bal.store_credit_cents}`);

    // Verificar balance_after dos movimentos
    const movs = db.prepare(
      'SELECT type, amount_cents, balance_after FROM customer_credit_movements WHERE customer_id = ? ORDER BY created_at, uuid',
    ).all(custId) as { type: string; amount_cents: number; balance_after: number }[];
    check('4 movimentos de crédito', movs.length === 4);
    check('concessao 10000 → bal=10000', movs[0].balance_after === 10000);
    check('resgate 3000 → bal=7000', movs[1].balance_after === 7000);
    check('concessao 5000 → bal=12000', movs[2].balance_after === 12000);
    check('estorno_resgate 3000 → bal=15000', movs[3].balance_after === 15000);

    // Testar reverseGrant (estorno de ganho) — subtrai sem checar suficiência
    const insReverse = db.prepare(
      `INSERT INTO customer_credit_movements (customer_id, type, amount_cents, balance_after, ref_entity, uuid, created_at)
       VALUES (?, 'estorno_ganho', 20000, 0, 'unit_test', lower(hex(randomblob(16))), ?)`,
    );
    insReverse.run(custId, '2026-07-05T00:00:00.000Z');
    await recomputeForCustomers(STORE_CREDIT_CFG, [custId]);
    const balNeg = db.prepare('SELECT store_credit_cents FROM customers WHERE id = ?').get(custId) as { store_credit_cents: number };
    check('reverseGrant permite saldo negativo: -5000', balNeg.store_credit_cents === -5000, `${balNeg.store_credit_cents}`);

    // ---- Loyalty ledger ----
    db.prepare("UPDATE customers SET loyalty_points = 999 WHERE id = ?").run(custId);
    const insPoints = db.prepare(
      `INSERT INTO loyalty_point_movements (customer_id, type, points, balance_after, ref_entity, uuid, created_at)
       VALUES (?, ?, ?, 0, 'unit_test', lower(hex(randomblob(16))), ?)`,
    );
    insPoints.run(custId, 'ganho', 100, '2026-07-01T00:00:00.000Z');
    insPoints.run(custId, 'resgate', 30, '2026-07-02T00:00:00.000Z');
    insPoints.run(custId, 'ganho', 50, '2026-07-03T00:00:00.000Z');

    await recomputeForCustomers(LOYALTY_CFG, [custId]);
    const pts = db.prepare('SELECT loyalty_points FROM customers WHERE id = ?').get(custId) as { loyalty_points: number };
    check('loyalty recompute: saldo 120', pts.loyalty_points === 120, `${pts.loyalty_points}`);
  }

  closeDb();
  console.log(failures === 0 ? '\nFase 8b: TODOS OS TESTES PASSARAM' : `\n${failures} falha(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
