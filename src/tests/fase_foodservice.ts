/**
 * Teste da DoD da Fase 3 (Food Service — cozinha):
 * roteia 1 produto para a cozinha e deixa outro de fora; uma venda real
 * (POST /api/store/sales) deve gerar 1 kitchen_ticket com só o item roteado;
 * avançar status do item reflete no ticket; venda sem item roteado não cria ticket;
 * tudo atrás da capability 'foodservice.cozinha'.
 */
import { migrateUp } from '../core/database/migrator';
import { runSeeds } from '../core/database/seeds';
import { createServer } from '../core/server';
import { getSqlite, closeDb } from '../core/database/connection';
import { resetTestDb, activateTestLicense } from './resetTestDb';
import { unwrap } from './testUtils';

const PORT = Number(process.env.KATSU_PORT ?? 3790);
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

  // Capability comeca desligada
  check('foodservice.cozinha comeca desligada',
    (db.prepare("SELECT enabled FROM capabilities WHERE key='foodservice.cozinha'").get() as { enabled: number } | undefined)?.enabled === 0);
  check('sem capability: kitchen/tickets -> 403',
    (await api('/api/foodservice/kitchen/tickets', {}, admin!)).status === 403);
  check('liga capability foodservice.cozinha',
    (await api('/api/core/capabilities/foodservice.cozinha', { method: 'PUT', body: JSON.stringify({ enabled: true }) }, admin!)).status === 200);

  // Produtos: 1 vai pra cozinha, o outro fica de fora
  const hamburguer = await unwrap<{ id: number }>(await api('/api/commercial/products', { method: 'POST', body: JSON.stringify({ name: 'Hamburguer', priceCents: 1800 }) }, admin!));
  const refrigerante = await unwrap<{ id: number }>(await api('/api/commercial/products', { method: 'POST', body: JSON.stringify({ name: 'Refrigerante lata', priceCents: 600 }) }, admin!));

  const routeR = await api('/api/foodservice/kitchen-routing', {
    method: 'POST', body: JSON.stringify({ productId: hamburguer.id, station: 'Chapa', estimatedMinutes: 12 }),
  }, admin!);
  check('roteia Hamburguer pra cozinha', routeR.status === 201);
  const routing = await unwrap<{ product_id: number }[]>(await api('/api/foodservice/kitchen-routing', {}, admin!));
  check('kitchen-routing lista só o Hamburguer', routing.length === 1 && routing[0].product_id === hamburguer.id);
  check('roteamento duplicado -> 409',
    (await api('/api/foodservice/kitchen-routing', { method: 'POST', body: JSON.stringify({ productId: hamburguer.id }) }, admin!)).status === 409);

  // Venda com os 2 produtos: só o Hamburguer deve gerar ticket
  const saleR = await api('/api/store/sales', {
    method: 'POST',
    body: JSON.stringify({ items: [{ productId: hamburguer.id, qty: 2 }, { productId: refrigerante.id, qty: 1 }], paymentMethod: 'pix' }),
  }, admin!);
  const sale = await unwrap<{ id: number }>(saleR);
  check('venda concluída', saleR.status === 201);

  const tickets1 = await unwrap<{ id: number; source_type: string; source_id: number; status: string; items: { id: number; product_id: number; qty: number; status: string }[] }[]>(await api('/api/foodservice/kitchen/tickets', {}, admin!));
  check('1 ticket criado pela venda', tickets1.length === 1, `got ${tickets1.length}`);
  const ticket = tickets1[0];
  check('ticket referencia a venda (source_type=sale)', ticket.source_type === 'sale' && ticket.source_id === sale.id);
  check('ticket tem só 1 item (só o roteado)', ticket.items.length === 1);
  check('item do ticket = Hamburguer qty=2', ticket.items[0].product_id === hamburguer.id && ticket.items[0].qty === 2);
  check('ticket começa pendente', ticket.status === 'pendente' && ticket.items[0].status === 'pendente');

  // Avança status do item -> ticket (único item) reflete
  const advR = await api(`/api/foodservice/kitchen/tickets/${ticket.id}/items/${ticket.items[0].id}/status`, {
    method: 'PUT', body: JSON.stringify({ status: 'pronto' }),
  }, admin!);
  check('avança item pra pronto', advR.status === 200);
  const tickets2 = await unwrap<{ id: number; status: string }[]>(await api('/api/foodservice/kitchen/tickets?status=pronto', {}, admin!));
  check('ticket reavaliado pra pronto (item único)', tickets2.some((t) => t.id === ticket.id && t.status === 'pronto'));

  const advTicketR = await api(`/api/foodservice/kitchen/tickets/${ticket.id}/status`, {
    method: 'PUT', body: JSON.stringify({ status: 'entregue' }),
  }, admin!);
  check('avança ticket inteiro pra entregue', advTicketR.status === 200);
  const ticketRow = db.prepare('SELECT status FROM kitchen_tickets WHERE id = ?').get(ticket.id) as { status: string };
  check('ticket status = entregue no banco', ticketRow.status === 'entregue');

  // Venda só com o produto NÃO roteado -> nenhum ticket novo
  const ticketsBefore = (db.prepare('SELECT COUNT(*) c FROM kitchen_tickets').get() as { c: number }).c;
  const saleSemRoteado = await api('/api/store/sales', {
    method: 'POST', body: JSON.stringify({ items: [{ productId: refrigerante.id, qty: 3 }], paymentMethod: 'pix' }),
  }, admin!);
  check('venda sem item roteado ainda funciona', saleSemRoteado.status === 201);
  const ticketsAfter = (db.prepare('SELECT COUNT(*) c FROM kitchen_tickets').get() as { c: number }).c;
  check('venda sem item roteado não cria ticket novo', ticketsAfter === ticketsBefore, `antes=${ticketsBefore} depois=${ticketsAfter}`);

  // Desliga a capability de novo -> volta a bloquear
  check('desliga capability foodservice.cozinha',
    (await api('/api/core/capabilities/foodservice.cozinha', { method: 'PUT', body: JSON.stringify({ enabled: false }) }, admin!)).status === 200);
  check('capability desligada: kitchen/tickets -> 403 de novo',
    (await api('/api/foodservice/kitchen/tickets', {}, admin!)).status === 403);

  server.close();
  closeDb();
  console.log(failures === 0 ? '\nDoD Fase 3 (Food Service): TODOS OS TESTES PASSARAM' : `\n${failures} falha(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
