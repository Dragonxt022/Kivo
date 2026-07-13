/**
 * Teste da DoD da Fase 4 (módulo finance):
 * abertura/fechamento de caixa confere; relatório de fluxo bate com lançamentos;
 * pagar/receber integra com a gaveta; RBAC e auditoria aplicados.
 */
import { migrateUp } from '../core/database/migrator';
import { runSeeds } from '../core/database/seeds';
import { createServer } from '../core/server';
import { getSqlite, closeDb } from '../core/database/connection';
import { resetTestDb, activateTestLicense } from './resetTestDb';
import { unwrap } from './testUtils';

const PORT = Number(process.env.KATSU_PORT ?? 3499);
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
  const F = '/api/finance';

  const admin = await loginAs('admin', 'admin');
  check('login admin', admin !== null);
  await api('/api/users', { method: 'POST', body: JSON.stringify({ username: 'op4', name: 'op4', password: '123456', roleSlug: 'operador' }) }, admin!);
  const op = await loginAs('op4', '123456');

  // ---- RBAC ----
  check('operador não vê caixa (403)', (await api(`${F}/cash/current`, {}, op!)).status === 403);
  check('operador não abre caixa (403)', (await api(`${F}/cash/open`, { method: 'POST', body: '{}' }, op!)).status === 403);

  // ---- Fechar sem abrir ----
  check('fechar sem caixa aberto → 400', (await api(`${F}/cash/close`, { method: 'POST', body: JSON.stringify({ countedCents: 0 }) }, admin!)).status === 400);

  // ---- Abertura ----
  check('abre caixa com 100,00', (await api(`${F}/cash/open`, { method: 'POST', body: JSON.stringify({ openingCents: 10000 }) }, admin!)).status === 201);
  check('segundo caixa bloqueado (400)', (await api(`${F}/cash/open`, { method: 'POST', body: JSON.stringify({ openingCents: 0 }) }, admin!)).status === 400);

  // ---- Suprimento e sangria ----
  check('suprimento 50,00', (await api(`${F}/cash/movement`, { method: 'POST', body: JSON.stringify({ type: 'suprimento', amountCents: 5000 }) }, admin!)).status === 201);
  check('sangria 20,00', (await api(`${F}/cash/movement`, { method: 'POST', body: JSON.stringify({ type: 'sangria', amountCents: 2000 }) }, admin!)).status === 201);
  check('sangria maior que o caixa → 400', (await api(`${F}/cash/movement`, { method: 'POST', body: JSON.stringify({ type: 'sangria', amountCents: 99999999 }) }, admin!)).status === 400);

  // ---- Contas a pagar/receber (precisam de fornecedor/cliente? opcionais) ----
  const pay = await api(`${F}/payables`, { method: 'POST', body: JSON.stringify({ description: 'Energia', amountCents: 3000, dueDate: '2026-07-10' }) }, admin!);
  check('conta a pagar criada', pay.status === 201);
  const payId = (await unwrap<{ id: number }>(pay)).id;
  const rec = await api(`${F}/receivables`, { method: 'POST', body: JSON.stringify({ description: 'Encomenda', amountCents: 8000, dueDate: '2026-07-10' }) }, admin!);
  check('conta a receber criada', rec.status === 201);
  const recId = (await unwrap<{ id: number }>(rec)).id;

  // O settle exige payments[] — busca formas de pagamento ativas do banco
  const methods = db.prepare("SELECT id, type, name FROM payment_methods WHERE active = 1 AND type != 'prazo'").all() as { id: number; type: string; name: string }[];
  const dinheiro = methods.find((m) => m.type === 'dinheiro')!;
  const pix = methods.find((m) => m.type === 'pix')!;

  const paid = await api(`${F}/payables/${payId}/settle`, { method: 'POST', body: JSON.stringify({
    payments: [{ paymentMethodId: dinheiro.id, amountCents: 3000 }],
  }) }, admin!);
  check('pagar conta gera saída no caixa', paid.status === 200 && (await unwrap<{ registeredInCash: boolean }>(paid)).registeredInCash);
  check('pagar de novo → 400', (await api(`${F}/payables/${payId}/settle`, { method: 'POST', body: JSON.stringify({
    payments: [{ paymentMethodId: pix.id, amountCents: 3000 }],
  }) }, admin!)).status === 400);
  const received = await api(`${F}/receivables/${recId}/settle`, { method: 'POST', body: JSON.stringify({
    payments: [{ paymentMethodId: dinheiro.id, amountCents: 8000 }],
  }) }, admin!);
  check('receber conta gera entrada no caixa', received.status === 200);

  // ---- Fechamento confere (DoD) ----
  // esperado = 100 + 50 - 20 - 30 + 80 = 180,00
  const cur = await unwrap<{ expectedCents: number }>(await api(`${F}/cash/current`, {}, admin!));
  check('esperado = 180,00', cur.expectedCents === 18000, `esperado=${cur.expectedCents}`);
  const close = await api(`${F}/cash/close`, { method: 'POST', body: JSON.stringify({ countedCents: 17500 }) }, admin!);
  const closed = await unwrap<{ expected: number; counted: number; difference: number }>(close);
  check('fechamento confere: esperado 18000', close.status === 200 && closed.expected === 18000);
  check('diferença = -500 (quebra de caixa)', closed.difference === -500, `diff=${closed.difference}`);
  const regRow = db.prepare('SELECT expected_cents, counted_cents, difference_cents FROM cash_registers ORDER BY id DESC LIMIT 1').get() as { expected_cents: number; counted_cents: number; difference_cents: number };
  check('fechamento persistido', regRow.expected_cents === 18000 && regRow.counted_cents === 17500 && regRow.difference_cents === -500);

  // ---- Fluxo bate com lançamentos (DoD) ----
  const flow = await unwrap<{ totals: { entradas: number; saidas: number; saldo: number } }>(await api(`${F}/reports/cashflow`, {}, admin!));
  const sums = db.prepare(
    `SELECT COALESCE(SUM(CASE WHEN direction='entrada' THEN amount_cents END),0) e,
            COALESCE(SUM(CASE WHEN direction='saida' THEN amount_cents END),0) s FROM cash_movements`,
  ).get() as { e: number; s: number };
  check('fluxo bate com lançamentos (entradas)', flow.totals.entradas === sums.e, `${flow.totals.entradas} vs ${sums.e}`);
  check('fluxo bate com lançamentos (saídas)', flow.totals.saidas === sums.s);
  check('saldo do fluxo = esperado do caixa', flow.totals.saldo === 18000);

  // ---- Auditoria ----
  const entities = new Set((db.prepare('SELECT DISTINCT entity FROM audit_logs').all() as { entity: string }[]).map((a) => a.entity));
  check('auditoria cobre cash_register/payable/receivable', ['cash_register', 'payable', 'receivable'].every((e) => entities.has(e)));

  server.close();
  closeDb();
  console.log(failures === 0 ? '\nDoD Fase 4: TODOS OS TESTES PASSARAM' : `\n${failures} falha(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
