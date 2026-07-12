/**
 * Teste da DoD da Fase 3 (módulo commercial):
 * CRUD com permissões e auditoria; movimentação de estoque consistente;
 * RBAC fino (alterar preço separado de editar produto); compra gera entrada.
 */
import { migrateUp } from '../core/database/migrator';
import { runSeeds } from '../core/database/seeds';
import { createServer } from '../core/server';
import { getSqlite, closeDb } from '../core/database/connection';
import { resetTestDb, activateTestLicense } from './resetTestDb';

const PORT = Number(process.env.KATSU_PORT ?? 3399);
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
  const C = '/api/commercial';

  const admin = await loginAs('admin', 'admin');
  check('login admin', admin !== null);

  // usuários de teste: operador (sem permissões) e estoquista com permissões finas
  for (const [u, role] of [['op3', 'operador'], ['estoq', 'estoquista']] as const) {
    await api('/api/users', { method: 'POST', body: JSON.stringify({ username: u, name: u, password: '123456', roleSlug: role }) }, admin!);
  }
  const roleId = (db.prepare("SELECT id FROM roles WHERE slug = 'estoquista'").get() as { id: number }).id;
  for (const key of ['commercial.products.view', 'commercial.products.edit', 'commercial.stock.view', 'commercial.stock.move']) {
    db.prepare('INSERT INTO role_permissions (role_id, permission_key) VALUES (?, ?) ON CONFLICT DO NOTHING').run(roleId, key);
  }
  const op = await loginAs('op3', '123456');
  const estoq = await loginAs('estoq', '123456');

  // ---- Clientes: validação Shared + RBAC ----
  check('operador não lista clientes (403)', (await api(`${C}/customers`, {}, op!)).status === 403);
  const badDoc = await api(`${C}/customers`, { method: 'POST', body: JSON.stringify({ name: 'X', document: '111.111.111-11' }) }, admin!);
  check('CPF inválido rejeitado (400)', badDoc.status === 400);
  const cust = await api(`${C}/customers`, { method: 'POST', body: JSON.stringify({ name: 'Cliente Bom', document: '529.982.247-25', phone: '11 99999-0000' }) }, admin!);
  check('cliente criado com CPF válido', cust.status === 201);
  const custId = ((await cust.json()) as { id: number }).id;
  check('cliente editado', (await api(`${C}/customers/${custId}`, { method: 'PUT', body: JSON.stringify({ phone: '11 98888-0000' }) }, admin!)).status === 200);
  check('cliente excluído (soft)', (await api(`${C}/customers/${custId}`, { method: 'DELETE' }, admin!)).status === 200);
  const softRow = db.prepare('SELECT deleted_at FROM customers WHERE id = ?').get(custId) as { deleted_at: string | null };
  check('soft delete preservou a linha', softRow.deleted_at !== null);

  // ---- Fornecedor e produto ----
  const sup = await api(`${C}/suppliers`, { method: 'POST', body: JSON.stringify({ name: 'Fornecedor SA', document: '11.222.333/0001-81' }) }, admin!);
  check('fornecedor criado', sup.status === 201);
  const supId = ((await sup.json()) as { id: number }).id;

  const prod = await api(`${C}/products`, { method: 'POST', body: JSON.stringify({ name: 'Arroz 5kg', barcode: '789100000003', priceCents: 2590, costCents: 1800, minStock: 2 }) }, admin!);
  check('produto criado', prod.status === 201);
  const prodId = ((await prod.json()) as { id: number }).id;

  // ---- RBAC fino: preço separado de edição ----
  const editName = await api(`${C}/products/${prodId}`, { method: 'PUT', body: JSON.stringify({ name: 'Arroz Tipo 1 5kg' }) }, estoq!);
  check('estoquista edita produto (sem preço)', editName.status === 200);
  const editPrice = await api(`${C}/products/${prodId}`, { method: 'PUT', body: JSON.stringify({ priceCents: 9999 }) }, estoq!);
  check('estoquista NÃO altera preço (403)', editPrice.status === 403);
  check('admin altera preço', (await api(`${C}/products/${prodId}`, { method: 'PUT', body: JSON.stringify({ priceCents: 2790 }) }, admin!)).status === 200);
  const editStock = await api(`${C}/products/${prodId}`, { method: 'PUT', body: JSON.stringify({ stockQty: 999 }) }, admin!);
  check('saldo não é editável direto (400)', editStock.status === 400);

  // ---- Estoque consistente ----
  const mv = (type: string, qty: number, c = estoq!) =>
    api(`${C}/stock/move`, { method: 'POST', body: JSON.stringify({ productId: prodId, type, qty, reason: 'teste' }) }, c);
  check('operador não movimenta (403)', (await mv('entrada', 1, op!)).status === 403);
  check('entrada 10', (await mv('entrada', 10)).status === 200);
  check('saída 3', (await mv('saida', 3)).status === 200);
  const over = await mv('saida', 100);
  check('saída maior que saldo bloqueada (400)', over.status === 400);
  let saldo = (db.prepare('SELECT stock_qty FROM products WHERE id = ?').get(prodId) as { stock_qty: number }).stock_qty;
  check('saldo consistente = 7', saldo === 7, `saldo=${saldo}`);
  check('ajuste para 5', (await mv('ajuste', 5)).status === 200);
  saldo = (db.prepare('SELECT stock_qty FROM products WHERE id = ?').get(prodId) as { stock_qty: number }).stock_qty;
  check('ajuste define saldo = 5', saldo === 5);
  const moves = db.prepare('SELECT type, qty, balance_after FROM stock_movements WHERE product_id = ? ORDER BY id').all(prodId) as { balance_after: number }[];
  check('livro-razão com saldos corretos', moves.length === 3 && moves[0].balance_after === 10 && moves[1].balance_after === 7 && moves[2].balance_after === 5);

  // ---- Compra gera entrada e atualiza custo ----
  const buy = await api(`${C}/purchases`, {
    method: 'POST',
    body: JSON.stringify({ supplierId: supId, items: [{ productId: prodId, qty: 20, unitCostCents: 1750 }] }),
  }, admin!);
  check('compra registrada', buy.status === 201);
  const after = db.prepare('SELECT stock_qty, cost_cents FROM products WHERE id = ?').get(prodId) as { stock_qty: number; cost_cents: number };
  check('compra somou estoque (5+20=25)', after.stock_qty === 25, `saldo=${after.stock_qty}`);
  check('compra atualizou custo (1750)', after.cost_cents === 1750);
  const total = (db.prepare('SELECT total_cents FROM purchases ORDER BY id DESC LIMIT 1').get() as { total_cents: number }).total_cents;
  check('total da compra = 35000', total === 35000);

  // ---- Auditoria cobre o commercial ----
  const entities = new Set((db.prepare('SELECT DISTINCT entity FROM audit_logs').all() as { entity: string }[]).map((a) => a.entity));
  check('auditoria cobre customer/supplier/product/purchase', ['customer', 'supplier', 'product', 'purchase'].every((e) => entities.has(e)));

  server.close();
  closeDb();
  console.log(failures === 0 ? '\nDoD Fase 3: TODOS OS TESTES PASSARAM' : `\n${failures} falha(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
