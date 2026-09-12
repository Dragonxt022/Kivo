/**
 * Teste das melhorias do PDV (backend): busca limitada, favoritos, bipe por código de
 * barras, desconto com motivo, preço por item, filtros/exportação do histórico de vendas,
 * devolução parcial (estoque + crédito) e indicador de pendências de sync.
 */
import { migrateUp } from '../core/database/migrator';
import { runSeeds } from '../core/database/seeds';
import { createServer } from '../core/server';
import { closeDb } from '../core/database/connection';
import { activateTestLicense } from './resetTestDb';
import { unwrap } from './testUtils';

const PORT = Number(process.env.KIVO_PORT ?? 3789);
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
  activateTestLicense();
  const { app } = await createServer();
  const server = app.listen(PORT);

  try {
    const admin = await loginAs('admin', 'admin');
    check('login admin', admin !== null);
    await api('/api/finance/cash/open', { method: 'POST', body: JSON.stringify({ openingCents: 0 }) }, admin!);

    const prod = await unwrap<{ id: number }>(
      await api('/api/commercial/products', {
        method: 'POST',
        body: JSON.stringify({ name: 'Produto PDV Melhorias', priceCents: 1000, trackStock: true, initialStock: 10, barcode: '7891234567895' }),
      }, admin!));
    await api(`/api/commercial/products/${prod.id}/favorite`, { method: 'PUT', body: JSON.stringify({ favorite: true }) }, admin!);
    check('produto criado com favorito/estoque', !!prod.id);

    const cust = await unwrap<{ id: number }>(
      await api('/api/commercial/customers', { method: 'POST', body: JSON.stringify({ name: 'Cliente PDV Melhorias' }) }, admin!));

    const favs = await unwrap<{ id: number }[]>(await api('/api/commercial/products?scope=favorites&limit=24', {}, admin!));
    check('favoritos incluem o produto', favs.some((p) => p.id === prod.id), String(favs.length));

    const limited = await unwrap<unknown[]>(await api('/api/commercial/products?limit=1&q=Produto PDV', {}, admin!));
    check('busca limitada respeita o limite', limited.length === 1, String(limited.length));

    const byBarcode = await api('/api/commercial/products/by-barcode/7891234567895', {}, admin!);
    check('bipe por código de barras responde 200', byBarcode.status === 200, String(byBarcode.status));

    const methods = await unwrap<{ id: number; type: string }[]>(await api('/api/store/payment-methods', {}, admin!));
    const pix = methods.find((m) => m.type === 'pix')!;

    // Venda com preço por item (1500 em vez de 1000) + desconto com motivo.
    const saleRes = await api('/api/store/sales', {
      method: 'POST',
      body: JSON.stringify({
        items: [{ productId: prod.id, qty: 2, unitPriceCents: 1500 }],
        discountCents: 500,
        discountReason: 'cliente antigo',
        customerId: cust.id,
        payments: [{ methodId: pix.id, amountCents: 2500 }],
      }),
    }, admin!);
    const sale = await unwrap<{ id: number; totalCents: number }>(saleRes);
    check('venda com preço por item + desconto fecha', sale.totalCents === 2500, String(sale.totalCents));

    const detail = await unwrap<{ discount_reason: string; returnable: { product_id: number; remaining_qty: number }[] }>(
      await api(`/api/store/sales/${sale.id}`, {}, admin!));
    check('motivo do desconto persistiu', detail.discount_reason === 'cliente antigo', detail.discount_reason);
    const line = detail.returnable.find((l) => l.product_id === prod.id);
    check('item aparece como devolvível', !!line && line.remaining_qty === 2, JSON.stringify(line));

    // Estoque após a venda = 8.
    const stockAfterSale = await unwrap<{ stock_qty: number }[]>(
      await api('/api/commercial/products?q=Produto PDV Melhorias', {}, admin!));
    check('estoque caiu para 8', stockAfterSale[0].stock_qty === 8, String(stockAfterSale[0].stock_qty));

    // Devolução parcial de 1 unidade, sem reembolso.
    const ret = await api(`/api/store/sales/${sale.id}/return`, {
      method: 'POST', body: JSON.stringify({ items: [{ productId: prod.id, qty: 1 }], refundMethod: 'nenhum' }),
    }, admin!);
    check('devolução parcial → 201', ret.status === 201, String(ret.status));

    const stockAfterReturn = await unwrap<{ stock_qty: number }[]>(
      await api('/api/commercial/products?q=Produto PDV Melhorias', {}, admin!));
    check('estoque recomposto para 9', stockAfterReturn[0].stock_qty === 9, String(stockAfterReturn[0].stock_qty));

    const overReturn = await api(`/api/store/sales/${sale.id}/return`, {
      method: 'POST', body: JSON.stringify({ items: [{ productId: prod.id, qty: 5 }], refundMethod: 'nenhum' }),
    }, admin!);
    check('devolução acima do saldo → 400', overReturn.status === 400, String(overReturn.status));

    // Histórico: filtro/paginação/exportação.
    const list = await api('/api/store/sales?status=concluida&limit=5', {}, admin!);
    const listRows = await unwrap<unknown[]>(list);
    check('lista de vendas filtra e pagina', listRows.length <= 5 && Number(list.headers.get('x-total-count')) >= 1);
    const sellers = await api('/api/store/sales/sellers', {}, admin!);
    check('endpoint de vendedores responde 200', sellers.status === 200, String(sellers.status));
    const csv = await api('/api/store/sales/export.csv', {}, admin!);
    const csvText = await csv.text();
    check('exportação CSV de vendas', csv.status === 200 && csvText.includes('Devolvido'), String(csv.status));

    const status = await unwrap<{ pending: number }>(await api('/api/sync/status', {}, admin!));
    check('status de sync informa pendências', typeof status.pending === 'number', String(status.pending));
  } finally {
    server.close();
    closeDb();
  }

  console.log(failures === 0 ? '\nPDV melhorias: TODOS OS TESTES PASSARAM' : `\n${failures} falha(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
