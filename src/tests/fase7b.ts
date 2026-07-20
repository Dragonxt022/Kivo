/**
 * Teste da Parte B (ficha do cliente): store_credit_cents/loyalty_points são
 * somente leitura via API, filtros ?customerId=/?partyId= funcionam, e cep persiste.
 * (Autofill via ViaCEP é client-side/externo — fora do escopo deste harness.)
 */
import { migrateUp } from '../core/database/migrator';
import { runSeeds } from '../core/database/seeds';
import { createServer } from '../core/server';
import { closeDb } from '../core/database/connection';
import { unwrap } from './testUtils';

const PORT = Number(process.env.KIVO_PORT ?? 3751);
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
  migrateUp();
  runSeeds();
  const { app } = await createServer();
  const server = app.listen(PORT);

  try {
    const admin = await loginAs('admin', 'admin');
    check('login admin', admin !== null);

    const cust = await unwrap<{ id: number; cep: string }>(
      await api('/api/commercial/customers', { method: 'POST', body: JSON.stringify({ name: 'Cliente Ficha', cep: '01001-000' }) }, admin!));
    check('cep persiste na criação', cust.cep === '01001-000', cust.cep);

    // Tenta gravar store_credit_cents/loyalty_points direto via PUT — deve ser ignorado (somente leitura)
    await api(`/api/commercial/customers/${cust.id}`, {
      method: 'PUT', body: JSON.stringify({ store_credit_cents: 999999, loyalty_points: 999999 }),
    }, admin!);
    const after = await unwrap<{ store_credit_cents: number; loyalty_points: number }>(
      await api(`/api/commercial/customers/${cust.id}`, {}, admin!));
    check('store_credit_cents não é gravável via PUT (fica 0)', after.store_credit_cents === 0, String(after.store_credit_cents));
    check('loyalty_points não é gravável via PUT (fica 0)', after.loyalty_points === 0, String(after.loyalty_points));

    // GET /:id genérico funciona
    const single = await api(`/api/commercial/customers/${cust.id}`, {}, admin!);
    check('GET /customers/:id retorna 200', single.status === 200);
    const missing = await api('/api/commercial/customers/999999', {}, admin!);
    check('GET /customers/:id inexistente → 404', missing.status === 404);

    // Filtro ?customerId= em /api/store/sales
    const prod = await unwrap<{ id: number }>(
      await api('/api/commercial/products', { method: 'POST', body: JSON.stringify({ name: 'Produto Ficha', priceCents: 1000 }) }, admin!));
    const otherCust = await unwrap<{ id: number }>(
      await api('/api/commercial/customers', { method: 'POST', body: JSON.stringify({ name: 'Outro Cliente' }) }, admin!));
    await api('/api/store/sales', { method: 'POST', body: JSON.stringify({ items: [{ productId: prod.id, qty: 1 }], paymentMethod: 'pix', customerId: cust.id }) }, admin!);
    await api('/api/store/sales', { method: 'POST', body: JSON.stringify({ items: [{ productId: prod.id, qty: 1 }], paymentMethod: 'pix', customerId: otherCust.id }) }, admin!);
    const salesFiltered = await unwrap<{ id: number }[]>(await api(`/api/store/sales?customerId=${cust.id}`, {}, admin!));
    check('filtro ?customerId= só traz vendas do cliente certo', salesFiltered.length === 1, String(salesFiltered.length));

    // Filtro ?partyId= em /api/finance/receivables
    const prazoMethod = (await unwrap<{ id: number; type: string }[]>(await api('/api/finance/payment-methods', {}, admin!))).find((m) => m.type === 'prazo')!;
    await api('/api/store/sales', {
      method: 'POST', body: JSON.stringify({ items: [{ productId: prod.id, qty: 1 }], customerId: cust.id, payments: [{ methodId: prazoMethod.id, amountCents: 1000, customerId: cust.id, dueDate: '2027-01-01' }] }),
    }, admin!);
    await api('/api/store/sales', {
      method: 'POST', body: JSON.stringify({ items: [{ productId: prod.id, qty: 1 }], customerId: otherCust.id, payments: [{ methodId: prazoMethod.id, amountCents: 1000, customerId: otherCust.id, dueDate: '2027-01-01' }] }),
    }, admin!);
    const receivablesFiltered = await unwrap<{ id: number }[]>(await api(`/api/finance/receivables?partyId=${cust.id}`, {}, admin!));
    check('filtro ?partyId= só traz recebíveis do cliente certo', receivablesFiltered.length === 1, String(receivablesFiltered.length));
  } finally {
    server.close();
    closeDb();
  }

  console.log(failures === 0 ? '\nFase 7b: TODOS OS TESTES PASSARAM' : `\n${failures} falha(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
