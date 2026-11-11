/**
 * Teste de integração do pedido pela mesa via QR.
 *
 * Cobre o que o Cloud não consegue garantir sozinho: o pedido é aplicado como PENDENTE,
 * não vaza para a cozinha antes do garçom confirmar, a reaplicação não duplica itens,
 * a recusa anula a rodada e "viagem" propaga para os adicionais.
 *
 *   node scripts/test-isolated.js src/tests/qr-order.ts
 */
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { migrateUp } from '../core/database/migrator';
import { runSeeds } from '../core/database/seeds';
import { getSqlite, closeDb } from '../core/database/connection';
import { setLicense } from '../core/license/service';
import { impersonate } from '../core/auth/systemContext';
import commercialSetup from '../modules/commercial/setup';
import foodserviceSetup from '../modules/foodservice/setup';
import comandasSetup from '../modules/comandas/setup';
import { applyCommand } from '../core/sync/commands';
import { openComanda, sendToKitchen } from '../modules/comandas/comandas';
import { confirmQrOrders, receiveQrOrder, rejectQrOrders, setItemTakeaway } from '../modules/comandas/qrOrder';
import { publishMenuNow } from '../core/menu/publisher';

let failures = 0;
function check(label: string, ok: boolean, extra = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures++;
}

function assertDiscardable(): void {
  const alvo = process.env.KURUK_DB_PATH;
  if (!alvo) {
    throw new Error('KURUK_DB_PATH não definida. Rode via scripts/test-isolated.js.');
  }
  if (path.resolve(alvo) === path.resolve(process.cwd(), 'database', 'kuruk.db')) {
    throw new Error('Recusado: KURUK_DB_PATH aponta para o banco de dev.');
  }
}

const UUID = {
  company: '11111111-1111-4111-8111-111111111111',
  table: '22222222-2222-4222-8222-222222222222',
  main: '33333333-3333-4333-8333-333333333333',
  bacon: '44444444-4444-4444-8444-444444444444',
  cheese: '55555555-5555-4555-8555-555555555555',
  category: '66666666-6666-4666-8666-666666666666',
  group: '77777777-7777-4777-8777-777777777777',
  order1: '88888888-8888-4888-8888-888888888888',
  order2: '99999999-9999-4999-8999-999999999999',
  order3: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
};

