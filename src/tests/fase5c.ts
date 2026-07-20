/**
 * Teste: troca de senha, categorias na UI (API), impressão (cupom e orçamento).
 */
import { migrateUp } from '../core/database/migrator';
import { runSeeds } from '../core/database/seeds';
import { createServer } from '../core/server';
import { getSqlite, closeDb } from '../core/database/connection';
import { resetTestDb, activateTestLicense } from './resetTestDb';
import { unwrap } from './testUtils';

const PORT = Number(process.env.KIVO_PORT ?? 3799);
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

  // ---------- Troca de senha ----------
  await api('/api/users', { method: 'POST', body: JSON.stringify({ username: 'joana', name: 'Joana', password: '123456', roleSlug: 'caixa' }) }, admin!);
  const s1 = await loginAs('joana', '123456');
  const s2 = await loginAs('joana', '123456'); // segunda sessão (outro dispositivo)
  check('joana com 2 sessões', s1 !== null && s2 !== null);

  check('senha atual errada → 400', (await api('/api/auth/change-password', {
    method: 'POST', body: JSON.stringify({ currentPassword: 'errada', newPassword: 'nova12345' }),
  }, s1!)).status === 400);
  check('senha curta → 400', (await api('/api/auth/change-password', {
    method: 'POST', body: JSON.stringify({ currentPassword: '123456', newPassword: '123' }),
  }, s1!)).status === 400);
  check('troca de senha ok', (await api('/api/auth/change-password', {
    method: 'POST', body: JSON.stringify({ currentPassword: '123456', newPassword: 'nova12345' }),
  }, s1!)).status === 200);
  check('sessão atual continua válida', (await api('/api/auth/me', {}, s1!)).status === 200);
  check('outra sessão foi derrubada', (await api('/api/auth/me', {}, s2!)).status === 401);
  check('senha antiga não loga mais', (await loginAs('joana', '123456')) === null);
  check('senha nova loga', (await loginAs('joana', 'nova12345')) !== null);

  // ---------- Categorias ----------
  const cat = await api('/api/commercial/categories', { method: 'POST', body: JSON.stringify({ name: 'Hidráulica' }) }, admin!);
  check('cria categoria', cat.status === 201);
  const catId = (await unwrap<{ id: number }>(cat)).id;
  const prod = await api('/api/commercial/products', {
    method: 'POST', body: JSON.stringify({ name: 'Cano PVC 25mm', priceCents: 1590, categoryId: catId }),
  }, admin!);
  check('produto com categoria', prod.status === 201 && (await unwrap<{ category: string }>(prod)).category === 'Hidráulica');
  const list = await unwrap<{ name: string }[]>(await api('/api/commercial/categories', {}, admin!));
  check('lista categorias', list.some((c) => c.name === 'Hidráulica'));

  // ---------- Impressão ----------
  await api('/api/settings/empresa.nome', { method: 'PUT', body: JSON.stringify({ value: 'Depósito Kivo' }) }, admin!);
  const prodId = (db.prepare("SELECT id FROM products WHERE name = 'Cano PVC 25mm'").get() as { id: number }).id;
  await api('/api/commercial/stock/move', { method: 'POST', body: JSON.stringify({ productId: prodId, type: 'entrada', qty: 100 }) }, admin!);
  const sale = await unwrap<{ id: number }>(await api('/api/store/sales', {
    method: 'POST', body: JSON.stringify({ items: [{ productId: prodId, qty: 4 }], paymentMethod: 'pix' }),
  }, admin!));
  const cupom = await fetch(`${base}/app/store/vendas/${sale.id}/cupom`, { headers: { cookie: admin! } });
  const cupomHtml = await cupom.text();
  check('cupom renderiza (200)', cupom.status === 200);
  check('cupom tem empresa e total', cupomHtml.includes('Depósito Kivo') && cupomHtml.includes('63,60'));

  await api('/api/store/quotes', {
    method: 'POST', body: JSON.stringify({ items: [{ productId: prodId, qty: 10 }], customerName: 'Obra da Rua 7', validUntil: '2027-01-01' }),
  }, admin!);
  const quoteId = (db.prepare('SELECT id FROM quotes ORDER BY id DESC LIMIT 1').get() as { id: number }).id;
  const printQ = await fetch(`${base}/app/store/orcamentos/${quoteId}/imprimir`, { headers: { cookie: admin! } });
  const quoteHtml = await printQ.text();
  check('orçamento imprimível renderiza (200)', printQ.status === 200);
  check('orçamento tem cliente e validade', quoteHtml.includes('Obra da Rua 7') && quoteHtml.includes('01/01/2027'));
  check('cupom de venda inexistente → 404', (await fetch(`${base}/app/store/vendas/99999/cupom`, { headers: { cookie: admin! } })).status === 404);

  // auditoria
  const actions = new Set((db.prepare('SELECT DISTINCT action FROM audit_logs').all() as { action: string }[]).map((a) => a.action));
  check('auditoria registra troca de senha (e falha)', actions.has('senha_trocada') && actions.has('senha_falhou'));

  server.close();
  closeDb();
  console.log(failures === 0 ? '\nFase 5c: TODOS OS TESTES PASSARAM' : `\n${failures} falha(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
