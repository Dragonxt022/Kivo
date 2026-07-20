/**
 * Teste da Parte A (a prazo com parcelamento + carnê impresso):
 * venda a prazo parcelada gera N recebíveis com valores/vencimentos corretos,
 * carnê imprime uma via por parcela, e o cancelamento reverte todas as parcelas.
 */
import { migrateUp } from '../core/database/migrator';
import { runSeeds } from '../core/database/seeds';
import { createServer } from '../core/server';
import { getSqlite, closeDb } from '../core/database/connection';
import { resetTestDb, activateTestLicense } from './resetTestDb';
import { unwrap } from './testUtils';

const PORT = Number(process.env.KIVO_PORT ?? 3750);
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
  const m = (r.headers.get('set-cookie') ?? '').match(/kivo_session=([^;]+)/);
  return m ? `kivo_session=${m[1]}` : null;
}

async function main() {
  resetTestDb();
  migrateUp();
  runSeeds();
  activateTestLicense();
  const { app } = await createServer();
  const server = app.listen(PORT);
  const db = getSqlite();

  try {
    const admin = await loginAs('admin', 'admin');
    check('login admin', admin !== null);

    const prod = await unwrap<{ id: number }>(
      await api('/api/commercial/products', { method: 'POST', body: JSON.stringify({ name: 'Produto Parcelado', priceCents: 10000 }) }, admin!));
    const cust = await unwrap<{ id: number }>(
      await api('/api/commercial/customers', { method: 'POST', body: JSON.stringify({ name: 'Cliente Parcelado' }) }, admin!));
    const methods = await unwrap<{ id: number; type: string }[]>(
      await api('/api/finance/payment-methods', {}, admin!));
    const prazoMethod = methods.find((m: { type: string }) => m.type === 'prazo')!;

    const firstDue = '2027-01-10';
    const sale = await unwrap<{ id: number }>(
      await api('/api/store/sales', {
        method: 'POST',
        body: JSON.stringify({
          items: [{ productId: prod.id, qty: 1 }],
          customerId: cust.id,
          payments: [{ methodId: prazoMethod.id, amountCents: 10000, customerId: cust.id, dueDate: firstDue, installments: { count: 3, firstDueDate: firstDue } }],
        }),
      }, admin!));
    check('venda parcelada criada', !!sale.id);

    const installments = db.prepare(
      'SELECT amount_cents, due_date, installment_no, installment_count FROM receivables WHERE sale_id = ? ORDER BY installment_no',
    ).all(sale.id) as { amount_cents: number; due_date: string; installment_no: number; installment_count: number }[];
    check('3 parcelas geradas', installments.length === 3, String(installments.length));
    check('resto (34) fica na 1ª parcela: 3334/3333/3333', installments[0].amount_cents === 3334 && installments[1].amount_cents === 3333 && installments[2].amount_cents === 3333, JSON.stringify(installments.map((i) => i.amount_cents)));
    check('parcela 1 vence em 2027-01-10', installments[0].due_date === '2027-01-10', installments[0].due_date);
    check('parcela 2 vence 30 dias depois (2027-02-09)', installments[1].due_date === '2027-02-09', installments[1].due_date);
    check('parcela 3 vence 30 dias depois (2027-03-11)', installments[2].due_date === '2027-03-11', installments[2].due_date);
    check('installment_count = 3 em todas', installments.every((i) => i.installment_count === 3));

    const carne = await api(`/app/store/vendas/${sale.id}/carne`, {}, admin!);
    check('carnê renderiza (200)', carne.status === 200, String(carne.status));
    const carneHtml = await carne.text();
    check('carnê tem as 3 parcelas (Parcela 1/3, 2/3, 3/3)', ['1/3', '2/3', '3/3'].every((s) => carneHtml.includes(s)));

    const cancel = await api(`/api/store/sales/${sale.id}/cancel`, { method: 'POST' }, admin!);
    check('cancelamento ok', cancel.status === 200, String(cancel.status));
    const afterCancel = db.prepare("SELECT COUNT(*) c FROM receivables WHERE sale_id = ? AND status = 'cancelada'").get(sale.id) as { c: number };
    check('todas as 3 parcelas canceladas', afterCancel.c === 3, String(afterCancel.c));

    // Bloqueio: se uma parcela já foi recebida, não cancela mais
    const sale2 = await unwrap<{ id: number }>(
      await api('/api/store/sales', {
        method: 'POST',
        body: JSON.stringify({
          items: [{ productId: prod.id, qty: 1 }],
          customerId: cust.id,
          payments: [{ methodId: prazoMethod.id, amountCents: 10000, customerId: cust.id, dueDate: firstDue }],
        }),
      }, admin!));
    const rec2 = db.prepare('SELECT id FROM receivables WHERE sale_id = ?').get(sale2.id) as { id: number };
    const pixMethod = db.prepare("SELECT id FROM payment_methods WHERE type = 'pix' AND active = 1 LIMIT 1").get() as { id: number };
    await unwrap<unknown>(
      await api(`/api/finance/receivables/${rec2.id}/settle`, {
        method: 'POST', body: JSON.stringify({ payments: [{ paymentMethodId: pixMethod.id, amountCents: 10000 }] }),
      }, admin!));
    const blocked = await api(`/api/store/sales/${sale2.id}/cancel`, { method: 'POST' }, admin!);
    check('cancelamento bloqueado se parcela já recebida', blocked.status === 400, String(blocked.status));
  } finally {
    server.close();
    closeDb();
  }

  console.log(failures === 0 ? '\nFase 7a: TODOS OS TESTES PASSARAM' : `\n${failures} falha(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
