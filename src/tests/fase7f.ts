/**
 * Teste de idempotência de venda: duas chamadas POST /api/store/sales com o mesmo
 * clientRequestId devolvem a MESMA venda, sem duplicar estoque/caixa.
 */
import { migrateUp } from '../core/database/migrator';
import { runSeeds } from '../core/database/seeds';
import { createServer } from '../core/server';
import { getSqlite, closeDb } from '../core/database/connection';
import { unwrap } from './testUtils';

const PORT = Number(process.env.KATSU_PORT ?? 3759);
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

    const prod = await unwrap<{ id: number }>(
      await api('/api/commercial/products', { method: 'POST', body: JSON.stringify({ name: 'Produto Idempotente', priceCents: 1500, initialStock: 10 }) }, admin!));

    const clientRequestId = 'test-request-id-fixo-123';
    const body = JSON.stringify({ items: [{ productId: prod.id, qty: 2 }], paymentMethod: 'pix', clientRequestId });

    const first = await api('/api/store/sales', { method: 'POST', body }, admin!);
    check('primeira tentativa cria a venda (201)', first.status === 201, String(first.status));
    const firstBody = await unwrap<{ id: number; totalCents: number }>(first);

    const second = await api('/api/store/sales', { method: 'POST', body }, admin!);
    check('segunda tentativa com o mesmo clientRequestId responde 201 (idempotente)', second.status === 201, String(second.status));
    const secondBody = await unwrap<{ id: number; totalCents: number }>(second);
    check('mesma venda devolvida (mesmo id)', secondBody.id === firstBody.id, `${firstBody.id} vs ${secondBody.id}`);
    check('mesmo totalCents devolvido', secondBody.totalCents === firstBody.totalCents);

    const third = await api('/api/store/sales', { method: 'POST', body }, admin!);
    check('terceira tentativa também devolve a mesma venda', (await unwrap<{ id: number }>(third)).id === firstBody.id);

    const salesCount = db.prepare("SELECT COUNT(*) c FROM sales WHERE client_request_id = ?").get(clientRequestId) as { c: number };
    check('apenas 1 linha em sales para este clientRequestId', salesCount.c === 1, String(salesCount.c));

    const stock = (await unwrap<{ stock_qty: number }[]>(await api('/api/commercial/products?q=Produto Idempotente', {}, admin!)))[0];
    check('estoque baixou só uma vez (10-2=8, não 10-6=4)', stock.stock_qty === 8, String(stock.stock_qty));

    // Sem clientRequestId, vendas continuam podendo repetir livremente (comportamento de sempre)
    const bodyNoId = JSON.stringify({ items: [{ productId: prod.id, qty: 1 }], paymentMethod: 'pix' });
    const noIdA = await api('/api/store/sales', { method: 'POST', body: bodyNoId }, admin!);
    const noIdB = await api('/api/store/sales', { method: 'POST', body: bodyNoId }, admin!);
    check('sem clientRequestId, duas vendas distintas são criadas normalmente', (await unwrap<{ id: number }>(noIdA)).id !== (await unwrap<{ id: number }>(noIdB)).id);
  } finally {
    server.close();
    closeDb();
  }

  console.log(failures === 0 ? '\nFase 7f: TODOS OS TESTES PASSARAM' : `\n${failures} falha(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
