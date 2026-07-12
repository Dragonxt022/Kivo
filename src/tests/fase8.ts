/**
 * Fase 8 — DRE (Demonstrativo de Resultado) + Categorias.
 *
 * 1. DRE Categories CRUD: criar, editar, excluir com validações
 * 2. DRE Report: cria vendas + contas a pagar e confere todas as
 *    5 linhas e 10 totais do demonstrativo
 * 3. Uncategorized payables fallback: conta sem categoria aparece
 *    em despesas_operacionais
 */
import { migrateUp } from '../core/database/migrator';
import { runSeeds } from '../core/database/seeds';
import { createServer } from '../core/server';
import { getSqlite, closeDb } from '../core/database/connection';
import { resetTestDb, activateTestLicense } from './resetTestDb';

const PORT = Number(process.env.KATSU_PORT ?? 3899);
const base = `http://localhost:${PORT}`;
let failures = 0;

function check(label: string, ok: boolean, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures++;
}

async function api(path: string, opts: RequestInit = {}, cookie?: string) {
  return fetch(`${base}${path}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}), ...(opts.headers ?? {}) },
  });
}

async function loginAs(u: string, p: string): Promise<string | null> {
  const r = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: u, password: p }) });
  if (!r.ok) return null;
  const m = (r.headers.get('set-cookie') ?? '').match(/katsu_session=([^;]+)/);
  return m ? `katsu_session=${m[1]}` : null;
}

async function main() {
  resetTestDb();
  migrateUp();
  runSeeds();
  activateTestLicense();
  const { app } = await createServer();
  const server = app.listen(PORT);
  const db = getSqlite();

  const admin = await loginAs('admin', 'admin');
  check('login admin', admin !== null);

  // ---- Helpers ----
  const F = '/api/finance';
  const DRE = '/api/dre';

  // ====================================================================
  // PARTE 1 — DRE CATEGORIES CRUD
  // ====================================================================
  {
    const cats = await (await api(`${DRE}/categories`, {}, admin!)).json() as any[];
    check('categorias iniciais: 6 system', cats.length === 6, String(cats.length));
    check('contém receita_bruta_vendas', cats.some((c: any) => c.key === 'receita_bruta_vendas'));
    check('contém taxas_cartao', cats.some((c: any) => c.key === 'taxas_cartao'));

    // Criar categoria manual
    const created = await (await api(`${DRE}/categories`, {
      method: 'POST', body: JSON.stringify({ label: 'Teste DRE', dreLine: 'despesas_operacionais', adjustmentBps: 500 }),
    }, admin!)).json() as any;
    check('criou categoria manual', created.id > 0 && created.source === 'manual' && !created.system, created.label);
    const catId = created.id;

    // Criar com dreLine inválido → 400
    const badLine = await api(`${DRE}/categories`, {
      method: 'POST', body: JSON.stringify({ label: 'Invalida', dreLine: 'receita_bruta' }),
    }, admin!);
    check('dreLine inválido → 400', badLine.status === 400);

    // Ajuste fora do range → 400
    const badAdj = await api(`${DRE}/categories`, {
      method: 'POST', body: JSON.stringify({ label: 'Ajustadao', dreLine: 'despesas_operacionais', adjustmentBps: 99999 }),
    }, admin!);
    check('adjustmentBps > 10000 → 400', badAdj.status === 400);

    // Editar label
    const edited = await (await api(`${DRE}/categories/${catId}`, {
      method: 'PUT', body: JSON.stringify({ label: 'Teste Alterado' }),
    }, admin!)).json() as any;
    check('editou label', edited.label === 'Teste Alterado');

    // Editar dreLine em categoria system → 400
    const sysCatId = cats.find((c: any) => c.key === 'impostos_sobre_vendas').id;
    const changeLine = await api(`${DRE}/categories/${sysCatId}`, {
      method: 'PUT', body: JSON.stringify({ dreLine: 'despesas_operacionais' }),
    }, admin!);
    check('system não troca de linha → 400', changeLine.status === 400);

    // Excluir system → 409
    const delSys = await api(`${DRE}/categories/${sysCatId}`, { method: 'DELETE' }, admin!);
    check('system não pode ser excluída → 409', delSys.status === 409);

    // Excluir manual sem uso → 200
    const delOk = await api(`${DRE}/categories/${catId}`, { method: 'DELETE' }, admin!);
    check('categoria não usada foi excluída', delOk.status === 200);

    const afterDel = await api(`${DRE}/categories`, {}, admin!);
    check('total voltou a 6', ((await afterDel.json()) as any[]).length === 6);
  }

  // ====================================================================
  // PARTE 2 — DRE REPORT
  // ====================================================================
  {
    // ---- Setup: produto, formas de pagamento ----
    const prod = db.prepare(
      `INSERT INTO products (name, price_cents, cost_cents, track_stock, uuid)
       VALUES ('Prod DRE', 5000, 2000, 1, lower(hex(randomblob(16))))`,
    ).run();
    const prodId = Number(prod.lastInsertRowid);
    db.prepare('INSERT INTO stock_movements (product_id, type, qty, balance_after, uuid) VALUES (?, ?, ?, ?, lower(hex(randomblob(16))))')
      .run(prodId, 'entrada', 100, 100);

    // Criar forma de débito com taxa
    const debMethod = db.prepare(
      `INSERT INTO payment_methods (name, type, fee_bps, sort, uuid) VALUES ('Debito Stone', 'debito', 160, 99, lower(hex(randomblob(16))))`,
    ).run();
    const pixMethod = db.prepare(
      `SELECT id FROM payment_methods WHERE type = 'pix' AND active = 1 LIMIT 1`,
    ).get() as { id: number };

    // IDs das categorias DRE
    const cats = db.prepare('SELECT id, key FROM dre_categories WHERE deleted_at IS NULL').all() as { id: number; key: string }[];
    const deducoesCat = cats.find((c) => c.key === 'impostos_sobre_vendas')!.id;
    const operacionalCat = cats.find((c) => c.key === 'outras_despesas_operacionais')!.id;
    const financeiraCat = cats.find((c) => c.key === 'outras_despesas_financeiras')!.id;

    // ---- Criar payables com categorias ----
    const p1 = await (await api(`${F}/payables`, {
      method: 'POST', body: JSON.stringify({
        description: 'Imposto', amountCents: 1500, dueDate: '2026-07-10', dreCategoryId: deducoesCat,
      }),
    }, admin!)).json() as any;
    check('payable deducoes criada', p1.id > 0);

    const p2 = await (await api(`${F}/payables`, {
      method: 'POST', body: JSON.stringify({
        description: 'Aluguel', amountCents: 4000, dueDate: '2026-07-15', dreCategoryId: operacionalCat,
      }),
    }, admin!)).json() as any;
    check('payable operacional criada', p2.id > 0);

    const p3 = await (await api(`${F}/payables`, {
      method: 'POST', body: JSON.stringify({
        description: 'Juros bancários', amountCents: 2500, dueDate: '2026-07-20', dreCategoryId: financeiraCat,
      }),
    }, admin!)).json() as any;
    check('payable financeira criada', p3.id > 0);

    // Payable SEM categoria (deve cair em despesas_operacionais como fallback)
    const p4 = await (await api(`${F}/payables`, {
      method: 'POST', body: JSON.stringify({
        description: 'Material escritório', amountCents: 1800, dueDate: '2026-07-12',
      }),
    }, admin!)).json() as any;
    check('payable sem categoria criada', p4.id > 0);

    // ---- Criar vendas ----
    const reg = await (await api(`${F}/cash/open`, { method: 'POST', body: JSON.stringify({ openingCents: 5000 }) }, admin!)).json() as any;
    check('caixa aberto', reg.ok);

    // Venda 1: PIX (sem taxa), 2 unidades = 10000
    const s1 = await (await api('/api/store/sales', {
      method: 'POST', body: JSON.stringify({
        items: [{ productId: prodId, qty: 2 }],
        payments: [{ methodId: pixMethod.id, amountCents: 10000 }],
      }),
    }, admin!)).json() as any;
    check('venda 1 (PIX) concluída', s1.ok);

    // Venda 2: Débito Stone (1,6% = 80 centavos), 1 unidade = 5000
    const s2 = await (await api('/api/store/sales', {
      method: 'POST', body: JSON.stringify({
        items: [{ productId: prodId, qty: 1 }],
        payments: [{ methodId: Number(debMethod.lastInsertRowid), amountCents: 5000 }],
      }),
    }, admin!)).json() as any;
    check('venda 2 (Débito Stone) concluída', s2.ok);

    // ---- Consultar DRE ----
    const report = await (await api(`${DRE}/report?from=2026-07-01&to=2026-07-31`, {}, admin!)).json() as any;

    // Linhas
    const receita = report.lines.receita_bruta;
    const deducoes = report.lines.deducoes;
    const cmv = report.lines.cmv;
    const opEx = report.lines.despesas_operacionais;
    const finEx = report.lines.despesas_financeiras;

    check('receita_bruta = 15000 (10000+5000)', receita.realCents === 15000, `${receita.realCents}`);
    check('deducoes = 1500 (payable impostos)', deducoes.realCents === 1500, `${deducoes.realCents}`);
    check('cmv = 6000 (2*2000 + 1*2000)', cmv.realCents === 6000, `${cmv.realCents}`);
    // despesas_operacionais = 4000 (payable aluguel) + 1800 (uncategorized) = 5800
    check('despesas_operacionais = 5800 (4000+1800)', opEx.realCents === 5800, `${opEx.realCents}`);
    // despesas_financeiras = 80 (card fee) + 2500 (payable) = 2580
    check('despesas_financeiras = 2580 (80 taxa + 2500 payable)', finEx.realCents === 2580, `${finEx.realCents}`);

    // Totais
    const t = report.totals;
    check('receita_liquida = 13500 (15000-1500)', t.receitaLiquidaReal === 13500, `${t.receitaLiquidaReal}`);
    check('lucro_bruto = 7500 (13500-6000)', t.lucroBrutoReal === 7500, `${t.lucroBrutoReal}`);
    check('resultado_operacional = 1700 (7500-5800)', t.resultadoOperacionalReal === 1700, `${t.resultadoOperacionalReal}`);
    check('resultado_liquido = -880 (1700-2580)', t.resultadoLiquidoReal === -880, `${t.resultadoLiquidoReal}`);

    // ---- DRE com período vazio ----
    const empty = await (await api(`${DRE}/report?from=2025-01-01&to=2025-01-31`, {}, admin!)).json() as any;
    check('DRE vazio: receita=0', empty.lines.receita_bruta.realCents === 0);
    check('DRE vazio: todas as 5 linhas existem', Object.keys(empty.lines).length === 5);

    // ---- DRE categories: categoria manual tem adjustment_bps ----
    const deducoesCats = deducoes.categories as any[];
    const manualCat = deducoesCats.find((c: any) => c.key === 'impostos_sobre_vendas');
    check('categoria no DRE tem adjustmentBps', manualCat?.adjustmentBps === 0);
    check('adjustedCents = realCents quando adjustmentBps=0', manualCat?.adjustedCents === manualCat?.realCents);

    // ---- Fechar caixa pra não poluir ----
    await api(`${F}/cash/close`, { method: 'POST', body: JSON.stringify({ countedCents: 20000 }) }, admin!);
  }

  // ====================================================================
  // PARTE 3 — IN-USE CATEGORY DELETE BLOCKED
  // ====================================================================
  {
    const cats = await (await api(`${DRE}/categories`, {}, admin!)).json() as any[];
    const operacionalCat = cats.find((c: any) => c.key === 'outras_despesas_operacionais');
    if (operacionalCat) {
      // outras_despesas_operacionais é system=1, não pode ser excluída
      const delOp = await api(`${DRE}/categories/${operacionalCat.id}`, { method: 'DELETE' }, admin!);
      check('system category delete blocked → 409', delOp.status === 409);
    }

    // Criar categoria manual e uma payable vinculada, depois tentar excluir
    const created = await (await api(`${DRE}/categories`, {
      method: 'POST', body: JSON.stringify({ label: 'Frete', dreLine: 'despesas_operacionais' }),
    }, admin!)).json() as any;
    await api(`${F}/payables`, {
      method: 'POST', body: JSON.stringify({
        description: 'Frete teste', amountCents: 999, dueDate: '2026-08-01', dreCategoryId: created.id,
      }),
    }, admin!);
    const delInUse = await api(`${DRE}/categories/${created.id}`, { method: 'DELETE' }, admin!);
    check('in-use category delete blocked → 409', delInUse.status === 409);
    const delBody = await delInUse.json() as any;
    check('mensagem menciona contas a pagar', delBody.error?.includes('conta'));
  }

  server.close();
  closeDb();
  console.log(failures === 0 ? '\nDoD Fase 8: TODOS OS TESTES PASSARAM' : `\n${failures} falha(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
