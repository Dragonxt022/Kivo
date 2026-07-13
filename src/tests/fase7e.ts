/**
 * Teste da Parte E (convênio): venda por convênio vira cobrança pendente (sem mexer
 * em caixa/recebível na hora), geração de fatura consolida corretamente e bloqueia
 * duplicata no mesmo período, cancelamento de cobrança não-faturada funciona,
 * de cobrança já faturada é bloqueado.
 */
import { migrateUp } from '../core/database/migrator';
import { runSeeds } from '../core/database/seeds';
import { createServer } from '../core/server';
import { getSqlite, closeDb } from '../core/database/connection';
import { unwrap } from './testUtils';

const PORT = Number(process.env.KATSU_PORT ?? 3758);
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
  migrateUp();
  runSeeds();
  const { app } = await createServer();
  const server = app.listen(PORT);
  const db = getSqlite();

  try {
    const admin = await loginAs('admin', 'admin');
    check('login admin', admin !== null);

    const company = await unwrap<{ id: number }>(
      await api('/api/commercial/agreement-companies', { method: 'POST', body: JSON.stringify({ name: 'Empresa Conveniada', billing_day: 5 }) }, admin!));

    const cust = await unwrap<{ id: number }>(
      await api('/api/commercial/customers', { method: 'POST', body: JSON.stringify({ name: 'Funcionário Conveniado', agreement_company_id: company.id }) }, admin!));
    check('cliente vinculado ao convênio', cust.id > 0);

    const custSemConvenio = await unwrap<{ id: number }>(
      await api('/api/commercial/customers', { method: 'POST', body: JSON.stringify({ name: 'Cliente Sem Convênio' }) }, admin!));

    const methods = await unwrap<{ id: number; type: string }[]>(await api('/api/finance/payment-methods?all=1', {}, admin!));
    const convenioMethod = methods.find((m) => m.type === 'convenio')!;
    await api(`/api/finance/payment-methods/${convenioMethod.id}`, { method: 'PUT', body: JSON.stringify({ active: true }) }, admin!);

    const prod = await unwrap<{ id: number }>(
      await api('/api/commercial/products', { method: 'POST', body: JSON.stringify({ name: 'Produto Convênio', priceCents: 8000, initialStock: 10 }) }, admin!));

    const semVinculo = await api('/api/store/sales', {
      method: 'POST', body: JSON.stringify({ items: [{ productId: prod.id, qty: 1 }], customerId: custSemConvenio.id, payments: [{ methodId: convenioMethod.id, amountCents: 8000, customerId: custSemConvenio.id }] }),
    }, admin!);
    check('venda por convênio sem cliente vinculado é rejeitada (400)', semVinculo.status === 400, String(semVinculo.status));

    const sale = await api('/api/store/sales', {
      method: 'POST', body: JSON.stringify({ items: [{ productId: prod.id, qty: 1 }], customerId: cust.id, payments: [{ methodId: convenioMethod.id, amountCents: 8000, customerId: cust.id }] }),
    }, admin!);
    check('venda por convênio concluída', sale.status === 201, String(sale.status));
    const saleBody = await unwrap<{ id: number }>(sale);

    const charge = db.prepare('SELECT id, amount_cents, invoiced_at FROM agreement_charges WHERE sale_id = ?').get(saleBody.id) as
      { id: number; amount_cents: number; invoiced_at: string | null } | undefined;
    check('cobrança pendente criada (sem invoiced_at)', !!charge && charge.invoiced_at === null, JSON.stringify(charge));
    check('sem movimento de caixa e sem recebível criados pela venda', !db.prepare('SELECT id FROM cash_movements WHERE ref_entity = ? AND ref_id = ?').get('sale', String(saleBody.id))
      && !db.prepare('SELECT id FROM receivables WHERE sale_id = ?').get(saleBody.id));

    const pending = await unwrap<{ pendingCents: number }>(await api(`/api/finance/agreements/${company.id}/pending`, {}, admin!));
    check('pendente = 8000', pending.pendingCents === 8000, String(pending.pendingCents));

    const invoice = await api(`/api/finance/agreements/${company.id}/invoice`, { method: 'POST' }, admin!);
    check('fatura gerada (201)', invoice.status === 201, String(invoice.status));
    const invoiceBody = await unwrap<{ receivableId: number; amountCents: number }>(invoice);
    check('valor da fatura = 8000', invoiceBody.amountCents === 8000, String(invoiceBody.amountCents));

    const pendingAfter = await unwrap<{ pendingCents: number }>(await api(`/api/finance/agreements/${company.id}/pending`, {}, admin!));
    check('pendente zera após faturar', pendingAfter.pendingCents === 0, String(pendingAfter.pendingCents));

    const duplicate = await api(`/api/finance/agreements/${company.id}/invoice`, { method: 'POST' }, admin!);
    check('segunda fatura no mesmo período é bloqueada (400)', duplicate.status === 400, String(duplicate.status));

    // Cobrança já faturada bloqueia cancelamento da venda
    const blockedCancel = await api(`/api/store/sales/${saleBody.id}/cancel`, { method: 'POST' }, admin!);
    check('cancelamento bloqueado: cobrança já faturada', blockedCancel.status === 400, String(blockedCancel.status));

    // Cobrança NÃO faturada pode ser cancelada normalmente
    const sale2 = await api('/api/store/sales', {
      method: 'POST', body: JSON.stringify({ items: [{ productId: prod.id, qty: 1 }], customerId: cust.id, payments: [{ methodId: convenioMethod.id, amountCents: 8000, customerId: cust.id }] }),
    }, admin!);
    const sale2Body = await unwrap<{ id: number }>(sale2);
    const cancel2 = await api(`/api/store/sales/${sale2Body.id}/cancel`, { method: 'POST' }, admin!);
    check('cancelamento de venda com cobrança não-faturada funciona', cancel2.status === 200, String(cancel2.status));
    const charge2 = db.prepare('SELECT deleted_at FROM agreement_charges WHERE sale_id = ?').get(sale2Body.id) as { deleted_at: string | null };
    check('cobrança pendente foi removida (soft delete)', charge2.deleted_at !== null);
    const pendingAfterCancel = await unwrap<{ pendingCents: number }>(await api(`/api/finance/agreements/${company.id}/pending`, {}, admin!));
    check('pendente volta a 0 após cancelar (cobrança cancelada não conta)', pendingAfterCancel.pendingCents === 0, String(pendingAfterCancel.pendingCents));
  } finally {
    server.close();
    closeDb();
  }

  console.log(failures === 0 ? '\nFase 7e: TODOS OS TESTES PASSARAM' : `\n${failures} falha(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
