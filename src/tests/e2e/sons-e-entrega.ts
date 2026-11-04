/**
 * QA E2E (Playwright) — sons configuráveis e tipo do pedido na comanda.
 *
 * Cobre o que o lojista pediu:
 *  - escolher o som de pedido novo e o som de cancelamento na Cozinha;
 *  - escolher o som de pedido pronto na tela de Mesas;
 *  - a Cozinha avisar (toast) quando um pedido é cancelado;
 *  - a comanda nascer como "Consumir no local" e permitir marcar "Entrega".
 *
 * Uso:
 *   node scripts/test-isolated.js src/tests/e2e/sons-e-entrega.ts
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
  snapDir,
  snap,
  teardown,
  type E2EServer,
} from './harness';

const PORT = Number(process.env.KIVO_PORT ?? 3622);
const SHOTS = snapDir('sons-e-entrega');

interface Ticket {
  id: number;
  source_type: string;
  source_id: number;
  service_type: string;
}

async function main(): Promise<void> {
  const reporter = new Reporter('Sons e tipo do pedido');
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
      name: 'Combo Sons', priceCents: 2200,
    });
    await call('POST', '/api/foodservice/kitchen-routing', { productId: produto.id, station: 'Cozinha' });
    const mesaA = await call<{ id: number }>('POST', '/api/comandas/tables', { label: 'Mesa A' });
    const mesaB = await call<{ id: number }>('POST', '/api/comandas/tables', { label: 'Mesa B' });
    const mesaC = await call<{ id: number }>('POST', '/api/comandas/tables', { label: 'Mesa C' });

    browser = await openBrowser();
    const page = await newPage(browser);
    await loginUi(page, base);

    // ─── Cozinha: dois sons configuráveis ─────────────────────────────────
    reporter.section('Cozinha — sons');
    await page.goto(`${base}/app/foodservice/cozinha`, { waitUntil: 'load' });
    await page.waitForSelector('.kds-head', { state: 'visible', timeout: 10000 });
    await page.locator('button[title*="Escolher ou silenciar"]').click();
    await page.waitForSelector('dialog[x-ref="somDlg"][open]', { state: 'visible', timeout: 5000 });
    reporter.check('diálogo tem os dois grupos de som', (await page.locator('dialog[x-ref="somDlg"] .som-list').count()) === 2);
    reporter.check(
      'lista inclui os sons novos (6 a 8)',
      (await page.locator('dialog[x-ref="somDlg"] .som-choose', { hasText: 'Pedido 6' }).count()) === 2
        && (await page.locator('dialog[x-ref="somDlg"] .som-choose', { hasText: 'Pedido 8' }).count()) === 2,
    );
    const lists = page.locator('dialog[x-ref="somDlg"] .som-list');
    await lists.nth(0).locator('.som-choose', { hasText: 'Pedido 6' }).click();
    await lists.nth(1).locator('.som-choose', { hasText: 'Pedido 7' }).click();
    await page.locator('dialog[x-ref="somDlg"] button', { hasText: 'Salvar sons' }).click();
    await page.waitForTimeout(400);
    const sonsSalvos = await page.evaluate(() => ({
      novoAtivo: localStorage.getItem('kds-som'),
      novoArquivo: localStorage.getItem('kds-som-arquivo'),
      cancelAtivo: localStorage.getItem('kds-som-cancelamento'),
      cancelArquivo: localStorage.getItem('kds-som-cancelamento-arquivo'),
    }));
    reporter.check('som de novo pedido salvo', sonsSalvos.novoAtivo === '1' && sonsSalvos.novoArquivo === 'pedido6.mp3', JSON.stringify(sonsSalvos));
    reporter.check(
      'som de cancelamento salvo',
      sonsSalvos.cancelAtivo === '1' && sonsSalvos.cancelArquivo === 'pedido7.mp3',
      JSON.stringify(sonsSalvos),
    );
    await snap(page, SHOTS, 'cozinha-sons');

    // ─── Cozinha avisa quando cancela ────────────────────────────────────
    reporter.section('Cozinha — cancelamento');
    const comandaCancel = await call<{ id: number }>('POST', '/api/comandas/comandas', { tableId: mesaA.id });
    await call('POST', `/api/comandas/comandas/${comandaCancel.id}/items`, { productId: produto.id, qty: 1 });
    await call('POST', `/api/comandas/comandas/${comandaCancel.id}/enviar-cozinha`);
    await page.waitForTimeout(6000);
    await call('POST', `/api/comandas/comandas/${comandaCancel.id}/cancel`);
    const avisou = await page.waitForFunction(
      () => document.body.innerText.includes('Pedido cancelado'),
      undefined,
      { timeout: 12000 },
    ).then(() => true).catch(() => false);
    reporter.check('cozinha mostra o aviso de pedido cancelado', avisou);

    // ─── Mesas: escolher o som de pedido pronto ───────────────────────────
    reporter.section('Mesas — som');
    await page.goto(`${base}/app/comandas/mesas`, { waitUntil: 'load' });
    await page.waitForSelector('.mesas-som-btn', { state: 'visible', timeout: 10000 });
    await page.locator('.mesas-som-btn').click();
    await page.waitForSelector('dialog[x-ref="somDlg"][open]', { state: 'visible', timeout: 5000 });
    reporter.check('mesas lista os 8 sons + silencioso', (await page.locator('dialog[x-ref="somDlg"] .som-option').count()) === 9);
    await page.locator('dialog[x-ref="somDlg"] .som-choose', { hasText: 'Pedido 6' }).click();
    await page.locator('dialog[x-ref="somDlg"] button', { hasText: 'Ativar este som' }).click();
    await page.waitForTimeout(400);
    const mesasSom = await page.evaluate(() => {
      const api = (window as unknown as {
        KivoReadyAlerts?: { getSoundFile(): string };
      }).KivoReadyAlerts;
      return {
        arquivo: localStorage.getItem('kivo-ready-som-arquivo'),
        api: api ? api.getSoundFile() : null,
      };
    });
    reporter.check('som de pedido pronto salvo nas Mesas', mesasSom.arquivo === 'pedido6.mp3' && mesasSom.api === 'pedido6.mp3', JSON.stringify(mesasSom));
    await snap(page, SHOTS, 'mesas-sons');

    // ─── Comanda: padrão local, com opção Entrega ─────────────────────────
    reporter.section('Comanda — local x entrega');
    const cEntrega = await call<{ id: number }>('POST', '/api/comandas/comandas', { tableId: mesaB.id });
    await call('POST', `/api/comandas/comandas/${cEntrega.id}/items`, { productId: produto.id, qty: 1 });
    await page.goto(`${base}/app/comandas/mesas/${cEntrega.id}`, { waitUntil: 'load' });
    await page.waitForSelector('.comanda-service-type', { state: 'visible', timeout: 10000 });
    reporter.check(
      'comanda nasce em Consumir no local',
      (await page.locator('.comanda-service-type .btn').first().getAttribute('class'))?.includes('active') === true,
    );
    await page.locator('.comanda-service-type .entrega').click();
    await page.locator('button', { hasText: 'Enviar p/ cozinha' }).click();
    await page.waitForTimeout(800);
    const tickets = await call<Ticket[]>('GET', '/api/foodservice/kitchen/tickets');
    const entrega = tickets.find((t) => t.source_type === 'comanda' && t.source_id === cEntrega.id);
    reporter.check('comanda marcada como Entrega chega assim na cozinha', entrega?.service_type === 'entrega', entrega?.service_type);

    const cLocal = await call<{ id: number }>('POST', '/api/comandas/comandas', { tableId: mesaC.id });
    await call('POST', `/api/comandas/comandas/${cLocal.id}/items`, { productId: produto.id, qty: 1 });
    await page.goto(`${base}/app/comandas/mesas/${cLocal.id}`, { waitUntil: 'load' });
    await page.waitForSelector('.comanda-service-type', { state: 'visible', timeout: 10000 });
    await page.locator('button', { hasText: 'Enviar p/ cozinha' }).click();
    await page.waitForTimeout(800);
    const tickets2 = await call<Ticket[]>('GET', '/api/foodservice/kitchen/tickets');
    const local = tickets2.find((t) => t.source_type === 'comanda' && t.source_id === cLocal.id);
    reporter.check('sem escolher nada, a comanda continua Local', local?.service_type === 'local', local?.service_type);

    await teardown(server.server, browser);
  } catch (e) {
    console.error('[e2e-sons-e-entrega] erro fatal:', e);
    reporter.check('execução sem exceção', false, (e as Error).message);
  }

  reporter.finish();
}

void main();
