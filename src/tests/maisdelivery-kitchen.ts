/**
 * Teste da ponte cozinha ⇆ Mais Delivery (módulo maisdelivery).
 *
 * Cobre, sem falar com a API real:
 *  - heurísticas puras (escolha de situação, cancelamento, montagem de itens);
 *  - "Enviar p/ cozinha": cria ticket source_type='delivery' no KDS, idempotente;
 *  - sincronia de ida: situação "Em preparo" lá no marketplace;
 *  - sincronia de volta: cozinha marca "pronto" no KDS → situação do marketplace;
 *  - cancelamento do pedido no marketplace derruba o ticket da cozinha.
 *
 * KIVO_DB_PATH TEM que vir do ambiente:
 *   node scripts/test-isolated.js src/tests/maisdelivery-kitchen.ts
 */
import fs from 'node:fs';
import path from 'node:path';

import { migrateUp } from '../core/database/migrator';
import { runSeeds } from '../core/database/seeds';
import { createServer } from '../core/server';
import { getSqlite } from '../core/database/connection';
import { activateTestLicense } from './resetTestDb';
import { unwrap } from './testUtils';
import { saveMaisDeliveryConfig } from '../modules/maisdelivery/settings';
import {
  buildKitchenItems,
  chooseSituation,
  isCancelSituation,
} from '../modules/maisdelivery/kitchenBridge';
import type { StatusOption } from '../modules/maisdelivery/client';

const PORT = Number(process.env.KIVO_PORT ?? 3895);
const base = `http://localhost:${PORT}`;
let failures = 0;

function check(label: string, ok: boolean, extra = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures++;
}

