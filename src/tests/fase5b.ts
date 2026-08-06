/**
 * Teste das pendências: cargos & permissões, compras (já com API), orçamentos.
 */
import { randomUUID } from 'node:crypto';
import { migrateUp } from '../core/database/migrator';
import { runSeeds } from '../core/database/seeds';
import { createServer } from '../core/server';
import { getSqlite, closeDb } from '../core/database/connection';
import { resetTestDb, activateTestLicense } from './resetTestDb';
import { unwrap } from './testUtils';

const PORT = Number(process.env.KIVO_PORT ?? 3699);
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

  // ---------- Cargos & permissões ----------
  const roles = await unwrap<{ slug: string; permissions: string[] }[]>(await api('/api/roles', {}, admin!));
  check('lista cargos com permissões', roles.some((r) => r.slug === 'administrador'));
  const perms = await unwrap<{ module: string }[]>(await api('/api/roles/permissions', {}, admin!));
  check('catálogo agrupável por módulo', new Set(perms.map((p) => p.module)).size >= 3);

  const newRole = await api('/api/roles', { method: 'POST', body: JSON.stringify({ name: 'Vendedor Balcão' }) }, admin!);
  check('cria cargo customizado', newRole.status === 201);
  const roleId = (await unwrap<{ id: number }>(newRole)).id;

  const grant = await api(`/api/roles/${roleId}/permissions`, {
    method: 'PUT',
    body: JSON.stringify({ permissions: ['store.sales.create', 'store.sales.view', 'store.quotes.view', 'store.quotes.create', 'commercial.products.view', 'commercial.customers.view'] }),
  }, admin!);
  check('define permissões do cargo', grant.status === 200);
  check('permissão inexistente rejeitada', (await api(`/api/roles/${roleId}/permissions`, { method: 'PUT', body: JSON.stringify({ permissions: ['foo.bar'] }) }, admin!)).status === 400);
  const adminRole = (roles.find((r) => r.slug === 'administrador') as unknown as { id: number });
  check('admin não é editável', (await api(`/api/roles/${adminRole.id}/permissions`, { method: 'PUT', body: JSON.stringify({ permissions: [] }) }, admin!)).status === 400);

  // usuário com o novo cargo herda as permissões
  await api('/api/users', { method: 'POST', body: JSON.stringify({ username: 'balcao', name: 'Balcão', password: 'Teste1234', roleSlug: 'vendedor-balcao' }) }, admin!);
  const balcao = await loginAs('balcao', 'Teste1234');
  check('usuário do novo cargo loga', balcao !== null);
  const me = await unwrap<{ permissions: string[] }>(await api('/api/auth/me', {}, balcao!));
  check('herda permissões do cargo', me.permissions.includes('store.sales.create') && !me.permissions.includes('users.delete'));

  // cargo em uso não pode ser excluído
  check('cargo em uso não exclui', (await api(`/api/roles/${roleId}`, { method: 'DELETE' }, admin!)).status === 400);

  // ---------- Preparação p/ orçamento ----------
  // Venda exige caixa aberto (createSale bloqueia sem registro aberto).
  await api('/api/finance/cash/open', { method: 'POST', body: JSON.stringify({ openingCents: 10000 }) }, admin!);
  const cli = await unwrap<{ id: number }>(await api('/api/commercial/customers', { method: 'POST', body: JSON.stringify({ name: 'Construtora ABC' }) }, admin!));
  const prod = await unwrap<{ id: number }>(await api('/api/commercial/products', { method: 'POST', body: JSON.stringify({ name: 'Areia m3', priceCents: 12000, unit: 'm3' }) }, admin!));
  await api('/api/commercial/stock/move', { method: 'POST', body: JSON.stringify({ productId: prod.id, type: 'entrada', qty: 50 }) }, admin!);

  // ---------- Orçamentos ----------
  const q1 = await api('/api/store/quotes', {
    method: 'POST',
    body: JSON.stringify({ items: [{ productId: prod.id, qty: 10 }], customerId: cli.id, validUntil: '2027-01-01' }),
  }, balcao!);
  check('balcão cria orçamento (1.200,00)', q1.status === 201 && (await unwrap<{ totalCents: number }>(q1)).totalCents === 120000);
  const quoteId = (db.prepare('SELECT id FROM quotes ORDER BY id DESC LIMIT 1').get() as { id: number }).id;

  // orçamento não mexe em estoque
  let stock = (db.prepare('SELECT stock_qty FROM products WHERE id = ?').get(prod.id) as { stock_qty: number }).stock_qty;
  check('orçamento não baixa estoque', stock === 50);

  // preço muda no catálogo — conversão honra o preço cotado
  await api(`/api/commercial/products/${prod.id}`, { method: 'PUT', body: JSON.stringify({ priceCents: 15000 }) }, admin!);
  const conv = await api(`/api/store/quotes/${quoteId}/convert`, {
    method: 'POST', body: JSON.stringify({ paymentMethod: 'pix' }),
  }, balcao!);
  const convData = await unwrap<{ id: number; totalCents: number }>(conv);
  check('conversão honra preço cotado (1.200,00, não 1.500,00)', conv.status === 201 && convData.totalCents === 120000, `total=${convData.totalCents}`);
  stock = (db.prepare('SELECT stock_qty FROM products WHERE id = ?').get(prod.id) as { stock_qty: number }).stock_qty;
  check('conversão baixa estoque (50→40)', stock === 40);
  const qRow = db.prepare('SELECT status, sale_id FROM quotes WHERE id = ?').get(quoteId) as { status: string; sale_id: number };
  check('orçamento marcado convertido com venda vinculada', qRow.status === 'convertido' && qRow.sale_id === convData.id);
  check('converter de novo → 400', (await api(`/api/store/quotes/${quoteId}/convert`, { method: 'POST', body: JSON.stringify({ paymentMethod: 'pix' }) }, balcao!)).status === 400);

  // orçamento vencido não converte
  const qOld = await api('/api/store/quotes', {
    method: 'POST', body: JSON.stringify({ items: [{ productId: prod.id, qty: 1 }], validUntil: '2020-01-01' }),
  }, admin!);
  const qOldId = (db.prepare('SELECT id FROM quotes ORDER BY id DESC LIMIT 1').get() as { id: number }).id;
  check('orçamento vencido criado', qOld.status === 201);
  check('vencido não converte (400)', (await api(`/api/store/quotes/${qOldId}/convert`, { method: 'POST', body: JSON.stringify({ paymentMethod: 'pix' }) }, admin!)).status === 400);
  check('cancela orçamento', (await api(`/api/store/quotes/${qOldId}/cancel`, { method: 'POST' }, admin!)).status === 200);

  // orçamento sem desconto: balcão (sem store.sales.discount) não aplica desconto
  check('balcão sem desconto não cria orçamento com desconto (400)',
    (await api('/api/store/quotes', {
      method: 'POST',
      body: JSON.stringify({ items: [{ productId: prod.id, qty: 1 }], discountCents: 100 }),
    }, balcao!)).status === 400);

  // desconto dado por quem pode (admin), faturado por quem não pode (balcão) → passa,
  // o desconto já foi autorizado na criação do orçamento
  const qDisc = await api('/api/store/quotes', {
    method: 'POST',
    body: JSON.stringify({ items: [{ productId: prod.id, qty: 10 }], discountCents: 2000, validUntil: '2027-01-01' }),
  }, admin!);
  check('admin cria orçamento com desconto (10×15.000,00 - 2.000,00 = 148.000,00)',
    qDisc.status === 201 && (await unwrap<{ totalCents: number }>(qDisc)).totalCents === 148000);
  const qDiscId = (db.prepare('SELECT id FROM quotes ORDER BY id DESC LIMIT 1').get() as { id: number }).id;
  const convDisc = await api(`/api/store/quotes/${qDiscId}/convert`, {
    method: 'POST', body: JSON.stringify({ paymentMethod: 'pix' }),
  }, balcao!);
  check('balcão fatura orçamento com desconto alheio (allowDiscount)',
    convDisc.status === 201 && (await unwrap<{ totalCents: number }>(convDisc)).totalCents === 148000);

  // ---------- Orçamento com complemento: vínculo e preço cotado ----------
  const main = await unwrap<{ id: number }>(await api('/api/commercial/products', {
    method: 'POST', body: JSON.stringify({ name: 'X-Burger', priceCents: 2500, unit: 'un' }),
  }, admin!));
  const opt = await unwrap<{ id: number }>(await api('/api/commercial/products', {
    method: 'POST', body: JSON.stringify({ name: 'Molho barbecue', priceCents: 300, unit: 'un', trackStock: false }),
  }, admin!));
  const grpId = Number(db.prepare(
    'INSERT INTO complement_groups (name, min_select, max_select, uuid) VALUES (?, ?, ?, ?)',
  ).run('Molhos', 0, 3, randomUUID()).lastInsertRowid);
  db.prepare('INSERT INTO complement_group_items (group_id, product_id, price_override_cents, sort_order, uuid) VALUES (?, ?, ?, ?, ?)')
    .run(grpId, opt.id, null, 1, randomUUID());
  db.prepare('INSERT INTO product_complement_groups (product_id, group_id, sort_order, uuid) VALUES (?, ?, ?, ?)')
    .run(main.id, grpId, 1, randomUUID());

  const lg = randomUUID();
  const qComp = await api('/api/store/quotes', {
    method: 'POST',
    body: JSON.stringify({ items: [
      { productId: main.id, qty: 2, lineGroupUuid: lg, notes: 'sem cebola' },
      { productId: opt.id, qty: 1, lineGroupUuid: lg },
    ] }),
  }, balcao!);
  check('balcão cria orçamento com complemento (2×2.500 + 300 = 5.300)',
    qComp.status === 201 && (await unwrap<{ totalCents: number }>(qComp)).totalCents === 5300);

  // preço muda no catálogo — a conversão tem que honrar o preço cotado nas duas linhas
  await api(`/api/commercial/products/${main.id}`, { method: 'PUT', body: JSON.stringify({ priceCents: 3500 }) }, admin!);
  await api(`/api/commercial/products/${opt.id}`, { method: 'PUT', body: JSON.stringify({ priceCents: 600 }) }, admin!);
  const qCompId = (db.prepare('SELECT id FROM quotes ORDER BY id DESC LIMIT 1').get() as { id: number }).id;
  const convComp = await api(`/api/store/quotes/${qCompId}/convert`, {
    method: 'POST', body: JSON.stringify({ paymentMethod: 'pix' }),
  }, balcao!);
  const convCompData = await unwrap<{ id: number; totalCents: number }>(convComp);
  check('converte orçamento com complemento', convComp.status === 201);
  const saleItems = db.prepare('SELECT product_id, unit_price_cents, line_group_uuid, notes FROM sale_items WHERE sale_id = ? ORDER BY id')
    .all(convCompData.id) as { product_id: number; unit_price_cents: number; line_group_uuid: string | null; notes: string | null }[];
  const compMain = saleItems.find((i) => i.product_id === main.id);
  const compOpt = saleItems.find((i) => i.product_id === opt.id);
  check('principal preserva line_group_uuid', compMain?.line_group_uuid === lg);
  check('complemento é linha irmã com o mesmo line_group_uuid', compOpt?.line_group_uuid === compMain?.line_group_uuid && compOpt?.line_group_uuid != null);
  check('preço cotado do principal (2.500, não 3.500)', compMain?.unit_price_cents === 2500);
  check('preço cotado do complemento (300, não 600)', compOpt?.unit_price_cents === 300);
  check('observação do item preservada', compMain?.notes === 'sem cebola');
  check('total da venda com complemento (5.300)', convCompData.totalCents === 5300);

  // balcão não vê caixa nem usuários (RBAC do cargo custom)
  check('balcão não vê caixa (403)', (await api('/api/finance/cash/current', {}, balcao!)).status === 403);
  check('balcão não vê usuários (403)', (await api('/api/users', {}, balcao!)).status === 403);

  // ---------- Compras (página usa API já testada; sanity) ----------
  const sup = await unwrap<{ id: number }>(await api('/api/commercial/suppliers', { method: 'POST', body: JSON.stringify({ name: 'Areial do Zé' }) }, admin!));
  const buy = await api('/api/commercial/purchases', {
    method: 'POST', body: JSON.stringify({ supplierId: sup.id, items: [{ productId: prod.id, qty: 30, unitCostCents: 8000 }] }),
  }, admin!);
  check('compra recebida soma estoque (30+30=60)', buy.status === 201 &&
    (db.prepare('SELECT stock_qty FROM products WHERE id = ?').get(prod.id) as { stock_qty: number }).stock_qty === 60);

  // auditoria cobre role e quote
  const entities = new Set((db.prepare('SELECT DISTINCT entity FROM audit_logs').all() as { entity: string }[]).map((a) => a.entity));
  check('auditoria cobre role e quote', entities.has('role') && entities.has('quote'));

  server.close();
  closeDb();
  console.log(failures === 0 ? '\nPendências: TODOS OS TESTES PASSARAM' : `\n${failures} falha(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
