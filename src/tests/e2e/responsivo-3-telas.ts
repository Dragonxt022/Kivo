/**
 * QA E2E (Playwright) — PDV, Mesas e Cozinha em celular, tablet e computador.
 *
 * O KDS é um painel de operação: com muitos pedidos, a coluna "Pendentes" esticava a
 * página e, no celular/tablet deitado, as etapas empilhavam em faixas de poucos pixels
 * (o cartão virava uma tira invisível). Este teste fixa o contrato visual:
 *
 *  - nenhuma tela estoura a largura;
 *  - o KDS cabe na altura da janela e cada coluna rola por dentro;
 *  - o cartão do pedido mantém altura utilizável (não é esmagado);
 *  - o PDV mostra o seletor local/entrega e o carrinho não vira um vão gigante;
 *  - em Mesas, a última mesa fica acima da barra inferior.
 *
 * Também salva um print de cada tela em `.qa-screenshots/responsivo-3-telas/`.
 *
 * Uso:
 *   node scripts/test-isolated.js src/tests/e2e/responsivo-3-telas.ts
 */
import { chromium, type Browser, type Page } from 'playwright';
import path from 'node:path';
import {
  Reporter,
  setupServer,
  newPage,
  loginApi,
  api,
  snapDir,
  snap,
  teardown,
  type E2EServer,
} from './harness';

const PORT = Number(process.env.KIVO_PORT ?? 3620);
const SHOTS = snapDir('responsivo-3-telas');
const TOUCH_ARGS = [
  '--blink-settings=primaryHoverType=1,availableHoverTypes=1,primaryPointerType=2,availablePointerTypes=2',
];

interface Caso {
  nome: string;
  width: number;
  height: number;
  touch: boolean;
  /** `flex` = colunas empilhadas; `grid` = lado a lado. */
  kds: 'flex' | 'grid';
}

const CASOS: Caso[] = [
  { nome: 'celular', width: 390, height: 844, touch: true, kds: 'flex' },
  { nome: 'celular-deitado', width: 844, height: 390, touch: true, kds: 'grid' },
  { nome: 'tablet', width: 820, height: 1180, touch: true, kds: 'flex' },
  { nome: 'tablet-deitado', width: 1180, height: 820, touch: true, kds: 'grid' },
  { nome: 'computador', width: 1366, height: 768, touch: false, kds: 'grid' },
];

interface Layout {
  vw: number;
  vh: number;
  overflowX: number;
  scrollH: number;
}

async function abrirPagina(browser: Browser, caso: Caso, base: string, cookie: string): Promise<Page> {
  const page = await newPage(browser, {
    viewport: { width: caso.width, height: caso.height },
    mobile: caso.touch,
  });
  const value = cookie.split(';')[0].split('=').slice(1).join('=');
  await page.context().addCookies([{
    name: 'kivo_session',
    value,
    domain: new URL(base).hostname,
    path: '/',
  }]);
  return page;
}

async function medidas(page: Page): Promise<Layout> {
  return page.evaluate(() => ({
    vw: window.innerWidth,
    vh: window.innerHeight,
    overflowX: document.documentElement.scrollWidth - window.innerWidth,
    scrollH: document.documentElement.scrollHeight,
  }));
}