let cookie = '';
async function api(p: string, opts: RequestInit = {}): Promise<Response> {
  return fetch(`${base}${p}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { cookie } : {}),
      ...(opts.headers ?? {}),
    },
  });
}

interface MockRequest {
  body: Record<string, unknown>;
}

const originalFetch = globalThis.fetch;
let lastRequest: MockRequest | null = null;

function mockApi(
  handler: (body: Record<string, unknown>) => { status?: number; json: unknown },
): void {
  globalThis.fetch = (async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (!url.startsWith('https://maisdeliveryapp.com.br/')) {
      return originalFetch(input, init);
    }
    const rawBody = typeof init?.body === 'string' ? init.body : '{}';
    const body = JSON.parse(rawBody) as Record<string, unknown>;
    lastRequest = { body };
    const result = handler(body);
    return new Response(JSON.stringify(result.json), {
      status: result.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
}

/** Espera (sem travar) até a requisição do marketplace casar com o predicado. */
async function waitForRequest(
  predicate: (body: Record<string, unknown>) => boolean,
  ms = 4000,
): Promise<MockRequest | null> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (lastRequest && predicate(lastRequest.body)) return lastRequest;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return null;
}

function detailSample(): unknown {
  return {
    success: true,
    data: {
      pedido: {
        idPedido: 987,
        dsNome: 'Maria Teste',
        dsEndereco: 'Rua A, 100 - Centro',
        vlTotal: '110,00',
        dsSituacao: 'Pendente',
        idSituacao: 1,
        dtPedido: '28/10/2026 12:30:00',
        dsOrigem: 'App',
        dsRestaurante: 'Loja Teste',
        tipoEntrega: 'Entrega',
        itens: [
          { dsNome: 'Pizza', qtde: '1', vlItem: '60,00', vlTotal: '60,00' },
          { dsNome: 'Refrigerante', qtde: '2,5', vlItem: '20,00', vlTotal: '50,00' },
        ],
      },
    },
  };
}

const SITUACOES_SAMPLE: unknown = {
  success: true,
  data: {
    situacoes: [
      { idSituacao: 1, dsSituacao: 'Pendente' },
      { idSituacao: 2, dsSituacao: 'Cancelado' },
      { idSituacao: 3, dsSituacao: 'Em preparo' },
      { idSituacao: 4, dsSituacao: 'Pedido pronto' },
    ],
  },
};

function marketplaceHandler(body: Record<string, unknown>): { json: unknown } {
  const op = Number(body.nrOperacao);
  if (op === 12) return { json: detailSample() };
  if (op === 7) return { json: SITUACOES_SAMPLE };
  if (op === 3) return { json: { success: true } };
  if (op === 14 || op === 2) {
    return { json: { success: true, data: { pedidos: [{ idPedido: 987 }] } } };
  }
  return { json: { success: true } };
}

function assertBancoDescartavel(): string {
  const target = process.env.KIVO_DB_PATH;
  if (!target) {
    throw new Error(
      'KIVO_DB_PATH não definida. Este teste APAGA o banco que usar — rode via ' +
        '`node scripts/test-isolated.js src/tests/maisdelivery-kitchen.ts`.',
    );
  }
  if (path.resolve(target) === path.resolve(process.cwd(), 'database', 'kivo.db')) {
    throw new Error('Recusado: KIVO_DB_PATH aponta para o banco de dev.');
  }
  return target;
}

async function main(): Promise<void> {
  const TMP_DB = assertBancoDescartavel();
  fs.mkdirSync(path.dirname(TMP_DB), { recursive: true });
  fs.rmSync(TMP_DB, { force: true });

  // ── Heurísticas puras (não precisam de servidor) ──
  const statuses: StatusOption[] = [
    { id: '1', name: 'Pendente', raw: null },
    { id: '2', name: 'Cancelado', raw: null },
    { id: '3', name: 'Em preparo', raw: null },
    { id: '4', name: 'Pedido pronto', raw: null },
  ];
  const preparo = chooseSituation(statuses, 'preparo');
  check('heurística: preparo', preparo?.id === '3');
  const pronto = chooseSituation(statuses, 'pronto');
  check('heurística: pronto', pronto?.id === '4');
  check(
    'heurística: exclui situação atual',
    chooseSituation(statuses, 'preparo', ['3'])?.id === undefined,
  );
  check('heurística: cancelado', isCancelSituation('Cancelado pelo cliente'));
  check('heurística: não cancelado', !isCancelSituation('Em preparo'));

  const grouped = buildKitchenItems([
    { name: 'Pizza', qty: '1', notes: 'sem cebola', unitCents: null, totalCents: null, raw: null },
    { name: 'Pizza', qty: '1', notes: 'sem cebola', unitCents: null, totalCents: null, raw: null },
    { name: ' Reagrupado ', qty: '2.000', notes: '', unitCents: null, totalCents: null, raw: null },
    { name: 'Vazio', qty: '0', notes: '', unitCents: null, totalCents: null, raw: null },
  ]);
  check(
    'itens: agrupa iguais, milhar e ignora qty 0',
    grouped.length === 2 &&
      grouped[0].qty === 2 &&
      grouped[0].notes === 'sem cebola' &&
      grouped[1].qty === 2 &&
      grouped[1].name === 'Reagrupado',
  );

  // ── Servidor ──
  migrateUp();
  runSeeds();
  activateTestLicense();
  const { app } = await createServer();
  const server = app.listen(PORT);

  try {
    const login = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'admin', password: 'admin' }),
    });
    const match = (login.headers.get('set-cookie') ?? '').match(/kivo_session=([^;]+)/);
    cookie = match ? `kivo_session=${match[1]}` : '';
    check('login admin', cookie !== '');
    if (!cookie) return;

    check(
      'liga capability foodservice.cozinha',
      (await api('/api/core/capabilities/foodservice.cozinha', {
        method: 'PUT',
        body: JSON.stringify({ enabled: true }),
      })).status === 200,
    );

    saveMaisDeliveryConfig({ empresaIntegrada: 123, restaurante: 456, marketplace: null, sandbox: true });

    mockApi(marketplaceHandler);

    // ── Enviar p/ cozinha ──
    const send = await api('/api/maisdelivery/orders/987/enviar-cozinha', { method: 'POST' });
    const sendBody = await unwrap<{
      sent: boolean;
      alreadyInKitchen: boolean;
      ticketItems: number;
      statusChanged: boolean;
      statusName: string | null;
    }>(send);
    check('enviar p/ cozinha responde', send.status === 200, `status=${send.status}`);
    check('enviar: sent=true', sendBody.sent === true);
    check('enviar: 2 itens (do pedido, agrupados)', sendBody.ticketItems === 2, `itens=${sendBody.ticketItems}`);
    check('enviar: situação "Em preparo" aplicada', sendBody.statusChanged === true && sendBody.statusName === 'Em preparo');
    const preparoRequest = await waitForRequest(
      (body) => Number(body.nrOperacao) === 3 && Number(body.idPedido) === 987,
    );
    check(
      'enviar: operação 3 com idSituacao 3',
      Boolean(preparoRequest) &&
        Number(preparoRequest?.body.idSituacao) === 3 &&
        preparoRequest?.body.dsMotivo !== undefined,
    );

    // Ticket no KDS: source_type delivery, itens textuais (sem produto do catálogo).
    const rows = getSqlite()
      .prepare(
        `SELECT kt.id, kt.table_label, kt.service_type, kt.status AS ticket_status, it.product_id, it.product_name, it.qty
           FROM kitchen_tickets kt JOIN kitchen_ticket_items it ON it.ticket_id = kt.id
          WHERE kt.source_type = 'delivery' AND kt.source_id = 987 AND kt.deleted_at IS NULL`,
      )
      .all() as { id: number; table_label: string | null; service_type: string; ticket_status: string; product_id: number | null; product_name: string; qty: number }[];
    const ticket = rows.find(
      (row) => row.ticket_status === 'pendente' && row.product_name === 'Pizza',
    );
    check(
      'ticket de delivery criado no KDS',
      Boolean(ticket) &&
        (ticket?.table_label ?? '').startsWith('Mais Delivery') &&
        ticket?.service_type === 'entrega' &&
        ticket?.product_id === null,
    );
    check(
      'itens textuais do marketplace no ticket',
      rows.some((row) => row.product_name === 'Pizza' && row.qty === 1) &&
        rows.some((row) => row.product_name === 'Refrigerante' && row.qty === 2.5),
    );

    // Idempotência: segundo clique não re-envia.
    const resend = await api('/api/maisdelivery/orders/987/enviar-cozinha', { method: 'POST' });
    const resendBody = await unwrap<{ alreadyInKitchen: boolean }>(resend);
    check('re-envio é recusado (idempotente)', resendBody.alreadyInKitchen === true);

    // Flag de hidratação da listagem.
    const details = await api('/api/maisdelivery/orders/details', {
      method: 'POST',
      body: JSON.stringify({ ids: [987] }),
    });
    const detailsBody = await unwrap<{ orders: { sentToKitchen?: boolean }[]; failed: unknown[] }>(
      details,
    );
    check(
      'hidratação marca sentToKitchen',
      detailsBody.orders?.[0]?.sentToKitchen === true,
      JSON.stringify(detailsBody).slice(0, 200),
    );

    // ── Pedido de teste (sandbox): ticket real na cozinha, sem marketplace ──
    lastRequest = null;
    const testOrder = await api('/api/maisdelivery/test-order', { method: 'POST' });
    const testBody = await unwrap<{
      orderId: string;
      customer: string;
      deliveryType: string;
      itemCount: number;
      totalCents: number;
    }>(testOrder);
    check('pedido de teste responde', testOrder.status === 200, `status=${testOrder.status}`);
    check(
      'pedido de teste: id negativo e rótulo TESTE',
      Boolean(testBody) && Number(testBody.orderId) < 0 && testBody.customer === 'PEDIDO TESTE',
    );
    check(
      'pedido de teste: itens e total coerentes',
      testBody.itemCount === 3 && testBody.totalCents > 0,
      `itens=${testBody.itemCount} total=${testBody.totalCents}`,
    );
    const testTicket = getSqlite()
      .prepare(
        `SELECT kt.id, kt.table_label, kt.status
           FROM kitchen_tickets kt
          WHERE kt.source_type = 'delivery' AND kt.source_id = ? AND kt.deleted_at IS NULL`,
      )
      .get(Number(testBody.orderId)) as { id: number; table_label: string | null; status: string } | undefined;
    check(
      'ticket de teste existe no KDS',
      Boolean(testTicket) && (testTicket?.table_label ?? '').startsWith('TESTE') && testTicket?.status === 'pendente',
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    /* Função, não const: o TS estreita `lastRequest` para `null` logo após `lastRequest = null`
       e acusaria `never` no acesso — dentro de função o narrowing some. */
    const sawStatusCall = (): boolean =>
      lastRequest !== null && Number(lastRequest.body.nrOperacao) === 3;
    check('pedido de teste NÃO conversa com o marketplace', !sawStatusCall());

    // ── Volta: cozinha marca "pronto" → marketplace ──
    lastRequest = null;
    const ticketId = ticket?.id ?? 0;
    const advance = await api(`/api/foodservice/kitchen/tickets/${ticketId}/status`, {
      method: 'PUT',
      body: JSON.stringify({ status: 'pronto' }),
    });
    check('KDS avança para pronto', advance.status === 204 || advance.status === 200, `status=${advance.status}`);
    const prontoRequest = await waitForRequest(
      (body) => Number(body.nrOperacao) === 3 && Number(body.idPedido) === 987,
    );
    check(
      'cozinha "pronto" vira situação no marketplace',
      Boolean(prontoRequest) && Number(prontoRequest?.body.idSituacao) === 4,
    );

    // ── Cancelamento no marketplace derruba o ticket ──
    lastRequest = null;
    const cancel = await api('/api/maisdelivery/orders/987/status', {
      method: 'POST',
      body: JSON.stringify({ statusId: 2, reason: 'recusado pelo estabelecimento' }),
    });
    check('cancelamento responde', cancel.status === 200, `status=${cancel.status}`);
    const canceled = getSqlite()
      .prepare(
        `SELECT status FROM kitchen_tickets WHERE source_type = 'delivery' AND source_id = 987`,
      )
      .all() as { status: string }[];
    check('ticket de cozinha cancelado', canceled.every((row) => row.status === 'cancelado'));
  } finally {
    server.close();
    globalThis.fetch = originalFetch;
  }

  console.log(failures === 0 ? 'Ponte cozinha Mais Delivery: TODOS OS TESTES PASSARAM' : `${failures} falha(s)`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
