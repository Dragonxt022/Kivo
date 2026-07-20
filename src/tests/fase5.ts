/**
 * Teste da DoD da Fase 5 (App Loja):
 * um dia inteiro de loja — abre caixa, vende (dinheiro/pix/prazo), estoque baixa,
 * gaveta recebe, cancelamento reverte, relatório bate com as vendas.
 * Comunicação entre Apps via serviços do Core (sem import direto).
 */
import { migrateUp } from '../core/database/migrator';
import { runSeeds } from '../core/database/seeds';
import { createServer } from '../core/server';
import { getSqlite, closeDb } from '../core/database/connection';
import { resetTestDb, activateTestLicense } from './resetTestDb';
import { unwrap } from './testUtils';

const PORT = Number(process.env.KIVO_PORT ?? 3599);
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

  const admin = await loginAs('admin', 'admin');
  check('login admin', admin !== null);
  await api('/api/users', { method: 'POST', body: JSON.stringify({ username: 'op5', name: 'op5', password: '123456', roleSlug: 'operador' }) }, admin!);
  const op = await loginAs('op5', '123456');

  // Preparação: cliente + produtos com estoque
  const cli = await unwrap<{ id: number }>(await api('/api/commercial/customers', { method: 'POST', body: JSON.stringify({ name: 'Cliente Fiado' }) }, admin!));
  const mkProd = async (name: string, price: number, stock: number) => {
    const p = await unwrap<{ id: number }>(await api('/api/commercial/products', { method: 'POST', body: JSON.stringify({ name, priceCents: price }) }, admin!));
    await api('/api/commercial/stock/move', { method: 'POST', body: JSON.stringify({ productId: p.id, type: 'entrada', qty: stock, reason: 'estoque inicial' }) }, admin!);
    return p.id;
  };
  const cimento = await mkProd('Cimento 50kg', 4500, 20);
  const tinta = await mkProd('Tinta 18L', 28900, 5);

  // RBAC
  check('operador não vende (403)', (await api('/api/store/sales', { method: 'POST', body: '{}' }, op!)).status === 403);

  // Venda em dinheiro sem caixa aberto → bloqueada
  const noCash = await api('/api/store/sales', {
    method: 'POST',
    body: JSON.stringify({ items: [{ productId: cimento, qty: 2 }], paymentMethod: 'dinheiro' }),
  }, admin!);
  check('dinheiro sem caixa aberto → 400', noCash.status === 400);

  // Abre o dia
  check('abre caixa 100,00', (await api('/api/finance/cash/open', { method: 'POST', body: JSON.stringify({ openingCents: 10000 }) }, admin!)).status === 201);

  // Venda 1: dinheiro com troco (2x cimento = 90,00; recebido 100,00 → troco 10,00)
  const v1r = await api('/api/store/sales', {
    method: 'POST',
    body: JSON.stringify({ items: [{ productId: cimento, qty: 2 }], paymentMethod: 'dinheiro', paidCents: 10000 }),
  }, admin!);
  const v1 = await unwrap<{ id: number; totalCents: number; changeCents: number }>(v1r);
  check('venda dinheiro concluída (90,00)', v1r.status === 201 && v1.totalCents === 9000);
  check('troco = 10,00', v1.changeCents === 1000);
  let stock = (db.prepare('SELECT stock_qty FROM products WHERE id = ?').get(cimento) as { stock_qty: number }).stock_qty;
  check('estoque baixou (20→18)', stock === 18, `estoque=${stock}`);

  // Venda 2: pix (1 tinta = 289,00) — não passa pela gaveta
  const v2r = await api('/api/store/sales', {
    method: 'POST',
    body: JSON.stringify({ items: [{ productId: tinta, qty: 1 }], paymentMethod: 'pix' }),
  }, admin!);
  check('venda pix concluída', v2r.status === 201);

  // Venda 3: a prazo sem cliente → 400; com cliente → gera conta a receber
  const v3bad = await api('/api/store/sales', {
    method: 'POST',
    body: JSON.stringify({ items: [{ productId: cimento, qty: 1 }], paymentMethod: 'prazo' }),
  }, admin!);
  check('prazo sem cliente → 400', v3bad.status === 400);
  const v3r = await api('/api/store/sales', {
    method: 'POST',
    body: JSON.stringify({ items: [{ productId: cimento, qty: 1 }], paymentMethod: 'prazo', customerId: cli.id, dueDate: '2026-08-05' }),
  }, admin!);
  const v3 = await unwrap<{ id: number; receivableId?: number }>(v3r);
  check('venda a prazo gera conta a receber', v3r.status === 201 && !!v3.receivableId);
  const recRow = db.prepare('SELECT status, amount_cents, customer_id FROM receivables WHERE id = ?').get(v3.receivableId) as { status: string; amount_cents: number; customer_id: number };
  check('conta a receber correta (45,00, aberta, cliente)', recRow.status === 'aberta' && recRow.amount_cents === 4500 && recRow.customer_id === cli.id);

  // Estoque insuficiente NÃO bloqueia a venda — decisão de negócio já em produção
  // (venda nunca trava por falta de estoque; reposição pode atrasar): o saldo fica
  // negativo, registrado normalmente. Cancela em seguida para não afetar o relatório do dia.
  const stockBeforeOver = (db.prepare('SELECT stock_qty FROM products WHERE id = ?').get(tinta) as { stock_qty: number }).stock_qty;
  const vOver = await api('/api/store/sales', {
    method: 'POST',
    body: JSON.stringify({ items: [{ productId: tinta, qty: 99 }], paymentMethod: 'pix' }),
  }, admin!);
  check('estoque insuficiente não bloqueia a venda (201)', vOver.status === 201, String(vOver.status));
  const vOverBody = await unwrap<{ id: number }>(vOver);
  const stockAfterOver = (db.prepare('SELECT stock_qty FROM products WHERE id = ?').get(tinta) as { stock_qty: number }).stock_qty;
  check('saldo fica negativo (sem travar a venda)', stockAfterOver === stockBeforeOver - 99, `estoque=${stockAfterOver}`);
  check('cancela a venda de teste (sem deixar lixo no relatório)', (await api(`/api/store/sales/${vOverBody.id}/cancel`, { method: 'POST' }, admin!)).status === 200);
  const orphan = db.prepare("SELECT COUNT(*) c FROM sales WHERE status = 'concluida'").get() as { c: number };
  check('sem venda órfã após cancelar (3 concluídas)', orphan.c === 3, `vendas=${orphan.c}`);

  // Desconto exige permissão fina
  db.prepare(`INSERT INTO role_permissions (role_id, permission_key)
              SELECT id, 'store.sales.create' FROM roles WHERE slug = 'operador'`).run();
  const opFresh = await loginAs('op5', '123456');
  const vDisc = await api('/api/store/sales', {
    method: 'POST',
    body: JSON.stringify({ items: [{ productId: cimento, qty: 1 }], paymentMethod: 'pix', discountCents: 500 }),
  }, opFresh!);
  check('desconto sem permissão → 400/403', vDisc.status === 400 || vDisc.status === 403);

  // Cancelamento: devolve estoque e tira da gaveta
  const beforeCancel = (db.prepare('SELECT stock_qty FROM products WHERE id = ?').get(cimento) as { stock_qty: number }).stock_qty;
  const cancel = await api(`/api/store/sales/${v1.id}/cancel`, { method: 'POST' }, admin!);
  check('cancelamento da venda dinheiro', cancel.status === 200);
  stock = (db.prepare('SELECT stock_qty FROM products WHERE id = ?').get(cimento) as { stock_qty: number }).stock_qty;
  check('estoque devolvido (+2)', stock === beforeCancel + 2, `estoque=${stock}`);
  check('cancelar de novo → 400', (await api(`/api/store/sales/${v1.id}/cancel`, { method: 'POST' }, admin!)).status === 400);

  // Caixa: 100 (abertura) + 90 (venda) - 90 (cancelamento) = 100,00
  const cur = await unwrap<{ expectedCents: number }>(await api('/api/finance/cash/current', {}, admin!));
  check('gaveta = 100,00 após cancelamento', cur.expectedCents === 10000, `gaveta=${cur.expectedCents}`);

  // Relatório do dia bate com as vendas concluídas (pix 289,00 + prazo 45,00 = 334,00)
  const report = await unwrap<{
    totals: { vendas: number; total_cents: number };
    byPayment: { payment_method: string; total_cents: number }[];
  }>(await api('/api/store/reports/daily', {}, admin!));
  const dbTotal = (db.prepare("SELECT COALESCE(SUM(total_cents),0) t FROM sales WHERE status = 'concluida' AND date(created_at) = date('now')").get() as { t: number }).t;
  check('relatório bate com o banco', report.totals.total_cents === dbTotal, `${report.totals.total_cents} vs ${dbTotal}`);
  check('relatório: 2 vendas concluídas, 334,00', report.totals.vendas === 2 && report.totals.total_cents === 33400);
  check('relatório por pagamento inclui PIX e A prazo (fiado)', ['PIX', 'A prazo (fiado)'].every((m) => report.byPayment.some((p) => p.payment_method === m)));

  // Fecha o dia: contado = esperado → diferença zero
  const close = await unwrap<{ difference: number }>(await api('/api/finance/cash/close', { method: 'POST', body: JSON.stringify({ countedCents: cur.expectedCents }) }, admin!));
  check('fechamento do dia sem diferença', close.difference === 0);

  // Auditoria cobre vendas
  const entities = new Set((db.prepare('SELECT DISTINCT entity FROM audit_logs').all() as { entity: string }[]).map((a) => a.entity));
  check('auditoria cobre sale', entities.has('sale'));

  server.close();
  closeDb();
  console.log(failures === 0 ? '\nDoD Fase 5: TODOS OS TESTES PASSARAM' : `\n${failures} falha(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
