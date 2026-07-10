/**
 * Teste da Fase 5d (polimento):
 * formas de pagamento com taxa; venda com múltiplos pagamentos/split;
 * acréscimo; estoque inicial no cadastro; relatório com taxas.
 */
import { migrateUp } from '../core/database/migrator';
import { runSeeds } from '../core/database/seeds';
import { createServer } from '../core/server';
import { getSqlite, closeDb } from '../core/database/connection';

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
  migrateUp();
  runSeeds();
  const { app } = await createServer();
  const server = app.listen(PORT);
  const db = getSqlite();

  const admin = await loginAs('admin', 'admin');
  check('login admin', admin !== null);

  // ---------- Formas de pagamento ----------
  const seeded = (await (await api('/api/finance/payment-methods?all=1', {}, admin!)).json()) as { name: string; type: string; id: number; active: number }[];
  // 5 formas clássicas (ativas) + 3 novas (crédito de loja/fidelidade/convênio, nascem desativadas — opt-in)
  check('formas padrão seedadas (8, sendo 3 novas desativadas)', seeded.length === 8, String(seeded.length));
  check('as 3 novas nascem desativadas', seeded.filter((m) => ['credito_loja', 'fidelidade', 'convenio'].includes(m.type)).every((m) => m.active === 0));
  const stone = await api('/api/finance/payment-methods', {
    method: 'POST', body: JSON.stringify({ name: 'Débito — Stone', type: 'debito', feeBps: 160 }),
  }, admin!);
  check('cria "Débito — Stone" 1,6%', stone.status === 201);
  const stoneId = ((await stone.json()) as { id: number }).id;
  check('taxa inválida rejeitada', (await api('/api/finance/payment-methods', {
    method: 'POST', body: JSON.stringify({ name: 'X', type: 'debito', feeBps: 99999 }),
  }, admin!)).status === 400);
  const dinheiroId = seeded.find((m) => m.type === 'dinheiro')!.id;
  const pixId = seeded.find((m) => m.type === 'pix')!.id;

  // ---------- Estoque inicial no cadastro ----------
  const prod = await api('/api/commercial/products', {
    method: 'POST', body: JSON.stringify({ name: 'Argamassa 20kg', priceCents: 3000, initialStock: 40 }),
  }, admin!);
  const prodData = (await prod.json()) as { id: number; stock_qty: number };
  check('produto criado com estoque inicial 40', prod.status === 201 && prodData.stock_qty === 40, `estoque=${prodData.stock_qty}`);
  const movs = db.prepare("SELECT reason FROM stock_movements WHERE product_id = ? AND type = 'entrada'").all(prodData.id) as { reason: string }[];
  check('estoque inicial virou movimentação auditável', movs.some((m) => m.reason === 'estoque inicial'));

  // ---------- Venda com múltiplos pagamentos + acréscimo ----------
  check('abre caixa 50,00', (await api('/api/finance/cash/open', { method: 'POST', body: JSON.stringify({ openingCents: 5000 }) }, admin!)).status === 201);

  // 4x argamassa = 120,00 - 10 desc + 5 acresc = 115,00 → 60 dinheiro (recebe 100, troco 40) + 55 Stone
  const sale = await api('/api/store/sales', {
    method: 'POST',
    body: JSON.stringify({
      items: [{ productId: prodData.id, qty: 4 }],
      discountCents: 1000,
      surchargeCents: 500,
      payments: [
        { methodId: dinheiroId, amountCents: 6000, receivedCents: 10000 },
        { methodId: stoneId, amountCents: 5500 },
      ],
    }),
  }, admin!);
  const saleData = (await sale.json()) as { id: number; totalCents: number; changeCents: number; feeCents: number };
  check('venda dividida concluída (115,00)', sale.status === 201 && saleData.totalCents === 11500, JSON.stringify(saleData));
  check('troco = 40,00', saleData.changeCents === 4000);
  check('taxa Stone = 0,88 (1,6% de 55,00)', saleData.feeCents === 88, `fee=${saleData.feeCents}`);
  const pays = db.prepare('SELECT method_name, amount_cents, fee_cents FROM sale_payments WHERE sale_id = ?').all(saleData.id) as { amount_cents: number; fee_cents: number }[];
  check('2 pagamentos gravados com taxa congelada', pays.length === 2 && pays.reduce((a, p) => a + p.amount_cents, 0) === 11500);

  // gaveta: 50 abertura + 60 dinheiro = 110,00 (Stone não passa pela gaveta)
  const cur = (await (await api('/api/finance/cash/current', {}, admin!)).json()) as { expectedCents: number };
  check('gaveta = 110,00 (só a parte em dinheiro)', cur.expectedCents === 11000, `gaveta=${cur.expectedCents}`);

  // pagamentos não fecham o total → 400
  check('pagamentos que não fecham o total → 400', (await api('/api/store/sales', {
    method: 'POST',
    body: JSON.stringify({ items: [{ productId: prodData.id, qty: 1 }], payments: [{ methodId: pixId, amountCents: 100 }] }),
  }, admin!)).status === 400);

  // split em 3 no pix: 90,00 → 30+30+30
  const split = await api('/api/store/sales', {
    method: 'POST',
    body: JSON.stringify({
      items: [{ productId: prodData.id, qty: 3 }],
      payments: [
        { methodId: pixId, amountCents: 3000 }, { methodId: pixId, amountCents: 3000 }, { methodId: pixId, amountCents: 3000 },
      ],
    }),
  }, admin!);
  check('conta dividida por 3 (90,00)', split.status === 201 && ((await split.json()) as { totalCents: number }).totalCents === 9000);

  // legado continua funcionando (paymentMethod)
  const legacy = await api('/api/store/sales', {
    method: 'POST', body: JSON.stringify({ items: [{ productId: prodData.id, qty: 1 }], paymentMethod: 'pix' }),
  }, admin!);
  check('formato legado (paymentMethod) segue funcionando', legacy.status === 201);

  // cancelamento devolve só a parte em dinheiro
  const beforeCancel = (await (await api('/api/finance/cash/current', {}, admin!)).json()) as { expectedCents: number };
  check('cancela venda dividida', (await api(`/api/store/sales/${saleData.id}/cancel`, { method: 'POST' }, admin!)).status === 200);
  const afterCancel = (await (await api('/api/finance/cash/current', {}, admin!)).json()) as { expectedCents: number };
  check('cancelamento tirou 60,00 da gaveta', beforeCancel.expectedCents - afterCancel.expectedCents === 6000,
    `${beforeCancel.expectedCents} → ${afterCancel.expectedCents}`);

  // relatório: por forma de pagamento com taxa
  const report = (await (await api('/api/store/reports/daily', {}, admin!)).json()) as {
    totals: { total_cents: number; fee_cents: number; surcharge_cents: number };
    byPayment: { payment_method: string; fee_cents: number }[];
  };
  const dbTotal = (db.prepare("SELECT COALESCE(SUM(total_cents),0) t FROM sales WHERE status = 'concluida' AND date(created_at) = date('now')").get() as { t: number }).t;
  check('relatório bate com o banco', report.totals.total_cents === dbTotal);
  check('relatório traz taxas por forma', Array.isArray(report.byPayment) && 'fee_cents' in (report.byPayment[0] ?? {}));

  // permissão fina: operador não cadastra forma de pagamento
  await api('/api/users', { method: 'POST', body: JSON.stringify({ username: 'op6', name: 'op6', password: '123456', roleSlug: 'operador' }) }, admin!);
  const op = await loginAs('op6', '123456');
  check('operador não cadastra forma de pagamento (403)', (await api('/api/finance/payment-methods', {
    method: 'POST', body: JSON.stringify({ name: 'Y', type: 'pix' }),
  }, op!)).status === 403);

  server.close();
  closeDb();
  console.log(failures === 0 ? '\nFase 5d: TODOS OS TESTES PASSARAM' : `\n${failures} falha(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
