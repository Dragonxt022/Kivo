/**
 * Teste das pendências: cargos & permissões, compras (já com API), orçamentos.
 */
import { migrateUp } from '../core/database/migrator';
import { runSeeds } from '../core/database/seeds';
import { createServer } from '../core/server';
import { getSqlite, closeDb } from '../core/database/connection';
import { resetTestDb, activateTestLicense } from './resetTestDb';

const PORT = Number(process.env.KATSU_PORT ?? 3699);
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

  const admin = await loginAs('admin', 'admin');
  check('login admin', admin !== null);

  // ---------- Cargos & permissões ----------
  const roles = (await (await api('/api/roles', {}, admin!)).json()) as { slug: string; permissions: string[] }[];
  check('lista cargos com permissões', roles.some((r) => r.slug === 'administrador'));
  const perms = (await (await api('/api/roles/permissions', {}, admin!)).json()) as { module: string }[];
  check('catálogo agrupável por módulo', new Set(perms.map((p) => p.module)).size >= 3);

  const newRole = await api('/api/roles', { method: 'POST', body: JSON.stringify({ name: 'Vendedor Balcão' }) }, admin!);
  check('cria cargo customizado', newRole.status === 201);
  const roleId = ((await newRole.json()) as { id: number }).id;

  const grant = await api(`/api/roles/${roleId}/permissions`, {
    method: 'PUT',
    body: JSON.stringify({ permissions: ['store.sales.create', 'store.sales.view', 'store.quotes.view', 'store.quotes.create', 'commercial.products.view', 'commercial.customers.view'] }),
  }, admin!);
  check('define permissões do cargo', grant.status === 200);
  check('permissão inexistente rejeitada', (await api(`/api/roles/${roleId}/permissions`, { method: 'PUT', body: JSON.stringify({ permissions: ['foo.bar'] }) }, admin!)).status === 400);
  const adminRole = (roles.find((r) => r.slug === 'administrador') as unknown as { id: number });
  check('admin não é editável', (await api(`/api/roles/${adminRole.id}/permissions`, { method: 'PUT', body: JSON.stringify({ permissions: [] }) }, admin!)).status === 400);

  // usuário com o novo cargo herda as permissões
  await api('/api/users', { method: 'POST', body: JSON.stringify({ username: 'balcao', name: 'Balcão', password: '123456', roleSlug: 'vendedor-balcao' }) }, admin!);
  const balcao = await loginAs('balcao', '123456');
  check('usuário do novo cargo loga', balcao !== null);
  const me = (await (await api('/api/auth/me', {}, balcao!)).json()) as { permissions: string[] };
  check('herda permissões do cargo', me.permissions.includes('store.sales.create') && !me.permissions.includes('users.delete'));

  // cargo em uso não pode ser excluído
  check('cargo em uso não exclui', (await api(`/api/roles/${roleId}`, { method: 'DELETE' }, admin!)).status === 400);

  // ---------- Preparação p/ orçamento ----------
  const cli = (await (await api('/api/commercial/customers', { method: 'POST', body: JSON.stringify({ name: 'Construtora ABC' }) }, admin!)).json()) as { id: number };
  const prod = (await (await api('/api/commercial/products', { method: 'POST', body: JSON.stringify({ name: 'Areia m3', priceCents: 12000, unit: 'm3' }) }, admin!)).json()) as { id: number };
  await api('/api/commercial/stock/move', { method: 'POST', body: JSON.stringify({ productId: prod.id, type: 'entrada', qty: 50 }) }, admin!);

  // ---------- Orçamentos ----------
  const q1 = await api('/api/store/quotes', {
    method: 'POST',
    body: JSON.stringify({ items: [{ productId: prod.id, qty: 10 }], customerId: cli.id, validUntil: '2027-01-01' }),
  }, balcao!);
  check('balcão cria orçamento (1.200,00)', q1.status === 201 && ((await q1.json()) as { totalCents: number }).totalCents === 120000);
  const quoteId = (db.prepare('SELECT id FROM quotes ORDER BY id DESC LIMIT 1').get() as { id: number }).id;

  // orçamento não mexe em estoque
  let stock = (db.prepare('SELECT stock_qty FROM products WHERE id = ?').get(prod.id) as { stock_qty: number }).stock_qty;
  check('orçamento não baixa estoque', stock === 50);

  // preço muda no catálogo — conversão honra o preço cotado
  await api(`/api/commercial/products/${prod.id}`, { method: 'PUT', body: JSON.stringify({ priceCents: 15000 }) }, admin!);
  const conv = await api(`/api/store/quotes/${quoteId}/convert`, {
    method: 'POST', body: JSON.stringify({ paymentMethod: 'pix' }),
  }, balcao!);
  const convData = (await conv.json()) as { id: number; totalCents: number };
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

  // balcão não vê caixa nem usuários (RBAC do cargo custom)
  check('balcão não vê caixa (403)', (await api('/api/finance/cash/current', {}, balcao!)).status === 403);
  check('balcão não vê usuários (403)', (await api('/api/users', {}, balcao!)).status === 403);

  // ---------- Compras (página usa API já testada; sanity) ----------
  const sup = (await (await api('/api/commercial/suppliers', { method: 'POST', body: JSON.stringify({ name: 'Areial do Zé' }) }, admin!)).json()) as { id: number };
  const buy = await api('/api/commercial/purchases', {
    method: 'POST', body: JSON.stringify({ supplierId: sup.id, items: [{ productId: prod.id, qty: 30, unitCostCents: 8000 }] }),
  }, admin!);
  check('compra recebida soma estoque (40+30=70)', buy.status === 201 &&
    (db.prepare('SELECT stock_qty FROM products WHERE id = ?').get(prod.id) as { stock_qty: number }).stock_qty === 70);

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