async function main(): Promise<void> {
  assertDiscardable();
  migrateUp();
  runSeeds();
  commercialSetup();
  foodserviceSetup();
  comandasSetup();
  setLicense(UUID.company, 'chave-de-teste', 'diamante', '2099-12-31 23:59:59');

  const db = getSqlite();
  db.prepare(
    `INSERT INTO capabilities (key, description, module, enabled, beta, uuid)
     VALUES ('comandas.pedido_qr', 'teste', 'comandas', 1, 0, 'cap-qr')
     ON CONFLICT(key) DO UPDATE SET enabled = 1`,
  ).run();

  const categoryId = Number(db.prepare(
    "INSERT INTO categories (name, uuid) VALUES ('Lanches', ?)",
  ).run(UUID.category).lastInsertRowid);

  const insertProduct = (uuid: string, name: string, price: number, type: string, visible: number): number =>
    Number(db.prepare(
      `INSERT INTO products (name, category_id, unit, price_cents, cost_cents, track_stock,
         active, visivel_cardapio, product_type, uuid)
       VALUES (?, ?, 'un', ?, 0, 0, 1, ?, ?, ?)`,
    ).run(name, categoryId, price, visible, type, uuid).lastInsertRowid);

  const mainId = insertProduct(UUID.main, 'X-Burger', 2000, 'fisico', 1);
  const baconId = insertProduct(UUID.bacon, 'Bacon', 300, 'complemento', 0);
  const cheeseId = insertProduct(UUID.cheese, 'Queijo', 200, 'complemento', 0);

  const groupId = Number(db.prepare(
    'INSERT INTO complement_groups (name, min_select, max_select, uuid) VALUES (?, 0, 2, ?)',
  ).run('Adicionais', UUID.group).lastInsertRowid);
  db.prepare(
    'INSERT INTO complement_group_items (group_id, product_id, price_override_cents, uuid) VALUES (?, ?, NULL, ?)',
  ).run(groupId, baconId, randomUUID());
  db.prepare(
    'INSERT INTO complement_group_items (group_id, product_id, price_override_cents, uuid) VALUES (?, ?, NULL, ?)',
  ).run(groupId, cheeseId, randomUUID());
  db.prepare(
    'INSERT INTO product_complement_groups (product_id, group_id, uuid) VALUES (?, ?, ?)',
  ).run(mainId, groupId, randomUUID());

  db.prepare(
    "INSERT INTO store_tables (label, status, uuid) VALUES ('Mesa 01', 'livre', ?)",
  ).run(UUID.table);
  const tableId = Number(
    (db.prepare('SELECT id FROM store_tables WHERE uuid = ?').get(UUID.table) as { id: number }).id,
  );

  // Só o principal gera ticket; adicionais vão como texto no item principal.
  db.prepare(
    'INSERT INTO kitchen_routing (product_id, station, estimated_minutes, uuid) VALUES (?, ?, ?, ?)',
  ).run(mainId, 'Chapa', 12, randomUUID());

  const adminId = Number((db.prepare("SELECT id FROM users WHERE username = 'admin'").get() as { id: number }).id);
  const req = impersonate(adminId, 'teste-qr');
  if (!req) throw new Error('admin não encontrado');

  const payload = {
    orderUuid: UUID.order1,
    tableUuid: UUID.table,
    note: 'Trazer tudo junto',
    items: [{
      productUuid: UUID.main,
      qty: 1,
      notes: 'sem cebola',
      takeaway: true,
      unitPriceCents: 2100,
      complements: [{ productUuid: UUID.bacon, qty: 2, unitPriceCents: 350 }],
    }],
  };

  // Sem abrir a mesa, o link do QR não serve nem para quem está em casa: a presença é
  // confirmada pelo atendente ao abrir a comanda. O QR impresso continua o mesmo.
  const semMesaAberta = receiveQrOrder(req, payload);
  check('pedido QR em mesa livre é recusado (exige mesa aberta)', !semMesaAberta.ok,
    semMesaAberta.ok ? '' : semMesaAberta.error);

  const opened = openComanda(req, { tableId });
  check('atendente abre a mesa', opened.ok, opened.ok ? '' : opened.error);
  if (!opened.ok) return;

  const first = receiveQrOrder(req, payload);
  check('pedido QR é aceito com a mesa aberta', first.ok, first.ok ? '' : first.error);
  if (!first.ok) return;
  const comandaId = first.result.comandaId;
  check('pedido reaproveita a comanda aberta pelo atendente', comandaId === opened.id);

  const qrOrder = db.prepare('SELECT id, status FROM qr_orders WHERE order_uuid = ?').get(UUID.order1) as
    { id: number; status: string } | undefined;
  check('rodada nasce pendente', qrOrder?.status === 'pendente');

  const items = db.prepare(
    `SELECT id, product_id, para_viagem, origem FROM comanda_items
      WHERE comanda_id = ? AND deleted_at IS NULL ORDER BY id`,
  ).all(comandaId) as { id: number; product_id: number; para_viagem: number; origem: string }[];
  check('principal + complemento entram na comanda', items.length === 2, `itens=${items.length}`);
  check('todos nascem para viagem', items.every((i) => i.para_viagem === 1));
  check('origem marca cliente_qr', items.every((i) => i.origem === 'cliente_qr'));
  const priced = db.prepare(
    'SELECT product_id, unit_price_cents FROM comanda_items WHERE comanda_id = ? AND deleted_at IS NULL',
  ).all(comandaId) as { product_id: number; unit_price_cents: number }[];
  check('preço exibido no celular é congelado no item',
    priced.find((p) => p.product_id === mainId)?.unit_price_cents === 2100
    && priced.find((p) => p.product_id === baconId)?.unit_price_cents === 350,
    JSON.stringify(priced));
  const comandaRow = db.prepare('SELECT notes FROM comandas WHERE id = ?').get(comandaId) as { notes: string | null };
  check('observação geral vai para a comanda', comandaRow.notes === 'Trazer tudo junto', comandaRow.notes ?? '');
  check('cozinha NÃO recebe antes da confirmação',
    Number((db.prepare('SELECT COUNT(*) AS c FROM kitchen_tickets').get() as { c: number }).c) === 0);

  const again = receiveQrOrder(req, payload);
  check('reaplicar o mesmo pedido é idempotente',
    again.ok && again.result.alreadyApplied === true);
  check('idempotência não duplica itens',
    Number((db.prepare('SELECT COUNT(*) AS c FROM comanda_items WHERE comanda_id = ? AND deleted_at IS NULL').get(comandaId) as { c: number }).c) === 2);

  const blocked = sendToKitchen(req, comandaId, 'local');
  check('botão normal não envia rodada pendente à cozinha',
    blocked.ok && blocked.sent === 0 && Number((db.prepare('SELECT COUNT(*) AS c FROM kitchen_tickets').get() as { c: number }).c) === 0);

  const confirmed = confirmQrOrders(req, comandaId);
  check('garçom confirma a rodada', confirmed.ok, confirmed.ok ? '' : confirmed.error);
  if (confirmed.ok) {
    check('só o principal roteado vai para a cozinha', confirmed.sent === 1, `sent=${confirmed.sent}`);
  }
  const ticket = db.prepare(
    "SELECT id, service_type FROM kitchen_tickets WHERE status <> 'cancelado' ORDER BY id DESC LIMIT 1",
  ).get() as { id: number; service_type: string } | undefined;
  check('ticket marcado como viagem', ticket?.service_type === 'viagem', ticket?.service_type);
  const ticketItem = db.prepare(
    'SELECT para_viagem FROM kitchen_ticket_items WHERE ticket_id = ? AND deleted_at IS NULL LIMIT 1',
  ).get(ticket?.id) as { para_viagem: number } | undefined;
  check('item do ticket carrega para_viagem', ticketItem?.para_viagem === 1);

  // Segunda rodada: recusada pelo garçom (criança brincando, item em falta…).
  const second = receiveQrOrder(req, {
    orderUuid: UUID.order2,
    tableUuid: UUID.table,
    items: [{
      productUuid: UUID.main,
      qty: 1,
      takeaway: false,
      complements: [{ productUuid: UUID.cheese, qty: 1 }],
    }],
  });
  check('segunda rodada é aceita', second.ok, second.ok ? '' : second.error);
  const rejected = rejectQrOrders(req, comandaId, UUID.order2, 'Pedido de teste');
  check('garçom recusa a rodada', rejected.ok);
  const rejectedRow = db.prepare('SELECT status, rejection_reason FROM qr_orders WHERE order_uuid = ?').get(UUID.order2) as
    { status: string; rejection_reason: string } | undefined;
  check('rodada fica como recusada', rejectedRow?.status === 'recusado');
  check('motivo chega ao celular', rejectedRow?.rejection_reason === 'Pedido de teste');
  const activeAfterReject = db.prepare(
    'SELECT COUNT(*) AS c FROM comanda_items WHERE comanda_id = ? AND deleted_at IS NULL AND voided_at IS NULL',
  ).get(comandaId) as { c: number };
  check('itens recusados são anulados', Number(activeAfterReject.c) === 2, `ativos=${activeAfterReject.c}`);

  // Viagem por item: desmarca o grupo inteiro (principal + bacon).
  const mainItem = items.find((i) => i.product_id === mainId);
  if (mainItem) {
    const toggled = setItemTakeaway(req, comandaId, mainItem.id, false);
    check('garçom consegue voltar o grupo para o local', toggled.ok);
    const flags = db.prepare(
      'SELECT para_viagem FROM comanda_items WHERE comanda_id = ? AND qr_order_id = ? AND deleted_at IS NULL',
    ).all(comandaId, qrOrder!.id) as { para_viagem: number }[];
    check('flag de viagem propaga para o grupo', flags.every((f) => f.para_viagem === 0));
  }

  // Caminho real do Cloud: core/sync/commands -> serviço comandas.qr -> comanda.
  // O teste não roda o loader de módulos (que concede as permissões do módulo ao admin
  // no boot); concede aqui a única permissão que o ator do pedido precisa.
  db.prepare(
    `INSERT OR IGNORE INTO role_permissions (role_id, permission_key)
     SELECT role_id, 'comandas.manage' FROM users WHERE username = 'admin'`,
  ).run();
  const viaCommand = applyCommand({
    id: 1,
    kind: 'comandas.qr.order',
    created_by_user_uuid: null,
    payload: {
      orderUuid: UUID.order3,
      tableUuid: UUID.table,
      items: [{ productUuid: UUID.main, qty: 1, takeaway: false }],
    },
  });
  check('comando do Cloud aplica pelo serviço do módulo', viaCommand.ok, viaCommand.ok ? '' : viaCommand.error);
  if (viaCommand.ok) {
    check('comando reaproveita a comanda da mesa',
      Number((viaCommand.result as { comandaId?: number }).comandaId) === comandaId);
  }

  // ─── Publicação do menu (Trial não tem sync; o QR usa esta rota) ────────────
  process.env.KURUK_SYNC_SERVER_URL = 'https://kuruk.exemplo.test';
  interface PublishBody {
    enabled?: boolean;
    items?: {
      productUuid: string; priceCents: number; imageId: number | null;
      complements?: { name: string; options: { name: string; priceCents: number }[] }[];
    }[];
  }
  let published: unknown = null;
  const originalFetch = global.fetch;
  (global as unknown as { fetch: typeof fetch }).fetch = (async (_url: string, init?: RequestInit) => {
    published = JSON.parse(String(init?.body ?? '{}'));
    return { ok: true, status: 200, json: async () => ({ ok: true }) } as Response;
  }) as typeof fetch;
  try {
    const okPublish = await publishMenuNow(true);
    check('publicação do menu usa a rota própria', okPublish === true);
    const body = published as PublishBody;
    check('snapshot sai habilitado', body?.enabled === true);
    const burger = body?.items?.find((i) => i.productUuid === UUID.main);
    check('produto publicado com preço efetivo', burger?.priceCents === 2000, String(burger?.priceCents));
    check('complementos vão no snapshot', (burger?.complements?.length ?? 0) === 1);
    check('opções de complemento com preço',
      burger?.complements?.[0]?.options?.some((o) => o.name === 'Bacon' && o.priceCents === 300) === true);

    db.prepare("UPDATE capabilities SET enabled = 0 WHERE key = 'comandas.pedido_qr'").run();
    published = null;
    await publishMenuNow(true);
    check('desligar o recurso tira a página do ar', (published as PublishBody | null)?.enabled === false);
  } finally {
    global.fetch = originalFetch;
  }

  console.log(failures === 0 ? '\nPedido por QR: TODOS OS TESTES PASSARAM' : `\n${failures} falha(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => {
    closeDb();
  });
