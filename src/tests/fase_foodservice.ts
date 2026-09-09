/**
 * Teste da DoD da Fase 3 (Food Service — cozinha):
 * roteia 1 produto para a cozinha e deixa outro de fora; uma venda real
 * (POST /api/store/sales) deve gerar 1 kitchen_ticket com só o item roteado;
 * avançar status do item reflete no ticket; venda sem item roteado não cria ticket;
 * tudo atrás da capability 'foodservice.cozinha'.
 *
 * Cenários de correção (bugfix KDS):
 * - avançar o ticket INTEIRO propaga pros itens; recalc por item não rebaixa ticket 'entregue';
 * - cancelar venda/comanda marca os tickets em aberto como 'cancelado' (não ficam pendentes eternos);
 * - item de comanda NÃO vai automático: só no "Enviar p/ cozinha" explícito do garçom
 *   (reenvio não duplica; anular antes do envio nunca criou ticket; anular depois remove;
 *   observação editada após o envio espelha no ticket enquanto pendente);
 * - fechar comanda NÃO cria ticket 'sale' duplicado (itens já foram no envio explícito).
 */
import { migrateUp } from '../core/database/migrator';
import { runSeeds } from '../core/database/seeds';
import { createServer } from '../core/server';
import { getSqlite, closeDb } from '../core/database/connection';
import { resetTestDb, activateTestLicense } from './resetTestDb';
import { unwrap } from './testUtils';

