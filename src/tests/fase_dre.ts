import { randomUUID } from 'node:crypto';
import { migrateUp } from '../core/database/migrator';
import { runSeeds } from '../core/database/seeds';
import { getSqlite, closeDb } from '../core/database/connection';
import { resetTestDb } from './resetTestDb';
import { demonstrativoResultado, type DreReport } from '../modules/dre/report';

let failures = 0;

function check(label: string, ok: boolean, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures++;
}

function catIdByKey(key: string): number {
  return (getSqlite().prepare("SELECT id FROM dre_categories WHERE key = ?").get(key) as { id: number }).id;
}

async function main() {
  resetTestDb();
  migrateUp();
  runSeeds();

  const db = getSqlite();

  // ── 1. Schema ──────────────────────────────────────────────
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='dre_categories'").all() as { name: string }[];
  check('dre_categories existe', tables.length === 1);

  const cols = db.prepare("PRAGMA table_info('dre_categories')").all() as { name: string }[];
  for (const col of ['id', 'key', 'label', 'dre_line', 'source', 'system', 'adjustment_bps', 'sort', 'active', 'uuid']) {
    check(`dre_categories tem coluna ${col}`, cols.some(c => c.name === col));
  }

  // payables tem dre_category_id (adicionado pela migracao do DRE)
  const payCols = db.prepare("PRAGMA table_info('payables')").all() as { name: string }[];
  check('payables tem dre_category_id', payCols.some(c => c.name === 'dre_category_id'));

  // ── 2. Seed data (6 categorias do sistema) ─────────────────
  const seedRows = db.prepare("SELECT key, dre_line, source, system FROM dre_categories WHERE deleted_at IS NULL ORDER BY sort").all() as {
    key: string; dre_line: string; source: string; system: number;
  }[];
  check('6 categorias do sistema semeadas', seedRows.length === 6);

  const expectedSeeds = [
    { key: 'receita_bruta_vendas', dre_line: 'receita_bruta', source: 'sales_revenue', system: 1 },
    { key: 'impostos_sobre_vendas', dre_line: 'deducoes', source: 'manual', system: 1 },
    { key: 'cmv', dre_line: 'cmv', source: 'cogs', system: 1 },
    { key: 'outras_despesas_operacionais', dre_line: 'despesas_operacionais', source: 'manual', system: 1 },
    { key: 'taxas_cartao', dre_line: 'despesas_financeiras', source: 'card_fees', system: 1 },
    { key: 'outras_despesas_financeiras', dre_line: 'despesas_financeiras', source: 'manual', system: 1 },
  ];
  for (const exp of expectedSeeds) {
    const found = seedRows.some(r => r.key === exp.key && r.dre_line === exp.dre_line && r.source === exp.source && r.system === exp.system);
    check(`seed ${exp.key} correta`, found);
  }

  // ── 3. Categorias: CRUD manual ────────────────────────────
  const receitaBrutaId = catIdByKey('receita_bruta_vendas');
  const cmvId = catIdByKey('cmv');
  const taxasCartaoId = catIdByKey('taxas_cartao');
  const outrasDespOpId = catIdByKey('outras_despesas_operacionais');
  const outrasDespFinId = catIdByKey('outras_despesas_financeiras');
  const impostosId = catIdByKey('impostos_sobre_vendas');

  // Criar categoria manual
  const manKey = `manual_${randomUUID().slice(0, 8)}`;
  db.prepare(
    `INSERT INTO dre_categories (key, label, dre_line, source, system, adjustment_bps, sort, uuid)
     VALUES (?, ?, ?, 'manual', 0, 0, 10, ?)`,
  ).run(manKey, 'Aluguel', 'despesas_operacionais', randomUUID());
  const catAluguelId = (db.prepare("SELECT id FROM dre_categories WHERE key = ?").get(manKey) as { id: number }).id;
  check('categoria manual Aluguel criada', catAluguelId > 0);

  // Categoria com adjustment_bps
  const adjKey = `manual_${randomUUID().slice(0, 8)}`;
  db.prepare(
    `INSERT INTO dre_categories (key, label, dre_line, source, system, adjustment_bps, sort, uuid)
     VALUES (?, ?, ?, 'manual', 0, 1500, 20, ?)`,
  ).run(adjKey, 'Projecao de vendas', 'receita_bruta', randomUUID());
  const catProjId = (db.prepare("SELECT id FROM dre_categories WHERE key = ?").get(adjKey) as { id: number }).id;
  check('categoria com adjustment_bps=1500', (db.prepare('SELECT adjustment_bps FROM dre_categories WHERE id=?').get(catProjId) as { adjustment_bps: number }).adjustment_bps === 1500);

  // DreLine invalido deve rejeitar (CHECK constraint)
  let rejeitou = false;
  try {
    db.prepare(
      `INSERT INTO dre_categories (key, label, dre_line, source, system, adjustment_bps, sort, uuid)
       VALUES (?, ?, ?, 'manual', 0, 0, 99, ?)`,
    ).run('bad_line', 'Teste', 'invalida', randomUUID());
  } catch { rejeitou = true; }
  check('dre_line invalida rejeitada pelo CHECK', rejeitou);

  // adjustment_bps fora do range
  let rejeitouBps = false;
  try {
    db.prepare(
      `INSERT INTO dre_categories (key, label, dre_line, source, system, adjustment_bps, sort, uuid)
       VALUES (?, ?, ?, 'manual', 0, 20000, 99, ?)`,
    ).run('bad_bps', 'Teste', 'deducoes', randomUUID());
  } catch { rejeitouBps = true; }
  check('adjustment_bps > 10000 rejeitado', rejeitouBps);

  // Atualizar categoria manual
  db.prepare("UPDATE dre_categories SET label = 'Aluguel + Condominio' WHERE id = ?").run(catAluguelId);
  check('categoria renomeada', (db.prepare('SELECT label FROM dre_categories WHERE id=?').get(catAluguelId) as { label: string }).label === 'Aluguel + Condominio');

  // Atualizar adjustment_bps
  db.prepare("UPDATE dre_categories SET adjustment_bps = 500 WHERE id = ?").run(catAluguelId);
  check('adjustment_bps alterado para 500', (db.prepare('SELECT adjustment_bps FROM dre_categories WHERE id=?').get(catAluguelId) as { adjustment_bps: number }).adjustment_bps === 500);

  // Desativar categoria
  db.prepare("UPDATE dre_categories SET active = 0 WHERE id = ?").run(catAluguelId);
  check('categoria desativada', (db.prepare('SELECT active FROM dre_categories WHERE id=?').get(catAluguelId) as { active: number }).active === 0);
  db.prepare("UPDATE dre_categories SET active = 1 WHERE id = ?").run(catAluguelId);

  // Soft-delete categoria manual
  db.prepare("UPDATE dre_categories SET deleted_at = datetime('now') WHERE id = ?").run(catAluguelId);
  check('categoria manual soft-deletada', (db.prepare('SELECT deleted_at FROM dre_categories WHERE id=?').get(catAluguelId) as { deleted_at: string | null }).deleted_at !== null);

  // Criar outra para usar nos testes de relatorio
  const aluguelKey2 = `manual_${randomUUID().slice(0, 8)}`;
  db.prepare(
    `INSERT INTO dre_categories (key, label, dre_line, source, system, adjustment_bps, sort, uuid)
     VALUES (?, ?, ?, 'manual', 0, 0, 10, ?)`,
  ).run(aluguelKey2, 'Aluguel', 'despesas_operacionais', randomUUID());
  const catAluguel2Id = (db.prepare("SELECT id FROM dre_categories WHERE key = ?").get(aluguelKey2) as { id: number }).id;

  // Sistema: tentar excluir categoria system=1 deve ser bloqueado (rotas tratam, mas o SQL permite - testamos a logica)
  // O CHECK nao impede, mas a rota DELETE /categories/:id verifica before.system
  // Testamos a constraint UNIQUE em key
  let dupKey = false;
  try {
    db.prepare(
      `INSERT INTO dre_categories (key, label, dre_line, source, system, adjustment_bps, sort, uuid)
       VALUES (?, ?, ?, 'manual', 0, 0, 99, ?)`,
    ).run('receita_bruta_vendas', 'Duplicada', 'receita_bruta', randomUUID());
  } catch { dupKey = true; }
  check('key duplicada rejeitada (UNIQUE)', dupKey);

  // ── 4. Relatorio DRE: cenario basico (sem dados) ─────────
  let report = demonstrativoResultado('2000-01-01', '2099-12-31');
  check('relatorio tem from/to', report.from === '2000-01-01' && report.to === '2099-12-31');
  check('relatorio tem 5 linhas', Object.keys(report.lines).length === 5);
  check('totals existe', typeof report.totals === 'object');
  // Tudo zero
  check('receita bruta real = 0', report.totals.receitaBrutaReal === 0);
  check('resultado liquido real = 0', report.totals.resultadoLiquidoReal === 0);

  // ── 5. Relatorio com vendas ────────────────────────────────
  // Criar produto
  const prodId = Number(db.prepare(
    "INSERT INTO products (name, price_cents, cost_cents, product_type, track_stock, uuid) VALUES (?, ?, ?, 'fisico', 1, ?)",
  ).run('Camiseta', 5000, 2000, randomUUID()).lastInsertRowid);
  check('produto criado para venda', prodId > 0);

  // Criar venda concluida com 3 itens (2+1) = total_cents 15000
  const saleId = Number(db.prepare(
    `INSERT INTO sales (status, subtotal_cents, discount_cents, surcharge_cents, total_cents, payment_method, paid_cents, change_cents, user_id, uuid, created_at)
     VALUES ('concluida', 15000, 0, 0, 15000, 'dinheiro', 15000, 0, 1, ?, datetime('now'))`,
  ).run(randomUUID()).lastInsertRowid);
  check('venda criada', saleId > 0);

  // Itens: qty=2 cost_cents=2000 (por unidade), qty=1 cost_cents=2000
  db.prepare(
    `INSERT INTO sale_items (sale_id, product_id, product_name, qty, unit_price_cents, total_cents, cost_cents)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(saleId, prodId, 'Camiseta', 2, 5000, 10000, 2000);
  db.prepare(
    `INSERT INTO sale_items (sale_id, product_id, product_name, qty, unit_price_cents, total_cents, cost_cents)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(saleId, prodId, 'Camiseta', 1, 5000, 5000, 2000);

  report = demonstrativoResultado('2000-01-01', '2099-12-31');
  // total_cents = 15000 (da tabela sales)
  // CMV = qty*cost_cents = 2*2000 + 1*2000 = 6000
  check('receita bruta = 15000 (total_cents da venda)', report.totals.receitaBrutaReal === 15000);
  check('CMV = 6000 (2*2000 + 1*2000)', report.totals.lucroBrutoReal === 15000 - 0 - 6000);
  check('receita_bruta real = 15000', report.lines.receita_bruta.realCents === 15000);

  // ── 6. Venda cancelada NÃO entra ──────────────────────────
  const cancelId = Number(db.prepare(
    `INSERT INTO sales (status, subtotal_cents, discount_cents, surcharge_cents, total_cents, payment_method, paid_cents, change_cents, user_id, uuid, created_at)
     VALUES ('cancelada', 99999, 0, 0, 99999, 'dinheiro', 0, 0, 1, ?, datetime('now'))`,
  ).run(randomUUID()).lastInsertRowid);
  db.prepare(
    `INSERT INTO sale_items (sale_id, product_id, product_name, qty, unit_price_cents, total_cents, cost_cents)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(cancelId, prodId, 'Cancelada', 1, 99999, 99999, 50000);
  report = demonstrativoResultado('2000-01-01', '2099-12-31');
  check('venda cancelada nao infla receita (continua 15000)', report.totals.receitaBrutaReal === 15000);
  check('venda cancelada nao infla CMV', report.totals.lucroBrutoReal === 15000 - 0 - 6000);

  // ── 7. Taxas de cartao ─────────────────────────────────────
  const saleCartaoId = Number(db.prepare(
    `INSERT INTO sales (status, subtotal_cents, discount_cents, surcharge_cents, total_cents, payment_method, paid_cents, change_cents, user_id, uuid, created_at)
     VALUES ('concluida', 3000, 0, 0, 3000, 'cartao_credito', 3000, 0, 1, ?, datetime('now'))`,
  ).run(randomUUID()).lastInsertRowid);
  db.prepare(
    `INSERT INTO sale_items (sale_id, product_id, product_name, qty, unit_price_cents, total_cents, cost_cents)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(saleCartaoId, prodId, 'Camiseta', 1, 3000, 3000, 1000);
  db.prepare(
    `INSERT INTO sale_payments (sale_id, payment_method_id, method_name, method_type, amount_cents, fee_cents, received_cents, change_cents)
     VALUES (?, NULL, 'Cartao Credito', 'cartao_credito', 3000, 150, 3000, 0)`,
  ).run(saleCartaoId);
  report = demonstrativoResultado('2000-01-01', '2099-12-31');
  check('taxas cartao = 150', report.lines.despesas_financeiras.categories.find(c => c.key === 'taxas_cartao')?.realCents === 150);
  check('receita bruta = 18000 (15000+3000)', report.totals.receitaBrutaReal === 18000);

  // ── 8. Contas a pagar (manual) ─────────────────────────────
  db.prepare(
    `INSERT INTO payables (description, amount_cents, due_date, status, dre_category_id, uuid)
     VALUES (?, ?, ?, 'aberta', ?, ?)`,
  ).run('Conta de luz', 120000, '2026-07-15', impostosId, randomUUID());
  db.prepare(
    `INSERT INTO payables (description, amount_cents, due_date, status, dre_category_id, uuid)
     VALUES (?, ?, ?, 'paga', ?, ?)`,
  ).run('Aluguel', 250000, '2026-07-10', outrasDespOpId, randomUUID());
  db.prepare(
    `INSERT INTO payables (description, amount_cents, due_date, status, dre_category_id, uuid)
     VALUES (?, ?, ?, 'aberta', ?, ?)`,
  ).run('Juros bancarios', 30000, '2026-07-20', outrasDespFinId, randomUUID());

  report = demonstrativoResultado('2000-01-01', '2099-12-31');
  // deducoes (impostos_sobre_vendas) = 1200 (120000 centavos = R$1200)
  check('deducoes (impostos) = 120000', report.lines.deducoes.realCents === 120000);
  // despesas_operacionais (outras_despesas_operacionais) = 250000
  const despOp = report.lines.despesas_operacionais.categories.find(c => c.key === 'outras_despesas_operacionais');
  check('despesas operacionais = 250000 (aluguel pago)', despOp?.realCents === 250000);
  // despesas_financeiras (outras_despesas_financeiras) = 30000
  const despFin = report.lines.despesas_financeiras.categories.find(c => c.key === 'outras_despesas_financeiras');
  check('despesas financeiras manuais = 30000', despFin?.realCents === 30000);

  // ── 9. Conta cancelada NÃO entra ───────────────────────────
  db.prepare(
    `INSERT INTO payables (description, amount_cents, due_date, status, dre_category_id, uuid)
     VALUES (?, ?, ?, 'cancelada', ?, ?)`,
  ).run('Cancelada', 999999, '2026-07-01', impostosId, randomUUID());
  report = demonstrativoResultado('2000-01-01', '2099-12-31');
  check('cancelada nao infla deducoes (continua 120000)', report.lines.deducoes.realCents === 120000);

  // ── 10. Conta sem categoria → despesas_operacionais ────────
  db.prepare(
    `INSERT INTO payables (description, amount_cents, due_date, status, uuid)
     VALUES (?, ?, ?, 'aberta', ?)`,
  ).run('Sem categoria', 50000, '2026-07-05', randomUUID());
  report = demonstrativoResultado('2000-01-01', '2099-12-31');
  // O total da linha despesas_operacionais deve receber +50000 (somada a primeira categoria manual encontrada)
  // Total = 250000 (outras_despesas_operacionais) + 50000 (sem categoria, cai na primeira manual) = 300000
  check('conta sem categoria adiciona 50000 ao total de despesas_operacionais', report.lines.despesas_operacionais.realCents === 300000);

  // ── 11. Filtro por data ────────────────────────────────────
  report = demonstrativoResultado('2026-07-01', '2026-07-31');
  check('filtro julho: deducoes = 120000 (conta luz)', report.lines.deducoes.realCents === 120000);
  check('filtro julho: desp operacionais = 300000 (250000 + 50000 sem cat)', report.lines.despesas_operacionais.realCents === 300000);

  report = demonstrativoResultado('2025-01-01', '2025-12-31');
  check('filtro 2025: deducoes = 0 (fora do periodo)', report.lines.deducoes.realCents === 0);

  // ── 12. Adjustment BPS ─────────────────────────────────────
  // Ajuste de +10% na projecao (1500 bps = 15%)
  // Manual category com adjustment 1500 bps na receita_bruta
  // receita_bruta real = 15000 (vendas) + 0 (projecao nao tem valor real)
  // Ajuste da projecao = 0 + round(0 * 1500 / 10000) = 0
  // Ajuste da receita_bruta_vendas = 18000 + round(18000 * 0 / 10000) = 18000
  check('adjustment 0 = mesmo valor',
    report.lines.receita_bruta.categories.find(c => c.key === 'receita_bruta_vendas')?.adjustedCents ===
    report.lines.receita_bruta.categories.find(c => c.key === 'receita_bruta_vendas')?.realCents);

  // Categoria manual na receita_bruta com adjustment=1500 bps
  // Ela nao tem valor real (0), entao adjusted = 0
  const projCat = report.lines.receita_bruta.categories.find(c => c.key === adjKey);
  check(`projecao real = 0`, projCat?.realCents === 0);
  check(`projecao adjusted = 0 (15% de 0 = 0)`, projCat?.adjustedCents === 0);

  // ── 13. totais do relatorio ────────────────────────────────
  report = demonstrativoResultado('2000-01-01', '2099-12-31');
  // Receita bruta = 18000 (15000 + 3000)
  // Deducoes = 120000
  // Receita liquida = 18000 - 120000 = -102000
  // CMV = 7000 (6000 + 1000)
  // Lucro bruto = -102000 - 7000 = -109000
  // Desp operacionais = 300000
  // Resultado operacional = -109000 - 300000 = -409000
  // Desp financeiras = 150 (taxas) + 30000 (manual) = 30150
  // Resultado liquido = -409000 - 30150 = -439150
  check('receita bruta = 18000', report.totals.receitaBrutaReal === 18000);
  check('receita liquida = 18000 - 120000', report.totals.receitaLiquidaReal === 18000 - 120000);
  check('lucro bruto = 18000 - 120000 - 7000', report.totals.lucroBrutoReal === 18000 - 120000 - 7000);
  check('resultado operacional = lucro bruto - 300000', report.totals.resultadoOperacionalReal === (18000 - 120000 - 7000) - 300000);
  check('resultado liquido = resultado operacional - 30150', report.totals.resultadoLiquidoReal === (18000 - 120000 - 7000 - 300000) - 30150);

  // ── 14. Soft-delete nao aparece ────────────────────────────
  const reportAntes = demonstrativoResultado('2000-01-01', '2099-12-31');
  const catAluguelAntes = reportAntes.lines.despesas_operacionais.categories.find(c => c.id === catAluguel2Id);
  check('categoria ativa aparece no relatorio', catAluguelAntes !== undefined);

  db.prepare("UPDATE dre_categories SET deleted_at = datetime('now') WHERE id = ?").run(catAluguel2Id);
  const reportDepois = demonstrativoResultado('2000-01-01', '2099-12-31');
  const catAluguelDepois = reportDepois.lines.despesas_operacionais.categories.find(c => c.id === catAluguel2Id);
  check('categoria soft-deletada NAO aparece no relatorio', catAluguelDepois === undefined);

  closeDb();
  console.log(failures === 0 ? '\nDRE: TODOS OS TESTES PASSARAM' : `\n${failures} falha(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
