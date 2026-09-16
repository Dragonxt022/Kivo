/**
 * Teste: Painel de Controle (módulo overview).
 *
 * Cobre os KPIs (caixa, vendas, estoque, contas), o relatório de estoque por filtro, o
 * relatório de caixas por período e as exportações CSV. Roda contra banco descartável:
 *   node scripts/test-isolated.js src/tests/overview.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { migrateUp } from '../core/database/migrator';
import { runSeeds } from '../core/database/seeds';
import { createServer } from '../core/server';
import { getSqlite, closeDb } from '../core/database/connection';
import { activateTestLicense } from './resetTestDb';

const PORT = Number(process.env.KIVO_PORT ?? 3841);
const base = `http://localhost:${PORT}`;
let failures = 0;

function check(label: string, ok: boolean, extra = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures++;
}

let cookie = '';

async function api(p: string, opts: RequestInit = {}): Promise<Response> {
  return fetch(`${base}${p}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}), ...(opts.headers ?? {}) },
  });
}

async function jsonData<T>(r: Response): Promise<T> {
  const body = (await r.json()) as Record<string, unknown>;
  return (body && typeof body === 'object' && 'data' in body ? body.data : body) as T;
}

function assertBancoDescartavel(): string {
  const alvo = process.env.KIVO_DB_PATH;
  if (!alvo) throw new Error('KIVO_DB_PATH não definida. Rode via scripts/test-isolated.js.');
  if (path.resolve(alvo) === path.resolve(process.cwd(), 'database', 'kivo.db')) {
    throw new Error('Recusado: KIVO_DB_PATH aponta para o banco de dev.');
  }
  return alvo;
}

async function main(): Promise<void> {
  const TMP_DB = assertBancoDescartavel();
  fs.mkdirSync(path.dirname(TMP_DB), { recursive: true });
  fs.rmSync(TMP_DB, { force: true });

  migrateUp();
  runSeeds();
  activateTestLicense();
  const { app } = await createServer();
  const server = app.listen(PORT);
  const db = getSqlite();

  try {
    const login = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'admin', password: 'admin' }) });
    const m = (login.headers.get('set-cookie') ?? '').match(/kivo_session=([^;]+)/);
    cookie = m ? `kivo_session=${m[1]}` : '';
    check('login admin', cookie !== '');
    if (!cookie) return;

    const adminId = (db.prepare("SELECT id FROM users WHERE username = 'admin'").get() as { id: number }).id;

    // Produtos: zerado, baixo e ok.
    const mkProduct = (name: string, qty: number, min: number): number =>
      Number(db.prepare(
        `INSERT INTO products (name, unit, price_cents, cost_cents, track_stock, stock_qty, min_stock, active, uuid)
         VALUES (?, 'un', 1000, 500, 1, ?, ?, 1, ?)`,
      ).run(name, qty, min, randomUUID()).lastInsertRowid);
    const pZero = mkProduct('Zerado', 0, 5);
    const pLow = mkProduct('Baixo', 2, 5);
    mkProduct('Ok', 100, 5);

    // Caixa aberto com movimentos: entradas 100,00, saídas 30,00 → esperado 70,00.
    const regId = Number(db.prepare(
      `INSERT INTO cash_registers (status, opened_by, opening_cents, uuid) VALUES ('aberto', ?, 0, ?)`,
    ).run(adminId, randomUUID()).lastInsertRowid);
    const mv = (dir: string, type: string, cents: number) =>
      db.prepare(
        `INSERT INTO cash_movements (register_id, direction, type, amount_cents, uuid) VALUES (?, ?, ?, ?, ?)`,
      ).run(regId, dir, type, cents, randomUUID());
    mv('entrada', 'venda', 10000);
    mv('saida', 'sangria', 3000);

    // Contas: 1 a pagar vencida, 1 a pagar a vencer (3 dias), 1 a pagar distante, 1 a receber.
    const payable = (due: string) =>
      db.prepare(`INSERT INTO payables (description, amount_cents, due_date, status, uuid) VALUES ('Conta', 1000, ?, 'aberta', ?)`)
        .run(due, randomUUID());
    payable(new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10));
    payable(new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10));
    payable(new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10));
    db.prepare(`INSERT INTO receivables (description, amount_cents, due_date, status, uuid) VALUES ('Receber', 2000, ?, 'aberta', ?)`)
      .run(new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10), randomUUID());

    // ── KPIs ──
    const kpis = await jsonData<{
      cash: { open: boolean; expectedCents: number };
      salesToday: { count: number };
      stock: { lowCount: number; zeroCount: number };
      payables: { openCount: number; overdueCount: number; dueSoonCount: number };
      receivables: { openCount: number };
    }>(await api('/api/overview/kpis'));
    check('KPI caixa aberto com esperado', kpis.cash.open && kpis.cash.expectedCents === 7000, String(kpis.cash.expectedCents));
    check('KPI estoque (2 abaixo do mínimo, 1 zerado)', kpis.stock.lowCount === 2 && kpis.stock.zeroCount === 1, `low=${kpis.stock.lowCount} zero=${kpis.stock.zeroCount}`);
    check('KPI contas a pagar (3 abertas, 1 vencida, 1 a vencer)', kpis.payables.openCount === 3 && kpis.payables.overdueCount === 1 && kpis.payables.dueSoonCount === 1, JSON.stringify(kpis.payables));
    check('KPI contas a receber (1 aberta)', kpis.receivables.openCount === 1);

    // ── Estoque ──
    const zero = await jsonData<{ rows: { id: number }[] }>(await api('/api/overview/stock?filter=zero'));
    check('filtro zerados traz só o zerado', zero.rows.length === 1 && zero.rows[0].id === pZero);
    const low = await jsonData<{ rows: { id: number }[] }>(await api('/api/overview/stock?filter=low'));
    check('filtro abaixo do mínimo traz zerado + baixo', low.rows.length === 2 && low.rows.some((r) => r.id === pLow) && low.rows.some((r) => r.id === pZero));
    const all = await jsonData<{ rows: unknown[] }>(await api('/api/overview/stock?filter=all'));
    check('filtro todos traz os 3', all.rows.length === 3);

    const stockCsv = await api('/api/overview/stock/export.csv?filter=zero');
    const stockCsvText = await stockCsv.text();
    check('export CSV de estoque', stockCsv.ok && stockCsvText.includes('Produto') && stockCsvText.includes('Zerado'), `len=${stockCsvText.length}`);

    // ── Caixas ──
    const cash = await jsonData<{ rows: { id: number }[]; totals: { entradas: number; saidas: number; count: number } }>(
      await api('/api/overview/cash'),
    );
    check('relatório de caixa no período', cash.rows.some((r) => r.id === regId) && cash.totals.entradas === 10000 && cash.totals.saidas === 3000, JSON.stringify(cash.totals));

    const cashCsv = await api('/api/overview/cash/export.csv');
    const cashCsvText = await cashCsv.text();
    check('export CSV de caixas', cashCsv.ok && cashCsvText.includes('Abertura') && cashCsvText.includes('#'), `len=${cashCsvText.length}`);

    // ── Página e menu (módulo sempre ativo) ──
    const pageRes = await api('/app/overview');
    const html = await pageRes.text();
    check('página do Painel renderiza', pageRes.ok && html.includes('Painel'), String(pageRes.status));
    check('item do menu Painel aparece', html.includes('/app/overview'));
  } finally {
    server.close();
    closeDb();
  }

  console.log(failures ? `\n${failures} falha(s).` : '\nTodos os testes passaram.');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
