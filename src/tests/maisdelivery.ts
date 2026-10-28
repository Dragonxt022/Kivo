/**
 * Teste da integração Mais Delivery (módulo maisdelivery).
 *
 * Cobre o que dá para testar sem falar com a API real: configuração mascarada,
 * gravação dos segredos no cofre, páginas, montagem do corpo das operações,
 * normalização das respostas (inclusive envelope) e tratamento de erro HTTP.
 *
 * KIVO_DB_PATH TEM que vir do ambiente:
 *   node scripts/test-isolated.js src/tests/maisdelivery.ts
 */
import fs from 'node:fs';
import path from 'node:path';

import { migrateUp } from '../core/database/migrator';
import { runSeeds } from '../core/database/seeds';
import { createServer } from '../core/server';
import { closeDb } from '../core/database/connection';
import { activateTestLicense } from './resetTestDb';
import { unwrap } from './testUtils';
import { deleteSecret, getSecret } from '../core/secrets/service';
import {
  changeOrderStatus,
  fetchEstablishment,
  fetchOrder,
  fetchOrders,
  fetchPaymentMethods,
  fetchStatuses,
  MaisDeliveryError,
  parseMoneyToCents,
} from '../modules/maisdelivery/client';
import { saveMaisDeliveryConfig } from '../modules/maisdelivery/settings';

const PORT = Number(process.env.KIVO_PORT ?? 3893);
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

function assertBancoDescartavel(): string {
  const target = process.env.KIVO_DB_PATH;
  if (!target) {
    throw new Error(
      'KIVO_DB_PATH não definida. Este teste APAGA o banco que usar — rode via ' +
        '`node scripts/test-isolated.js src/tests/maisdelivery.ts`.',
    );
  }
  if (path.resolve(target) === path.resolve(process.cwd(), 'database', 'kivo.db')) {
    throw new Error('Recusado: KIVO_DB_PATH aponta para o banco de dev.');
  }
  return target;
}

interface MockRequest {
  url: string;
  body: Record<string, unknown>;
  headers: Headers;
}

const originalFetch = globalThis.fetch;
let lastRequest: MockRequest | null = null;

