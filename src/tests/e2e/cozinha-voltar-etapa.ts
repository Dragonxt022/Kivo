/**
 * QA E2E (Playwright) — Voltar etapa no painel de cozinha.
 *
 * A cozinha só andava para frente: um toque errado em "Iniciar/Pronto/Entregar" não tinha
 * como ser desfeito pela tela. Este teste cobre os três caminhos de correção (item,
 * pedido inteiro e pedido já entregue) e garante que o cartão continua entrando com a
 * animação suave.
 *
 * Uso:
 *   node scripts/test-isolated.js src/tests/e2e/cozinha-voltar-etapa.ts
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

const PORT = Number(process.env.KURUK_PORT ?? 3614);
const SHOTS = snapDir('e2e-cozinha-voltar');

interface Ticket {
  id: number;
  status: string;
  items: { id: number; status: string }[];
}

async function main(): Promise<void> {
  const reporter = new Reporter('Cozinha — voltar etapa');
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
    const cookie = await loginApi(server.base);
    if (!cookie) throw new Error('login via API falhou');
    const base = server.base;

    const call = async <T = unknown>(method: string, route: string, body?: unknown): Promise<T> => {
      const r = await api(base, route, {
        method,
        ...(body ? { body: JSON.stringify(body) } : {}),
      }, cookie);
      if (!r.ok) throw new Error(`${method} ${route} ${r.status}: ${await r.text()}`);
      const j = (await r.json()) as { data?: T };
      return (j.data ?? j) as T;
    };

    const mesa = await call<{ id: number }>('POST', '/api/comandas/tables', { label: 'Mesa 01' });
    const produto = await call<{ id: number }>('POST', '/api/commercial/products', { name: 'X-File Combo', priceCents: 2600 });
    await call('POST', '/api/foodservice/kitchen-routing', { productId: produto.id, station: 'Cozinha' });
    const comanda = await call<{ id: number }>('POST', '/api/comandas/comandas', { tableId: mesa.id });
    await call('POST', `/api/comandas/comandas/${comanda.id}/items`, { productId: produto.id, qty: 2, notes: 'sem cebola' });
    // Segundo item: o rodapé "pedido inteiro" só aparece com 2+ itens (com 1, ele repetia
    // o botão do próprio item). O teste do fluxo de ticket continua válido assim.
    await call('POST', `/api/comandas/comandas/${comanda.id}/items`, { productId: produto.id, qty: 1 });
    await call('POST', `/api/comandas/comandas/${comanda.id}/enviar-cozinha`);

    const ticket = async (): Promise<Ticket> => {
      const all = await call<Ticket[]>('GET', '/api/foodservice/kitchen/tickets');
      return all[0];
    };

    browser = await openBrowser();
    const page = await newPage(browser, { mobile: true });
    await loginUi(page, base);
    await page.goto(`${base}/app/foodservice/cozinha`, { waitUntil: 'load' });
    await page.waitForSelector('.kds-card', { state: 'visible', timeout: 10000 });

    // ─── Animação de entrada do cartão ───
    reporter.section('Animação');
    const anim = await page.locator('.kds-card').first().evaluate((el) => {
      const s = getComputedStyle(el);
      return { name: s.animationName, duration: s.animationDuration };
    });
    reporter.check('cartão entra com animação suave', anim.name === 'kds-card-in', `${anim.name} ${anim.duration}`);

    // ─── Voltar o pedido inteiro ───
    reporter.section('Voltar o pedido inteiro');
    reporter.check('pedido começa pendente', (await ticket()).status === 'pendente');
    await page.locator('.kds-advance-ticket').first().click();
    await page.waitForSelector('.kds-back-ticket', { state: 'visible', timeout: 8000 });
    reporter.check('pedido avançou para em preparo', (await ticket()).status === 'preparo');
    reporter.check('botão "Voltar" do pedido aparece', true);
    await snap(page, SHOTS, 'pedido-em-preparo');

    await page.locator('.kds-back-ticket').first().click();
    await page.waitForFunction(
      () => document.querySelector('.kds-col-pendente .kds-card') !== null,
      undefined,
      { timeout: 8000 },
    );
    const voltou = await ticket();
    reporter.check('pedido voltou para pendente', voltou.status === 'pendente');
    reporter.check('itens acompanharam a volta', voltou.items.every((i) => i.status === 'pendente'));
    await snap(page, SHOTS, 'pedido-de-volta');

    // ─── Voltar um item ───
    reporter.section('Voltar um item');
    await page.locator('.kds-item-action').first().click();
    await page.waitForSelector('.kds-item-back', { state: 'visible', timeout: 8000 });
    const itemAvancado = (await ticket()).items[0];
    reporter.check('item avançou para em preparo', itemAvancado.status === 'preparo', itemAvancado.status);
    await page.locator('.kds-item-back').first().click();
    await page.waitForFunction(
      () => document.querySelector('.kds-item-action') !== null,
      undefined,
      { timeout: 8000 },
    );
    const itemVoltou = (await ticket()).items[0];
    reporter.check('item voltou para pendente', itemVoltou.status === 'pendente', itemVoltou.status);

    // ─── Voltar um pedido já entregue (coluna oculta) ───
    reporter.section('Desfazer entrega');
    const atual = await ticket();
    await call('PUT', `/api/foodservice/kitchen/tickets/${atual.id}/status`, { status: 'entregue' });
    await page.reload({ waitUntil: 'load' });
    await page.waitForTimeout(700);
    await page.locator('button[title*="entregues"]').click();
    await page.waitForSelector('.kds-back-ticket', { state: 'visible', timeout: 8000 });
    await snap(page, SHOTS, 'entregues');
    await page.locator('.kds-back-ticket').first().click();
    await page.waitForTimeout(700);
    const reaberto = await ticket();
    reporter.check('pedido entregue volta para pronto', reaberto.status === 'pronto', reaberto.status);
    reporter.check('item entregue volta junto', reaberto.items.some((i) => i.status !== 'entregue'));

    await teardown(server.server, browser);
  } catch (e) {
    console.error('[e2e-cozinha] erro fatal:', e);
    reporter.check('execução sem exceção', false, (e as Error).message);
    if (server && browser) await teardown(server.server, browser);
  }

  reporter.finish();
}

void main();