const PORT = Number(process.env.KIVO_PORT ?? 3790);
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
  await api('/api/finance/cash/open', { method: 'POST', body: JSON.stringify({ openingCents: 5000 }) }, admin!);

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

  // ── Correções: ticket criado agora tem created_at (idade no painel) ──
  const createdRow = db.prepare('SELECT created_at FROM kitchen_tickets LIMIT 1').get() as { created_at: string } | undefined;
  check('ticket tem created_at', !!createdRow?.created_at);

  // ── Correção: avançar o ticket INTEIRO propaga pros itens não entregues ──
  const sale2 = await unwrap<{ id: number }>(await api('/api/store/sales', {
    method: 'POST', body: JSON.stringify({ items: [{ productId: hamburguer.id, qty: 1 }], paymentMethod: 'pix' }),
  }, admin!));
  const t2 = (await unwrap<{ id: number; source_type: string; source_id: number }[]>(await api('/api/foodservice/kitchen/tickets?status=pendente', {}, admin!)))
    .find((t) => t.source_type === 'sale' && t.source_id === sale2.id)!;
  check('ticket da 2a venda criado pendente', !!t2);
  check('avança ticket inteiro pra pronto',
    (await api(`/api/foodservice/kitchen/tickets/${t2.id}/status`, { method: 'PUT', body: JSON.stringify({ status: 'pronto' }) }, admin!)).status === 200);
  const t2items = db.prepare('SELECT status FROM kitchen_ticket_items WHERE ticket_id = ?').all(t2.id) as { status: string }[];
  check('avançar ticket propaga pros itens', t2items.length > 0 && t2items.every((i) => i.status === 'pronto'));

  // Guarda: item corrigido manualmente depois do ticket entregue NÃO rebaixa o ticket
  // (antes o recalc fazia o ticket "entregue" voltar a aparecer como "em preparo").
  check('avança ticket 2 pra entregue',
    (await api(`/api/foodservice/kitchen/tickets/${t2.id}/status`, { method: 'PUT', body: JSON.stringify({ status: 'entregue' }) }, admin!)).status === 200);
  const t2itemId = (db.prepare('SELECT id FROM kitchen_ticket_items WHERE ticket_id = ? LIMIT 1').get(t2.id) as { id: number }).id;
  await api(`/api/foodservice/kitchen/tickets/${t2.id}/items/${t2itemId}/status`, { method: 'PUT', body: JSON.stringify({ status: 'preparo' }) }, admin!);
  await api(`/api/foodservice/kitchen/tickets/${t2.id}/items/${t2itemId}/status`, { method: 'PUT', body: JSON.stringify({ status: 'pronto' }) }, admin!);
  const t2final = db.prepare('SELECT status FROM kitchen_tickets WHERE id = ?').get(t2.id) as { status: string };
  check('recalc não rebaixa ticket entregue', t2final.status === 'entregue');

  // ── Correção: cancelar a venda cancela os tickets em aberto dela ──
  const saleC = await unwrap<{ id: number }>(await api('/api/store/sales', {
    method: 'POST', body: JSON.stringify({ items: [{ productId: hamburguer.id, qty: 1 }], paymentMethod: 'pix' }),
  }, admin!));
  const ticketCancel = db.prepare("SELECT id, status FROM kitchen_tickets WHERE source_type = 'sale' AND source_id = ?").get(saleC.id) as { id: number; status: string };
  check('ticket da venda cancelável existe pendente', ticketCancel?.status === 'pendente');
  check('cancela a venda', (await api(`/api/store/sales/${saleC.id}/cancel`, { method: 'POST' }, admin!)).status === 200);
  const afterCancel = db.prepare('SELECT status FROM kitchen_tickets WHERE id = ?').get(ticketCancel.id) as { status: string };
  check('cancelar venda marca ticket como cancelado', afterCancel.status === 'cancelado');

  // ── Correções na comanda: anular item tira da cozinha; cancelar comanda idem;
  // ── Comanda: item NÃO vai automático — a cozinha só recebe no envio EXPLÍCITO do
  //    garçom (enquanto monta o pedido o cliente pode desistir/trocar) ──
  check('liga capability comandas.mesas',
    (await api('/api/core/capabilities/comandas.mesas', { method: 'PUT', body: JSON.stringify({ enabled: true }) }, admin!)).status === 200);

  const comanda = await unwrap<{ id: number }>(await api('/api/comandas/comandas', { method: 'POST', body: JSON.stringify({}) }, admin!));
  const ticketsDaComanda = () =>
    (db.prepare("SELECT COUNT(*) c FROM kitchen_tickets WHERE source_type = 'comanda' AND source_id = ?").get(comanda.id) as { c: number }).c;
  check('lança hamburguer com observação na comanda',
    (await api(`/api/comandas/comandas/${comanda.id}/items`, {
      method: 'POST', body: JSON.stringify({ productId: hamburguer.id, qty: 1, notes: 'sem cebola' }),
    }, admin!)).status === 201);
  check('addItem NÃO cria ticket na hora (só no envio explícito)', ticketsDaComanda() === 0);

  // Anular ANTES do enviar: nenhum ticket existiu, nada para limpar na cozinha
  const comandaItemId1 = (db.prepare('SELECT id FROM comanda_items WHERE comanda_id = ?').all(comanda.id) as { id: number }[])[0].id;
  check('anula item antes do envio',
    (await api(`/api/comandas/comandas/${comanda.id}/items/${comandaItemId1}`, { method: 'DELETE' }, admin!)).status === 200);
  check('anular antes do envio não criou ticket nenhum', ticketsDaComanda() === 0);

  // Lança de novo (agora sem obs) e ENVIA
  await api(`/api/comandas/comandas/${comanda.id}/items`, { method: 'POST', body: JSON.stringify({ productId: hamburguer.id, qty: 2 }) }, admin!);
  const sendR = await unwrap<{ sent: number; estimatedMinutes: number | null }>(await api(`/api/comandas/comandas/${comanda.id}/enviar-cozinha`, { method: 'POST' }, admin!));
  check('enviar-cozinha devolve 1 item enviado', sendR.sent === 1, `sent=${sendR.sent}`);
  check('envio devolve o tempo estimado do roteamento (12 min)', sendR.estimatedMinutes === 12, `min=${sendR.estimatedMinutes}`);
  const comandaTicket = db.prepare("SELECT id, status FROM kitchen_tickets WHERE source_type = 'comanda' AND source_id = ?").get(comanda.id) as { id: number; status: string };
  check('envio explícito gera ticket pendente', !!comandaTicket && comandaTicket.status === 'pendente');
  const kitchenItem = db.prepare('SELECT id, notes, comanda_item_id FROM kitchen_ticket_items WHERE ticket_id = ?').get(comandaTicket.id) as { id: number; notes: string | null; comanda_item_id: number | null };
  check('item do ticket tem vínculo com o item da comanda', kitchenItem.comanda_item_id !== null && kitchenItem.notes === null);

  // Observação editada DEPOIS do envio espelha no item da cozinha enquanto pendente
  const comandaItemId2 = (db.prepare('SELECT id FROM comanda_items WHERE comanda_id = ? ORDER BY id DESC LIMIT 1').get(comanda.id) as { id: number }).id;
  check('edita a observação depois do envio',
    (await api(`/api/comandas/comandas/${comanda.id}/items/${comandaItemId2}/notes`, {
      method: 'PUT', body: JSON.stringify({ notes: 'bem passada' }),
    }, admin!)).status === 200);
  const notesRow = db.prepare('SELECT notes FROM kitchen_ticket_items WHERE id = ?').get(kitchenItem.id) as { notes: string | null };
  check('observação editada espelhou no item da cozinha', notesRow.notes === 'bem passada');

  // Reenvio não duplica (garçom pode apertar de novo sem querer)
  const sendAgain = await unwrap<{ sent: number }>(await api(`/api/comandas/comandas/${comanda.id}/enviar-cozinha`, { method: 'POST' }, admin!));
  check('reenviar não manda item de novo', sendAgain.sent === 0 && ticketsDaComanda() === 1);

  // Anular DEPOIS do envio: item sai do ticket e o ticket vazio é cancelado
  check('anula item da comanda após envio',
    (await api(`/api/comandas/comandas/${comanda.id}/items/${comandaItemId2}`, { method: 'DELETE' }, admin!)).status === 200);
  const ticketAfterVoid = db.prepare('SELECT status FROM kitchen_tickets WHERE id = ?').get(comandaTicket.id) as { status: string };
  check('anular único item cancela o ticket da cozinha', ticketAfterVoid.status === 'cancelado');

  // Comanda cancelada com ticket em aberto → ticket cancelado
  const comanda3 = await unwrap<{ id: number }>(await api('/api/comandas/comandas', { method: 'POST', body: JSON.stringify({}) }, admin!));
  await api(`/api/comandas/comandas/${comanda3.id}/items`, { method: 'POST', body: JSON.stringify({ productId: hamburguer.id, qty: 1 }) }, admin!);
  await api(`/api/comandas/comandas/${comanda3.id}/enviar-cozinha`, { method: 'POST' }, admin!);
  check('cancela a comanda',
    (await api(`/api/comandas/comandas/${comanda3.id}/cancel`, { method: 'POST' }, admin!)).status === 200);
  const ticketComandaCancelada = db.prepare("SELECT status FROM kitchen_tickets WHERE source_type = 'comanda' AND source_id = ?").get(comanda3.id) as { status: string };
  check('cancelar comanda marca ticket como cancelado', ticketComandaCancelada?.status === 'cancelado');

  // Fechar comanda não duplica ticket (itens já foram no "Enviar p/ cozinha")
  const comanda2 = await unwrap<{ id: number }>(await api('/api/comandas/comandas', { method: 'POST', body: JSON.stringify({}) }, admin!));
  await api(`/api/comandas/comandas/${comanda2.id}/items`, { method: 'POST', body: JSON.stringify({ productId: hamburguer.id, qty: 2 }) }, admin!);
  await api(`/api/comandas/comandas/${comanda2.id}/enviar-cozinha`, { method: 'POST' }, admin!);
  const ticketsBeforeClose = (db.prepare('SELECT COUNT(*) c FROM kitchen_tickets').get() as { c: number }).c;
  const pixMethod = db.prepare("SELECT id FROM payment_methods WHERE type = 'pix' AND active = 1 LIMIT 1").get() as { id: number };
  check('fecha a comanda',
    (await api(`/api/comandas/comandas/${comanda2.id}/close`, {
      method: 'POST', body: JSON.stringify({ payments: [{ methodId: pixMethod.id, amountCents: 3600 }] }),
    }, admin!)).status === 200);
  const ticketsAfterClose = (db.prepare('SELECT COUNT(*) c FROM kitchen_tickets').get() as { c: number }).c;
  check('fechar comanda não cria ticket duplicado', ticketsAfterClose === ticketsBeforeClose, `antes=${ticketsBeforeClose} depois=${ticketsAfterClose}`);

  // ── "Pedido pronto" na grade de mesas: ticket 'pronto' da comanda sinaliza a mesa ──
  const gridReadyCount = async (tableId: number): Promise<number> => {
    const rows = await unwrap<{ id: number; kitchen_ready_count?: number }[]>(
      await api('/api/comandas/tables/status', {}, admin!),
    );
    const found = rows.find((r) => r.id === tableId);
    return found?.kitchen_ready_count ?? 0;
  };
  const mesa = await unwrap<{ id: number }>(
    await api('/api/comandas/tables', { method: 'POST', body: JSON.stringify({ label: 'Mesa Grade' }) }, admin!),
  );
  const comandaMesa = await unwrap<{ id: number }>(
    await api('/api/comandas/comandas', { method: 'POST', body: JSON.stringify({ tableId: mesa.id }) }, admin!),
  );
  await api(`/api/comandas/comandas/${comandaMesa.id}/items`, { method: 'POST', body: JSON.stringify({ productId: hamburguer.id, qty: 1 }) }, admin!);
  await api(`/api/comandas/comandas/${comandaMesa.id}/enviar-cozinha`, { method: 'POST' }, admin!);
  const ticketMesa = db.prepare("SELECT id FROM kitchen_tickets WHERE source_type = 'comanda' AND source_id = ?").get(comandaMesa.id) as { id: number };
  check('mesa ainda sem pedido pronto na grade', (await gridReadyCount(mesa.id)) === 0);
  check('cozinha marca o pedido pronto',
    (await api(`/api/foodservice/kitchen/tickets/${ticketMesa.id}/status`, { method: 'PUT', body: JSON.stringify({ status: 'pronto' }) }, admin!)).status === 200);
  check('grade sinaliza a mesa com pedido pronto', (await gridReadyCount(mesa.id)) > 0);
  check('garçom marca como entregue',
    (await api(`/api/foodservice/kitchen/tickets/${ticketMesa.id}/status`, { method: 'PUT', body: JSON.stringify({ status: 'entregue' }) }, admin!)).status === 200);
  check('entregue tira o sinal de pedido pronto da mesa', (await gridReadyCount(mesa.id)) === 0);

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