/**
 * Substitui apenas a chamada externa ao Mais Delivery. As requisições HTTP do teste para
 * o servidor local continuam usando o fetch original — sem isso, `api()` também seria
 * interceptado e nenhuma rota do Kivo poderia ser exercitada depois do mock.
 */
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
    lastRequest = {
      url,
      body,
      headers: new Headers(init?.headers),
    };
    const result = handler(body);
    return new Response(JSON.stringify(result.json), {
      status: result.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
}

function orderSample(): unknown {
  return {
    success: true,
    data: {
      pedidos: [
        {
          idPedido: 987,
          dsNome: 'Maria Teste',
          nrDDD: '99',
          nrTelefone: '999999999',
          dsRua: 'Rua A',
          nrRua: '100',
          dsBairro: 'Centro',
          vlPedido: '100,00',
          dsSituacao: 'Em preparo',
          idSituacao: 5,
          dsPagamento: 'Pix',
          dtPedido: '2026-10-28 12:30:00',
          itens: [
            { dsNome: 'Pizza', qtde: '1', vlItem: '60,00', vlTotal: '60,00' },
            { dsNome: 'Refrigerante', qtde: '2', vlItem: '20,00', vlTotal: '40,00' },
          ],
        },
      ],
    },
  };
}

async function main(): Promise<void> {
  const TMP_DB = assertBancoDescartavel();
  fs.mkdirSync(path.dirname(TMP_DB), { recursive: true });
  fs.rmSync(TMP_DB, { force: true });

  // O cofre fica em `storage/` (fora do banco) e o caminho deriva de KIVO_DB_PATH; nos
  // testes isolados ele cai no temp compartilhado. Limpa as chaves desta integração para
  // a execução não herdar credenciais de uma rodada anterior.
  deleteSecret('maisdelivery.access_token');
  deleteSecret('maisdelivery.basic_auth');

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

    // ── Estado inicial: nada configurado, mas páginas acessíveis ──
    const settingsR = await api('/api/maisdelivery/settings');
    const initial = await unwrap<{
      sandbox: boolean;
      hasAccessToken: boolean;
      hasBasicAuth: boolean;
    }>(settingsR);
    check('settings iniciais respondem', settingsR.status === 200);
    check('sandbox nasce ligado', initial.sandbox === true);
    check(
      'sem credenciais no primeiro boot',
      initial.hasAccessToken === false && initial.hasBasicAuth === false,
    );

    const configPage = await api('/app/maisdelivery/configuracoes');
    const configHtml = await configPage.text();
    check(
      'página de configuração responde',
      configPage.status === 200,
      `status=${configPage.status}`,
    );
    check('página usa a logo oficial', configHtml.includes('/img/maisdelivery.png'));

    const ordersPageBefore = await api('/app/maisdelivery/pedidos');
    const ordersHtmlBefore = await ordersPageBefore.text();
    check(
      'página de pedidos responde',
      ordersPageBefore.status === 200,
      `status=${ordersPageBefore.status}`,
    );
    check(
      'pedidos avisa que falta configurar',
      ordersHtmlBefore.includes('maisdeliveryOrdersPage(false'),
    );
    check('página de pedidos tem o título', ordersHtmlBefore.includes('Pedidos Mais Delivery'));

    // ── Salvar configuração: IDs + segredos ──
    const putR = await api('/api/maisdelivery/settings', {
      method: 'PUT',
      body: JSON.stringify({
        empresaIntegrada: 123,
        restaurante: 456,
        marketplace: 789,
        sandbox: true,
        accessToken: 'token-de-teste-nao-real',
        basicAuth: 'Basic dXNlcjpwYXNz',
      }),
    });
    const saved = await unwrap<{
      empresaIntegrada: number;
      restaurante: number;
      marketplace: number;
      sandbox: boolean;
      hasAccessToken: boolean;
      hasBasicAuth: boolean;
    }>(putR);
    check('salvar configuração responde', putR.status === 200, `status=${putR.status}`);
    check(
      'IDs salvos',
      saved.empresaIntegrada === 123 && saved.restaurante === 456 && saved.marketplace === 789,
    );
    check(
      'credenciais marcadas como salvas',
      saved.hasAccessToken === true && saved.hasBasicAuth === true,
    );

    const settingsText = await (await api('/api/maisdelivery/settings')).text();
    check('API não devolve o token', !settingsText.includes('token-de-teste-nao-real'));
    check('API não devolve o Basic Auth', !settingsText.includes('dXNlcjpwYXNz'));
    check(
      'token foi para o cofre',
      getSecret('maisdelivery.access_token') === 'token-de-teste-nao-real',
    );
    check(
      'Basic Auth foi para o cofre',
      getSecret('maisdelivery.basic_auth') === 'Basic dXNlcjpwYXNz',
    );

    const invalidR = await api('/api/maisdelivery/settings', {
      method: 'PUT',
      body: JSON.stringify({ empresaIntegrada: -5 }),
    });
    check('ID inválido é recusado', invalidR.status === 400, `status=${invalidR.status}`);

    const ordersPageAfter = await api('/app/maisdelivery/pedidos');
    const ordersHtmlAfter = await ordersPageAfter.text();
    check(
      'pedidos reconhece a configuração',
      ordersHtmlAfter.includes('maisdeliveryOrdersPage(true'),
    );

    // ── Operações: corpo enviado e normalização da resposta ──
    mockApi(() => ({ json: orderSample() }));
    const listResult = await fetchOrders({ from: '2026-10-22', to: '2026-10-28' });
    check(
      'listagem feita no endpoint oficial',
      lastRequest?.url.includes('operacao_oapi_v2_publica.php') === true,
    );
    check('operação 2 (com restaurante)', lastRequest?.body.nrOperacao === 2);
    check('sandBox enviado como true', lastRequest?.body.sandBox === true);
    check('idEmpresaIntegrada enviado', lastRequest?.body.idEmpresaIntegrada === 123);
    check('idRestaurante enviado', lastRequest?.body.idRestaurante === 456);
    check(
      'datas no formato da API',
      lastRequest?.body.dtInicio === '2026-10-22 00:00:00' &&
        lastRequest?.body.dtFim === '2026-10-28 23:59:59',
    );
    check(
      'headers de autenticação',
      lastRequest?.headers.get('Accesstoken') === 'token-de-teste-nao-real' &&
        lastRequest?.headers.get('authorization') === 'Basic dXNlcjpwYXNz',
    );
    check(
      'pedido normalizado',
      listResult.orders.length === 1 && listResult.orders[0].id === '987',
    );
    check(
      'cliente e telefone normalizados',
      listResult.orders[0].customer === 'Maria Teste' &&
        listResult.orders[0].phone === '(99) 99999-9999',
    );
    check('total em centavos', listResult.orders[0].totalCents === 10000);
    check(
      'situação e pagamento',
      listResult.orders[0].status === 'Em preparo' && listResult.orders[0].payment === 'Pix',
    );
    check(
      'itens normalizados',
      listResult.orders[0].items.length === 2 &&
        listResult.orders[0].items[1].name === 'Refrigerante' &&
        listResult.orders[0].items[1].totalCents === 4000,
    );
    check(
      'endereço montado',
      listResult.orders[0].address.includes('Rua A, 100') &&
        listResult.orders[0].address.includes('Centro'),
    );

    mockApi(() => ({
      json: {
        success: true,
        data: {
          pedido: {
            idPedido: 987,
            dsNome: 'Maria Teste',
            vlPedido: '100,00',
            dsSituacao: 'Em preparo',
            idSituacao: 5,
            itens: [{ dsNome: 'Pizza', qtde: '1', vlItem: '60,00', vlTotal: '60,00' }],
          },
        },
      },
    }));
    const detailResult = await fetchOrder(987);
    check(
      'detalhe usa operação 12',
      lastRequest?.body.nrOperacao === 12 && lastRequest?.body.idPedido === 987,
    );
    check(
      'detalhe normalizado',
      detailResult.order.id === '987' && detailResult.order.items.length === 1,
    );

    mockApi(() => ({ json: { success: true } }));
    await changeOrderStatus(987, 5, 'teste');
    check('alteração usa operação 3', lastRequest?.body.nrOperacao === 3);
    check(
      'alteração envia pedido, situação e motivo',
      lastRequest?.body.idPedido === 987 &&
        lastRequest?.body.idSituacao === 5 &&
        lastRequest?.body.dsMotivo === 'teste',
    );

    mockApi(() => ({
      json: { success: true, data: { situacoes: [{ idSituacao: 5, dsSituacao: 'Em preparo' }] } },
    }));
    const statuses = await fetchStatuses();
    check(
      'situações normalizadas',
      statuses.statuses.length === 1 &&
        statuses.statuses[0].id === '5' &&
        statuses.statuses[0].name === 'Em preparo',
    );

    mockApi(() => ({
      json: { data: { formasPagamento: [{ idPagamento: 65, dsPagamento: 'Pix' }] } },
    }));
    const payments = await fetchPaymentMethods();
    check(
      'formas de pagamento normalizadas',
      payments.methods.length === 1 &&
        payments.methods[0].id === '65' &&
        payments.methods[0].name === 'Pix',
    );

    mockApi(() => ({
      json: { data: { estabelecimento: { dsNome: 'Loja Teste', nrCNPJ: '11222333000181' } } },
    }));
    const establishment = await fetchEstablishment();
    check(
      'estabelecimento normalizado',
      establishment.establishment.name === 'Loja Teste' &&
        establishment.establishment.document === '11222333000181',
    );

    // ── Rotas HTTP: permissão, validação de período e corpo das ações ──
    mockApi(() => ({ json: orderSample() }));
    const routeList = await api('/api/maisdelivery/orders?from=2026-10-22&to=2026-10-28&status=5');
    const routeListBody = await unwrap<{
      orders: Array<{ id: string; raw?: unknown }>;
      range: { from: string; to: string };
    }>(routeList);
    check('rota de pedidos responde', routeList.status === 200, `status=${routeList.status}`);
    check('rota normaliza o pedido', routeListBody.orders[0]?.id === '987');
    check('rota ecoa o período usado', routeListBody.range.from === '2026-10-22');
    check('listagem HTTP não expõe raw por pedido', routeListBody.orders[0]?.raw === undefined);
    check(
      'rota repassa o filtro de situação',
      Array.isArray(lastRequest?.body.idSituacao) &&
        (lastRequest?.body.idSituacao as unknown[])[0] === 5,
    );

    const invertedRange = await api('/api/maisdelivery/orders?from=2026-10-28&to=2026-10-01');
    const invertedBody = (await invertedRange.json()) as { error?: string };
    check('período invertido é recusado', invertedRange.status === 400);
    check(
      'período invertido explica o motivo',
      (invertedBody.error ?? '').includes('data inicial'),
      invertedBody.error ?? '',
    );

    mockApi(() => ({
      json: {
        success: true,
        data: {
          pedido: { idPedido: 987, dsNome: 'Maria Teste', itens: [] },
        },
      },
    }));
    const routeDetail = await api('/api/maisdelivery/orders/987');
    const routeDetailBody = await unwrap<{ order: { id: string } }>(routeDetail);
    check('rota de detalhe responde', routeDetail.status === 200);
    check('rota de detalhe normaliza o pedido', routeDetailBody.order.id === '987');

    mockApi(() => ({ json: { success: true } }));
    const routeStatus = await api('/api/maisdelivery/orders/987/status', {
      method: 'POST',
      body: JSON.stringify({ statusId: 5, reason: 'teste da rota' }),
    });
    check('rota de alteração responde', routeStatus.status === 200, `status=${routeStatus.status}`);
    check(
      'rota de alteração envia operação 3',
      lastRequest?.body.nrOperacao === 3 &&
        lastRequest?.body.idPedido === 987 &&
        lastRequest?.body.idSituacao === 5 &&
        lastRequest?.body.dsMotivo === 'teste da rota',
    );

    // Sem restaurante, a listagem precisa cair na operação 14 (idMarketplace).
    saveMaisDeliveryConfig({ restaurante: null, marketplace: 789 });
    mockApi(() => ({ json: { success: true, data: { pedidos: [] } } }));
    await fetchOrders({ from: '2026-10-22', to: '2026-10-28', statusIds: [5] });
    check('sem restaurante usa operação 14', lastRequest?.body.nrOperacao === 14);
    check('operação 14 envia marketplace', lastRequest?.body.idMarketplace === 789);
    check('operação 14 não envia restaurante', lastRequest?.body.idRestaurante === undefined);
    check(
      'filtro de situação enviado',
      Array.isArray(lastRequest?.body.idSituacao) &&
        (lastRequest?.body.idSituacao as unknown[])[0] === 5,
    );

    // ── Erro HTTP da API vira mensagem para a tela ──
    mockApi(() => ({ status: 401, json: { mensagem: 'Token inválido' } }));
    let apiError: unknown = null;
    try {
      await fetchOrders({ from: '2026-10-22', to: '2026-10-28' });
    } catch (error) {
      apiError = error;
    }
    check(
      'erro da API é propagado',
      apiError instanceof MaisDeliveryError && apiError.message === 'Token inválido',
    );
    check(
      'erro de auth não vira 401 do Kivo',
      apiError instanceof MaisDeliveryError && apiError.statusCode === 400,
    );

    check('dinheiro: vírgula', parseMoneyToCents('100,00') === 10000);
    check('dinheiro: milhar', parseMoneyToCents('1.234,56') === 123456);
    check('dinheiro: número', parseMoneyToCents(100) === 10000);
    check('dinheiro: ponto decimal', parseMoneyToCents('R$ 10.50') === 1050);
  } finally {
    globalThis.fetch = originalFetch;
    server.close();
    closeDb();
  }

  console.log(
    failures === 0
      ? '\nIntegração Mais Delivery: TODOS OS TESTES PASSARAM'
      : `\n${failures} falha(s)`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
