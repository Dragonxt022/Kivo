/**
 * QA E2E (Playwright) — tipo do pedido no painel da cozinha.
 *
 * O que protege: a cozinha precisa bater o olho e saber se o pedido é para consumir no
 * local (prato/garfo) ou entrega (motinha). O tipo nasce no PDV, viaja no corpo do
 * "Enviar para cozinha" e fica gravado no ticket; a comanda de mesa continua local.
 *
 * Uso:
 *   node scripts/test-isolated.js src/tests/e2e/cozinha-tipo-pedido.ts
 */
import type { Browser } from 'playwright';
import {
  Reporter,
  setupServer,
  openBrowser,
  newPage,
  loginUi,
  loginApi,
  api,
  teardown,
  type E2EServer,
} from './harness';

const PORT = Number(process.env.KIVO_PORT ?? 3618);

interface Ticket {
  id: number;
  source_type: string;
  source_id: number;
  service_type: string;
  items: { id: number; product_name: string }[];
}

async function main(): Promise<void> {
  const reporter = new Reporter('Cozinha — tipo do pedido');
  let server: E2EServer | undefined;
  let browser: Browser | undefined;

  try {
    server = await setupServer({
      port: PORT,
      capabilities: [
        { key: 'comandas.mesas', module: 'comandas' },
        { key: 'foodservice.cozinha', module: 'foodservice' },
      ],
    });
    const base = server.base;
    const cookie = await loginApi(base);
    if (!cookie) throw new Error('login via API falhou');

    const call = async <T = unknown>(method: string, route: string, body?: unknown): Promise<T> => {
      const r = await api(base, route, {
        method,
        ...(body ? { body: JSON.stringify(body) } : {}),
      }, cookie);
      if (!r.ok) throw new Error(`${method} ${route} ${r.status}: ${await r.text()}`);
      const j = (await r.json()) as { data?: T };
      return (j.data ?? j) as T;
    };

    const produto = await call<{ id: number; name: string }>('POST', '/api/commercial/products', {
      name: 'Combo Tipo do Pedido',
      priceCents: 2600,
    });
    await call('POST', '/api/foodservice/kitchen-routing', { productId: produto.id, station: 'Cozinha' });

    // ─── Ticket de ENTREGA (PDV) ───────────────────────────────────────────
    const draftId = 800000 + Math.floor(Math.random() * 100000);
    await call('POST', '/api/store/kitchen/send', {
      draftId,
      serviceType: 'entrega',
      items: [{ productId: produto.id, name: produto.name, qty: 1, notes: 'embalar para viagem' }],
    });

    // ─── Ticket LOCAL (comanda de mesa) ────────────────────────────────────
    const mesa = await call<{ id: number }>('POST', '/api/comandas/tables', { label: 'Mesa 01' });
    const comanda = await call<{ id: number }>('POST', '/api/comandas/comandas', { tableId: mesa.id });
    await call('POST', `/api/comandas/comandas/${comanda.id}/items`, { productId: produto.id, qty: 2 });
    await call('POST', `/api/comandas/comandas/${comanda.id}/enviar-cozinha`);

    const tickets = await call<Ticket[]>('GET', '/api/foodservice/kitchen/tickets');
    const entrega = tickets.find((t) => t.source_id === -Math.abs(draftId));
    const local = tickets.find((t) => t.source_type === 'comanda' && t.source_id === comanda.id);
    reporter.check('ticket do PDV nasce como entrega', entrega?.service_type === 'entrega', entrega?.service_type);
    reporter.check('ticket da comanda nasce como local', local?.service_type === 'local', local?.service_type);

    // ─── Painel da cozinha mostra os dois tipos ────────────────────────────
    browser = await openBrowser();
    const page = await newPage(browser);
    await loginUi(page, base);
    await page.goto(`${base}/app/foodservice/cozinha`, { waitUntil: 'load' });
    await page.waitForSelector('.kds-card', { state: 'visible', timeout: 10000 });

    reporter.check(
      'card de entrega mostra o selo Entrega',
      (await page.locator('.kds-service-entrega[title="Entrega"]').count()) >= 1,
    );
    reporter.check(
      'card local mostra o selo Consumir no local',
      (await page.locator('.kds-service-local[title="Consumir no local"]').count()) >= 1,
    );
    reporter.check(
      'os dois selos têm ícone',
      (await page.locator('.kds-service-entrega svg').count()) >= 1
        && (await page.locator('.kds-service-local svg').count()) >= 1,
    );
    // Com 1 item, o rodapé "Iniciar preparo" repetia o botão do próprio item.
    reporter.check(
      'pedido de 1 item não mostra o rodapé duplicado',
      (await page.locator('.kds-card-footer:visible').count()) === 0,
    );
    reporter.check(
      'pedido de 1 item mantém o botão do item',
      (await page.locator('.kds-item-action').count()) >= 2,
    );

    // ─── A escolha no PDV chega no corpo do envio ──────────────────────────
    await page.goto(`${base}/app/store/pdv`, { waitUntil: 'load' });
    await page.waitForSelector('.pdv-search-box input', { state: 'visible', timeout: 10000 });
    await page.fill('.pdv-search-box input', produto.name);
    await page.waitForSelector('.pdv-results .pdv-result', { state: 'visible', timeout: 10000 });
    await page.locator('.pdv-results .pdv-result').first().click();
    await page.waitForSelector('.pdv-service-type', { state: 'visible', timeout: 10000 });

    reporter.check(
      'PDV começa em "Consumir aqui"',
      (await page.locator('.pdv-service-type button').first().getAttribute('aria-pressed')) === 'true',
    );
    await page.locator('.pdv-service-type button.entrega').click();
    reporter.check(
      'seletor marca Entrega',
      (await page.locator('.pdv-service-type button.entrega').getAttribute('aria-pressed')) === 'true',
    );

    const requestPromise = page.waitForRequest(
      (r) => r.url().includes('/api/store/kitchen/send'),
      { timeout: 10000 },
    );
    await page.locator('.pdv-kitchen-btn').click();
    const body = (await requestPromise).postDataJSON() as { serviceType?: string };
    reporter.check('PDV envia serviceType=entrega', body.serviceType === 'entrega', String(body.serviceType));

    await teardown(server.server, browser);
  } catch (e) {
    console.error('[e2e-cozinha-tipo-pedido] erro fatal:', e);
    reporter.check('execução sem exceção', false, (e as Error).message);
  }

  reporter.finish();
}

void main();