async function main(): Promise<void> {
  const reporter = new Reporter('Responsivo — PDV, Mesas e Cozinha');
  let server: E2EServer | undefined;
  let touchBrowser: Browser | undefined;
  let desktopBrowser: Browser | undefined;

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

    // Dados: uma mesa com comanda e uma fila de pedidos no KDS (força a rolagem interna).
    const produto = await call<{ id: number; name: string }>('POST', '/api/commercial/products', {
      name: 'Combo Responsivo', priceCents: 2400,
    });
    await call('POST', '/api/foodservice/kitchen-routing', { productId: produto.id, station: 'Cozinha' });
    // Várias mesas para a grade ter linhas de verdade (uma mesa só testaria uma coluna).
    const mesas: { id: number }[] = [];
    for (let i = 1; i <= 8; i += 1) {
      mesas.push(await call<{ id: number }>('POST', '/api/comandas/tables', {
        label: `Mesa ${String(i).padStart(2, '0')}`,
      }));
    }
    const comanda = await call<{ id: number }>('POST', '/api/comandas/comandas', { tableId: mesas[0].id });
    await call('POST', `/api/comandas/comandas/${comanda.id}/items`, { productId: produto.id, qty: 2 });
    await call('POST', `/api/comandas/comandas/${comanda.id}/enviar-cozinha`);
    for (let i = 0; i < 8; i += 1) {
      await call('POST', '/api/store/kitchen/send', {
        draftId: 700000 + i,
        serviceType: i === 0 ? 'entrega' : 'local',
        items: [{ productId: produto.id, name: produto.name, qty: 1 }],
      });
    }

    touchBrowser = await chromium.launch({ args: TOUCH_ARGS });
    desktopBrowser = await chromium.launch();
    const browsers = new Map<boolean, Browser>([
      [true, touchBrowser],
      [false, desktopBrowser],
    ]);

    for (const caso of CASOS) {
      const page = await abrirPagina(browsers.get(caso.touch)!, caso, base, cookie);
      const at = ` @${caso.nome} (${caso.width}×${caso.height})`;

      // ─── PDV ────────────────────────────────────────────────────────────
      reporter.section(`PDV${at}`);
      await page.goto(`${base}/app/store/pdv`, { waitUntil: 'load' });
      await page.waitForSelector('.pdv-search-box input', { state: 'visible', timeout: 10000 });
      await page.fill('.pdv-search-box input', produto.name);
      await page.waitForSelector('.pdv-results .pdv-result', { state: 'visible', timeout: 10000 });
      await page.locator('.pdv-results .pdv-result').first().click();
      await page.waitForSelector('.pdv-service-type', { state: 'visible', timeout: 10000 });
      await page.waitForTimeout(300);

      const pdv = await medidas(page);
      reporter.check(`PDV não estoura a largura${at}`, pdv.overflowX <= 0, String(pdv.overflowX));
      reporter.check(
        `PDV mostra o seletor local/entrega${at}`,
        (await page.locator('.pdv-service-type button').count()) === 2,
      );
      reporter.check(
        `PDV tem o botão Enviar para cozinha${at}`,
        (await page.locator('.pdv-kitchen-btn').count()) === 1,
      );
      if (caso.width <= 1080) {
        const cartAltura = await page.locator('.cart-items').evaluate((el) => Math.round(el.getBoundingClientRect().height));
        reporter.check(`PDV não deixa o carrinho vazio gigante${at}`, cartAltura <= Math.round(caso.height * 0.48) + 2, `${cartAltura}px`);
      }
      await snap(page, SHOTS, `pdv-${caso.nome}`);
      await page.screenshot({ path: path.join(SHOTS, `viewport-pdv-${caso.nome}.png`) });

      // ─── MESAS ───────────────────────────────────────────────────────────
      reporter.section(`Mesas${at}`);
      await page.goto(`${base}/app/comandas/mesas`, { waitUntil: 'load' });
      await page.waitForSelector('.table-card', { state: 'visible', timeout: 10000 });
      await page.waitForTimeout(400);
      const mesas = await medidas(page);
      const mesasInfo = await page.evaluate(() => {
        const cards = Array.from(document.querySelectorAll('.table-card'));
        const firstY = cards[0]?.getBoundingClientRect().y;
        return {
          total: cards.length,
          primeiraLinha: cards.filter((c) => c.getBoundingClientRect().y === firstY).length,
          cardW: Math.round(cards[0]?.getBoundingClientRect().width ?? 0),
        };
      });
      reporter.check(`Mesas não estoura a largura${at}`, mesas.overflowX <= 0, String(mesas.overflowX));
      reporter.check(`Mesas lista as mesas${at}`, mesasInfo.total >= 1, String(mesasInfo.total));
      reporter.check(`Mesas em grade (sem coluna única espremida)${at}`, mesasInfo.primeiraLinha >= 2, String(mesasInfo.primeiraLinha));

      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      await page.waitForTimeout(300);
      if (caso.touch) {
        const ultimaAcimaDaBarra = await page.evaluate(() => {
          const cards = Array.from(document.querySelectorAll('.table-card'));
          const last = cards[cards.length - 1]?.getBoundingClientRect();
          const nav = document.querySelector('.mobile-bottom-nav')?.getBoundingClientRect();
          // Em tablet deitado (>820px) a barra inferior não é exibida; sem altura não há
          // o que comparar.
          if (!last || !nav || nav.height === 0) return true;
          return last.bottom <= nav.top + 1;
        });
        reporter.check(`Mesas: última mesa acessível acima da barra${at}`, ultimaAcimaDaBarra);
      }
      await snap(page, SHOTS, `mesas-${caso.nome}`);
      await page.screenshot({ path: path.join(SHOTS, `viewport-mesas-${caso.nome}.png`) });

      // ─── COZINHA ─────────────────────────────────────────────────────────
      reporter.section(`Cozinha${at}`);
      await page.goto(`${base}/app/foodservice/cozinha`, { waitUntil: 'load' });
      await page.waitForSelector('.kds-card', { state: 'visible', timeout: 10000 });
      await page.waitForTimeout(500);
      const kds = await medidas(page);
      const kdsInfo = await page.evaluate(() => {
        const board = document.querySelector('.kds-board');
        const cols = Array.from(document.querySelectorAll('.kds-col')).map((el) => {
          const r = el.getBoundingClientRect();
          return {
            w: Math.round(r.width),
            h: Math.round(r.height),
            cards: el.querySelectorAll('.kds-card').length,
            bodyClient: el.querySelector('.kds-col-body')?.clientHeight ?? 0,
            bodyScroll: el.querySelector('.kds-col-body')?.scrollHeight ?? 0,
          };
        });
        const card = document.querySelector('.kds-card')?.getBoundingClientRect();
        const actions = document.querySelector('.kds-head-actions')?.getBoundingClientRect();
        return {
          display: board ? getComputedStyle(board).display : 'none',
          cols,
          cardH: Math.round(card?.height ?? 0),
          actionsBottom: Math.round(actions?.bottom ?? 0),
          cards: document.querySelectorAll('.kds-card').length,
        };
      });
      reporter.check(`Cozinha não estoura a largura${at}`, kds.overflowX <= 0, String(kds.overflowX));
      reporter.check(`Cozinha cabe na altura da janela${at}`, kds.scrollH <= kds.vh + 2, `${kds.scrollH}/${kds.vh}`);
      reporter.check(`Cozinha usa o layout esperado${at}`, kdsInfo.display === caso.kds, kdsInfo.display);
      reporter.check(`Cozinha tem as 3 etapas${at}`, kdsInfo.cols.length === 3, String(kdsInfo.cols.length));
      reporter.check(
        `Cozinha: colunas com largura utilizável${at}`,
        kdsInfo.cols.every((c) => c.w >= 200),
        kdsInfo.cols.map((c) => c.w).join(','),
      );
      reporter.check(`Cozinha: cartão não é esmagado${at}`, kdsInfo.cardH >= 80, `${kdsInfo.cardH}px`);
      reporter.check(`Cozinha: botões do topo visíveis${at}`, kdsInfo.actionsBottom <= kds.vh, `${kdsInfo.actionsBottom}/${kds.vh}`);
      const pendentes = kdsInfo.cols[0];
      reporter.check(
        `Cozinha: fila rola por dentro${at}`,
        pendentes.bodyScroll >= pendentes.bodyClient,
        `${pendentes.bodyScroll}/${pendentes.bodyClient}`,
      );
      await snap(page, SHOTS, `cozinha-${caso.nome}`);
      await page.screenshot({ path: path.join(SHOTS, `viewport-cozinha-${caso.nome}.png`) });

      await page.context().close();
    }

    reporter.section('Prints');
    console.log(`  Prints salvos em: ${SHOTS}`);

    await teardown(server.server, desktopBrowser);
    await touchBrowser.close();
  } catch (e) {
    console.error('[e2e-responsivo-3-telas] erro fatal:', e);
    reporter.check('execução sem exceção', false, (e as Error).message);
    if (desktopBrowser) await desktopBrowser.close().catch(() => {});
    if (touchBrowser) await touchBrowser.close().catch(() => {});
    if (server) await new Promise<void>((resolve) => server!.server.close(() => resolve()));
  }

  reporter.finish();
}

void main();
