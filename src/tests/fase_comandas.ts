/**
 * Teste da DoD da Fase 4 (Comandas & Mesas):
 * abre mesa+comanda, adiciona itens (inclusive kit e produzido, reaproveitando o
 * desenho das Fases 2c/2d) com preço congelado no pedido, testa transferir/dividir/
 * unir, fecha a comanda gerando uma venda real (com expansão de kit/ficha técnica
 * idêntica a uma venda direta do PDV) e confirma que a mesa libera; testa cancelar
 * sem gerar venda; tudo atrás da capability 'comandas.mesas'.
 */
import { migrateUp } from '../core/database/migrator';
import { runSeeds } from '../core/database/seeds';
import { createServer } from '../core/server';
import { getSqlite, closeDb } from '../core/database/connection';
import { resetTestDb, activateTestLicense } from './resetTestDb';

const PORT = Number(process.env.KATSU_PORT ?? 3791);
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

async function enableCapability(key: string, cookie: string) {
  return api(`/api/core/capabilities/${key}`, { method: 'PUT', body: JSON.stringify({ enabled: true }) }, cookie);
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

  // Gating: capability comeca desligada
  check('sem capability: tables -> 403', (await api('/api/comandas/tables', {}, admin!)).status === 403);
  check('liga comandas.mesas', (await enableCapability('comandas.mesas', admin!)).status === 200);
  check('liga commercial.kits', (await enableCapability('commercial.kits', admin!)).status === 200);
  check('liga commercial.producao', (await enableCapability('commercial.producao', admin!)).status === 200);

  // ─── Mesas ───
  const tableA = (await (await api('/api/comandas/tables', { method: 'POST', body: JSON.stringify({ label: 'Mesa 1' }) }, admin!)).json()) as { id: number };
  const tableB = (await (await api('/api/comandas/tables', { method: 'POST', body: JSON.stringify({ label: 'Mesa 2' }) }, admin!)).json()) as { id: number };
  const tableC = (await (await api('/api/comandas/tables', { method: 'POST', body: JSON.stringify({ label: 'Mesa 3' }) }, admin!)).json()) as { id: number };
  check('3 mesas criadas', !!tableA.id && !!tableB.id && !!tableC.id);
  const statusInit = (await (await api('/api/comandas/tables/status', {}, admin!)).json()) as { id: number; status: string }[];
  check('mesas comecam livres', statusInit.every((t) => t.status === 'livre'));

  // ─── Produtos: normal, kit (Fase 2c) e produzido (Fase 2d) ───
  const suco = (await (await api('/api/commercial/products', { method: 'POST', body: JSON.stringify({ name: 'Suco de Laranja', priceCents: 800 }) }, admin!)).json()) as { id: number };
  const hamburguer = (await (await api('/api/commercial/products', { method: 'POST', body: JSON.stringify({ name: 'Hamburguer', priceCents: 1200, costCents: 400 }) }, admin!)).json()) as { id: number };
  await api('/api/commercial/stock/move', { method: 'POST', body: JSON.stringify({ productId: hamburguer.id, type: 'entrada', qty: 50, reason: 'estoque inicial' }) }, admin!);
  const kit = (await (await api('/api/commercial/products', { method: 'POST', body: JSON.stringify({ name: 'Combo Lanche', priceCents: 2500, costCents: 1000, productType: 'kit' }) }, admin!)).json()) as { id: number };
  const kitItemR = await api(`/api/commercial/products/${kit.id}/kit-items`, { method: 'POST', body: JSON.stringify({ componentProductId: hamburguer.id, qty: 1 }) }, admin!);
  check('kit-item criado (Hamburguer no Combo Lanche)', kitItemR.status === 201);

  const laranja = (await (await api('/api/commercial/products', { method: 'POST', body: JSON.stringify({ name: 'Laranja kg', priceCents: 200, costCents: 50 }) }, admin!)).json()) as { id: number };
  await api('/api/commercial/stock/move', { method: 'POST', body: JSON.stringify({ productId: laranja.id, type: 'entrada', qty: 50, reason: 'estoque inicial' }) }, admin!);
  const produzido = (await (await api('/api/commercial/products', { method: 'POST', body: JSON.stringify({ name: 'Suco Natural 300ml', priceCents: 900, productType: 'produzido' }) }, admin!)).json()) as { id: number };
  const recipeR = await api(`/api/commercial/products/${produzido.id}/recipe-items`, { method: 'POST', body: JSON.stringify({ inputProductId: laranja.id, qty: 0.3 }) }, admin!);
  check('recipe-item criado (Laranja na ficha do Suco Natural)', recipeR.status === 201);

  // ─── Abrir comanda na Mesa 1 ───
  const openR = await api('/api/comandas/comandas', { method: 'POST', body: JSON.stringify({ tableId: tableA.id }) }, admin!);
  const comanda = (await openR.json()) as { id: number };
  check('comanda aberta', openR.status === 201 && !!comanda.id);
  const statusAfterOpen = (await (await api('/api/comandas/tables/status', {}, admin!)).json()) as { id: number; status: string }[];
  check('Mesa 1 fica ocupada', statusAfterOpen.find((t) => t.id === tableA.id)?.status === 'ocupada');

  // ─── Adicionar itens (normal + kit + produzido) ───
  const addSuco = await api(`/api/comandas/comandas/${comanda.id}/items`, { method: 'POST', body: JSON.stringify({ productId: suco.id, qty: 2 }) }, admin!);
  check('item suco adicionado', addSuco.status === 201);
  const addKit = await api(`/api/comandas/comandas/${comanda.id}/items`, { method: 'POST', body: JSON.stringify({ productId: kit.id, qty: 1 }) }, admin!);
  check('item kit adicionado', addKit.status === 201);
  const addProduzido = await api(`/api/comandas/comandas/${comanda.id}/items`, { method: 'POST', body: JSON.stringify({ productId: produzido.id, qty: 3 }) }, admin!);
  check('item produzido adicionado', addProduzido.status === 201);

  type ComandaItem = { id: number; product_id: number; product_name: string; qty: number; unit_price_cents: number };
  const comandaAfterAdd = (await (await api(`/api/comandas/comandas/${comanda.id}`, {}, admin!)).json()) as { items: ComandaItem[] };
  check('comanda tem 3 itens', comandaAfterAdd.items.length === 3);
  const sucoItem = comandaAfterAdd.items.find((i) => i.product_id === suco.id)!;
  const kitItemLine = comandaAfterAdd.items.find((i) => i.product_id === kit.id)!;
  const produzidoItem = comandaAfterAdd.items.find((i) => i.product_id === produzido.id)!;
  check('preco do suco congelado = 800 (catalogo no momento do pedido)', sucoItem.unit_price_cents === 800);
  check('preco do kit congelado = 2500', kitItemLine.unit_price_cents === 2500);
  check('preco do produzido congelado = 900', produzidoItem.unit_price_cents === 900);

  // Muda o preço do suco no catálogo DEPOIS do pedido — item já congelado não deve mudar
  await api(`/api/commercial/products/${suco.id}`, { method: 'PUT', body: JSON.stringify({ priceCents: 1500 }) }, admin!);
  const comandaAfterPriceChange = (await (await api(`/api/comandas/comandas/${comanda.id}`, {}, admin!)).json()) as { items: ComandaItem[] };
  check('preco do suco continua congelado em 800 mesmo após mudar o catálogo',
    comandaAfterPriceChange.items.find((i) => i.product_id === suco.id)?.unit_price_cents === 800);

  // ─── Anular item (voidItem) ───
  const addDescartavel = await api(`/api/comandas/comandas/${comanda.id}/items`, { method: 'POST', body: JSON.stringify({ productId: suco.id, qty: 1 }) }, admin!);
  const descartavel = (await addDescartavel.json()) as { id: number };
  const voidR = await api(`/api/comandas/comandas/${comanda.id}/items/${descartavel.id}`, { method: 'DELETE' }, admin!);
  check('item anulado', voidR.status === 200);
  const comandaAfterVoid = (await (await api(`/api/comandas/comandas/${comanda.id}`, {}, admin!)).json()) as { items: ComandaItem[] };
  check('item anulado nao aparece mais na comanda (continua com 3)', comandaAfterVoid.items.length === 3);

  // ─── Transferir de mesa ───
  const transferR = await api(`/api/comandas/comandas/${comanda.id}/transfer`, { method: 'POST', body: JSON.stringify({ tableId: tableB.id }) }, admin!);
  check('transferencia OK', transferR.status === 200);
  const statusAfterTransfer = (await (await api('/api/comandas/tables/status', {}, admin!)).json()) as { id: number; status: string }[];
  check('Mesa 1 libera após transferir', statusAfterTransfer.find((t) => t.id === tableA.id)?.status === 'livre');
  check('Mesa 2 fica ocupada após transferir', statusAfterTransfer.find((t) => t.id === tableB.id)?.status === 'ocupada');

  // ─── Dividir (split) ───
  const splitR = await api(`/api/comandas/comandas/${comanda.id}/split`, { method: 'POST', body: JSON.stringify({ itemIds: [sucoItem.id] }) }, admin!);
  const split = (await splitR.json()) as { newComandaId: number };
  check('split OK', splitR.status === 200 && !!split.newComandaId);
  const comandaAfterSplit = (await (await api(`/api/comandas/comandas/${comanda.id}`, {}, admin!)).json()) as { items: ComandaItem[] };
  check('comanda original ficou com 2 itens após split', comandaAfterSplit.items.length === 2);
  const newComandaAfterSplit = (await (await api(`/api/comandas/comandas/${split.newComandaId}`, {}, admin!)).json()) as { items: ComandaItem[] };
  check('nova comanda tem o item dividido (suco, preco 800 preservado)',
    newComandaAfterSplit.items.length === 1 && newComandaAfterSplit.items[0].unit_price_cents === 800);

  // ─── Unir (merge) de volta ───
  const mergeR = await api(`/api/comandas/comandas/${comanda.id}/merge`, { method: 'POST', body: JSON.stringify({ sourceComandaId: split.newComandaId }) }, admin!);
  check('merge OK', mergeR.status === 200);
  const comandaAfterMerge = (await (await api(`/api/comandas/comandas/${comanda.id}`, {}, admin!)).json()) as { items: ComandaItem[] };
  check('comanda voltou a ter 3 itens após merge', comandaAfterMerge.items.length === 3);
  const sourceAfterMerge = (await (await api(`/api/comandas/comandas/${split.newComandaId}`, {}, admin!)).json()) as { status: string };
  check('comanda de origem do split ficou cancelada após merge', sourceAfterMerge.status === 'cancelada');

  // ─── Fechar comanda (gera venda real) ───
  const totalCents = comandaAfterMerge.items.reduce((a, i) => a + i.unit_price_cents * i.qty, 0);
  check('total esperado = 800*2 + 2500*1 + 900*3 = 5800', totalCents === 800 * 2 + 2500 * 1 + 900 * 3);
  const methods = (await (await api('/api/store/payment-methods', {}, admin!)).json()) as { id: number; type: string }[];
  const pix = methods.find((m) => m.type === 'pix')!;
  const closeR = await api(`/api/comandas/comandas/${comanda.id}/close`, {
    method: 'POST', body: JSON.stringify({ payments: [{ methodId: pix.id, amountCents: totalCents }] }),
  }, admin!);
  const closed = (await closeR.json()) as { ok: true; saleId: number };
  check('fechamento gera venda', closeR.status === 200 && !!closed.saleId);

  const sale = (await (await api(`/api/store/sales/${closed.saleId}`, {}, admin!)).json()) as { total_cents: number; items: { product_name: string; qty: number; unit_price_cents: number; total_cents: number }[] };
  check('venda gerada com total correto (5800)', sale.total_cents === totalCents);
  check('venda tem 4 linhas (suco + kit + hamburguer(0) + produzido)', sale.items.length === 4);
  const hamburguerLine = sale.items.find((i) => i.product_name === 'Hamburguer');
  check('componente do kit expandiu a preco zero na venda', hamburguerLine?.unit_price_cents === 0 && hamburguerLine?.qty === 1);
  const produzidoLine = sale.items.find((i) => i.product_name === 'Suco Natural 300ml');
  check('produzido = 1 linha só (sem linha de insumo)', produzidoLine?.qty === 3 && produzidoLine?.unit_price_cents === 900);

  const insumoMovs = db.prepare("SELECT qty FROM stock_movements WHERE ref_entity='sale' AND ref_id=? AND product_id=? AND type='saida' AND reason='producao'").all(String(closed.saleId), laranja.id) as { qty: number }[];
  check('ficha tecnica consumiu insumo (Laranja 0.3*3=0.9)', insumoMovs.length === 1 && Math.abs(insumoMovs[0].qty - 0.9) < 0.0001, JSON.stringify(insumoMovs));

  const comandaFechada = (await (await api(`/api/comandas/comandas/${comanda.id}`, {}, admin!)).json()) as { status: string; sale_id: number };
  check('comanda marcada como fechada com sale_id', comandaFechada.status === 'fechada' && comandaFechada.sale_id === closed.saleId);
  const statusAfterClose = (await (await api('/api/comandas/tables/status', {}, admin!)).json()) as { id: number; status: string }[];
  check('Mesa 2 libera ao fechar a comanda', statusAfterClose.find((t) => t.id === tableB.id)?.status === 'livre');

  // ─── Cancelar comanda (libera mesa, sem gerar venda) ───
  const openC = await api('/api/comandas/comandas', { method: 'POST', body: JSON.stringify({ tableId: tableC.id }) }, admin!);
  const comandaC = (await openC.json()) as { id: number };
  await api(`/api/comandas/comandas/${comandaC.id}/items`, { method: 'POST', body: JSON.stringify({ productId: suco.id, qty: 1 }) }, admin!);
  const salesCountBefore = (db.prepare("SELECT COUNT(*) c FROM sales").get() as { c: number }).c;
  const cancelR = await api(`/api/comandas/comandas/${comandaC.id}/cancel`, { method: 'POST' }, admin!);
  check('cancelamento OK', cancelR.status === 200);
  const comandaCAfter = (await (await api(`/api/comandas/comandas/${comandaC.id}`, {}, admin!)).json()) as { status: string; sale_id: number | null };
  check('comanda cancelada, sem sale_id', comandaCAfter.status === 'cancelada' && comandaCAfter.sale_id == null);
  const salesCountAfter = (db.prepare("SELECT COUNT(*) c FROM sales").get() as { c: number }).c;
  check('cancelar não gera venda nenhuma', salesCountAfter === salesCountBefore, `antes=${salesCountBefore} depois=${salesCountAfter}`);
  const statusAfterCancel = (await (await api('/api/comandas/tables/status', {}, admin!)).json()) as { id: number; status: string }[];
  check('Mesa 3 libera ao cancelar', statusAfterCancel.find((t) => t.id === tableC.id)?.status === 'livre');

  // ─── Gating: desliga a capability de novo ───
  check('desliga comandas.mesas', (await api('/api/core/capabilities/comandas.mesas', { method: 'PUT', body: JSON.stringify({ enabled: false }) }, admin!)).status === 200);
  check('capability desligada: tables -> 403 de novo', (await api('/api/comandas/tables', {}, admin!)).status === 403);

  server.close();
  closeDb();
  console.log(failures === 0 ? '\nDoD Fase 4 (Comandas & Mesas): TODOS OS TESTES PASSARAM' : `\n${failures} falha(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
