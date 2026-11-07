/**
 * QA E2E (Playwright) — Vendas e Caixa em celular, tablet e computador.
 *
 * O histórico de vendas e a gaveta são usados tanto no balcão (desktop) quanto no
 * celular/tablet da rede local. Este teste fixa o contrato das duas telas:
 *
 *  - nenhuma delas estoura a largura da viewport;
 *  - abaixo de 820px as listagens viram cartões (o thead some e cada linha vira um card);
 *  - os filtros continuam funcionando (forma de pagamento filtra de verdade);
 *  - o período do Caixa e o diálogo de fechamento cabem na tela.
 *
 * Uso:
 *   node scripts/test-isolated.js src/tests/e2e/responsivo-vendas-caixa.ts
 */
import { chromium, type Browser, type Page } from 'playwright';
import {
  Reporter,
  setupServer,
  newPage,
  loginApi,
  api,
  unwrap,
  snapDir,
  snap,
  teardown,
  type E2EServer,
} from './harness';

const PORT = Number(process.env.KIVO_PORT ?? 3621);
const SHOTS = snapDir('responsivo-vendas-caixa');
const TOUCH_ARGS = [
  '--blink-settings=primaryHoverType=1,availableHoverTypes=1,primaryPointerType=2,availablePointerTypes=2',
];

interface Caso {
  nome: string;
  width: number;
  height: number;
  touch: boolean;
  /** Até 640px a listagem vira cartões; acima continua tabela (com rolagem interna até 820). */
  cartoes: boolean;
}

const CASOS: Caso[] = [
  { nome: 'celular', width: 390, height: 844, touch: true, cartoes: true },
  { nome: 'tablet', width: 820, height: 1180, touch: true, cartoes: false },
  { nome: 'tablet-deitado', width: 1180, height: 820, touch: true, cartoes: false },
  { nome: 'computador', width: 1366, height: 768, touch: false, cartoes: false },
];

async function abrirPagina(browser: Browser, caso: Caso, base: string, cookie: string): Promise<Page> {
  const page = await newPage(browser, { viewport: { width: caso.width, height: caso.height }, mobile: caso.touch });
  const value = cookie.split(';')[0].split('=').slice(1).join('=');
  await page.context().addCookies([{
    name: 'kivo_session',
    value,
    domain: new URL(base).hostname,
    path: '/',
  }]);
  return page;
}

async function overflowX(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
}

/** Conta só as linhas visíveis: o `tr` de "nenhum registro" fica no DOM com x-show=false. */
async function visibleRows(page: Page, selector: string): Promise<number> {
  return page.locator(selector).evaluateAll((rows) =>
    rows.filter((row) => getComputedStyle(row).display !== 'none').length,
  );
}

async function main(): Promise<void> {
  const reporter = new Reporter('Responsivo — Vendas e Caixa');
  let server: E2EServer | undefined;
  let touchBrowser: Browser | undefined;
  let desktopBrowser: Browser | undefined;

  try {
    server = await setupServer({ port: PORT });
    const base = server.base;
    const admin = await loginApi(base);
    if (!admin) throw new Error('login via API falhou');

    const call = async <T = unknown>(method: string, route: string, body?: unknown): Promise<T> => {
      const r = await api(base, route, {
        method,
        ...(body ? { body: JSON.stringify(body) } : {}),
      }, admin);
      if (!r.ok) throw new Error(`${method} ${route} ${r.status}: ${await r.text()}`);
      return unwrap<T>(r);
    };

    const produto = await call<{ id: number }>('POST', '/api/commercial/products', {
      name: 'Produto Vendas Responsivo', priceCents: 1500, trackStock: true, initialStock: 50,
    });
    await call('POST', '/api/finance/cash/open', { openingCents: 10000 });
    const methods = await call<{ id: number; type: string }[]>('GET', '/api/store/payment-methods');
    const dinheiro = methods.find((m) => m.type === 'dinheiro');
    const pix = methods.find((m) => m.type === 'pix');
    if (!dinheiro || !pix) throw new Error('formas de pagamento padrão ausentes');

    await call('POST', '/api/store/sales', {
      items: [{ productId: produto.id, qty: 2 }],
      payments: [{ methodId: dinheiro.id, amountCents: 3000, receivedCents: 3000 }],
    });
    await call('POST', '/api/store/sales', {
      items: [{ productId: produto.id, qty: 1 }],
      payments: [{ methodId: pix.id, amountCents: 1500 }],
    });

    touchBrowser = await chromium.launch({ args: TOUCH_ARGS });
    desktopBrowser = await chromium.launch();
    const browsers = new Map<boolean, Browser>([
      [true, touchBrowser],
      [false, desktopBrowser],
    ]);

    for (const caso of CASOS) {
      const page = await abrirPagina(browsers.get(caso.touch)!, caso, base, admin);
      const at = ` @${caso.nome} (${caso.width}×${caso.height})`;

      // ─── VENDAS ──────────────────────────────────────────────────────────
      reporter.section(`Vendas${at}`);
      await page.goto(`${base}/app/store/vendas`, { waitUntil: 'load', timeout: 20000 });
      await page.waitForSelector('#sales-table tbody tr', { state: 'visible', timeout: 10000 });
      await page.waitForTimeout(700);

      reporter.check(`vendas não estoura a largura${at}`, (await overflowX(page)) <= 0, String(await overflowX(page)));

      const vendasLayout = await page.evaluate(() => {
        const table = document.querySelector('#sales-table');
        const thead = table?.querySelector('thead');
        const wrap = table?.parentElement;
        return {
          thead: thead ? getComputedStyle(thead).display : 'none',
          cards: document.querySelectorAll('#sales-table td.table-card-title').length,
          rows: document.querySelectorAll('#sales-table tbody tr').length,
          wrapOverflow: wrap ? getComputedStyle(wrap).overflowX : '',
        };
      });
      reporter.check(
        caso.cartoes ? `vendas vira cartões${at}` : `vendas continua tabela${at}`,
        caso.cartoes ? vendasLayout.thead === 'none' && vendasLayout.cards >= 1 : vendasLayout.thead !== 'none',
        JSON.stringify(vendasLayout),
      );
      // No tablet retrato a tabela não vira cartão, mas precisa rolar por dentro em vez
      // de empurrar a página inteira.
      if (caso.width <= 820 && !caso.cartoes) {
        reporter.check(`vendas rola dentro do contêiner${at}`, vendasLayout.wrapOverflow === 'auto', vendasLayout.wrapOverflow);
      }

      // O filtro de forma de pagamento precisa bater no pagamento real, não no rótulo
      // legado da venda (PIX é PIX, dinheiro é dinheiro).
      const selectForma = page.locator('.toolbar > select').first();
      await selectForma.selectOption('pix');
      await page.waitForTimeout(700);
      const linhasPix = await visibleRows(page, '#sales-table tbody tr');
      reporter.check(`vendas filtra por PIX${at}`, linhasPix === 1, String(linhasPix));
      await selectForma.selectOption('');
      await page.waitForTimeout(500);

      await snap(page, SHOTS, `vendas-${caso.nome}`);

      // ─── CAIXA ───────────────────────────────────────────────────────────
      reporter.section(`Caixa${at}`);
      await page.goto(`${base}/app/finance/caixa`, { waitUntil: 'load', timeout: 20000 });
      await page.waitForSelector('.badge.ok:has-text("aberto")', { state: 'visible', timeout: 10000 });
      await page.waitForSelector('#cash-movements-table tbody tr', { state: 'visible', timeout: 10000 });
      await page.waitForTimeout(500);

      reporter.check(`caixa não estoura a largura${at}`, (await overflowX(page)) <= 0, String(await overflowX(page)));
      // O período agora vive no botão "Filtros" (a barra do topo não mistura mais o
      // período com os botões do turno). No desktop o kivo-ui troca o campo nativo por
      // um texto do flatpickr; contar os inputs (sem exigir type=date) serve nos dois modos.
      await page.locator('.cash-filter-btn').click();
      const periodDlg = page.locator('dialog[x-ref="periodDlg"][open]');
      await periodDlg.waitFor({ state: 'visible', timeout: 8000 });
      const periodos = await periodDlg.locator('input').count();
      reporter.check(`caixa mostra o período${at}`, periodos === 2, String(periodos));
      await periodDlg.locator('button:has-text("hoje")').click();
      await periodDlg.locator('button:has-text("Aplicar")').click();
      await page.waitForTimeout(600);
      const periodoAplicado = await page.locator('.cash-toolbar .muted').first().textContent();
      reporter.check(
        `caixa aplica o período${at}`,
        (periodoAplicado ?? '').includes('/'),
        periodoAplicado ?? '',
      );

      const caixaLayout = await page.evaluate(() => {
        const table = document.querySelector('#cash-movements-table');
        const thead = table?.querySelector('thead');
        return {
          thead: thead ? getComputedStyle(thead).display : 'none',
          cards: document.querySelectorAll('#cash-movements-table td.table-card-title').length,
          resumo: document.querySelector('.cash-mov-summary')?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
        };
      });
      reporter.check(
        caso.cartoes ? `caixa vira cartões${at}` : `caixa continua tabela${at}`,
        caso.cartoes ? caixaLayout.thead === 'none' && caixaLayout.cards >= 1 : caixaLayout.thead !== 'none',
        JSON.stringify(caixaLayout),
      );
      reporter.check(`caixa mostra o resumo do período${at}`, caixaLayout.resumo.includes('Entradas'), caixaLayout.resumo);

      await page.locator('main .toolbar button:has-text("Fechar caixa")').first().click();
      const dlg = page.locator('dialog[x-ref="close"][open]');
      await dlg.waitFor({ state: 'visible', timeout: 8000 });
      await page.waitForTimeout(250);
      const box = await dlg.boundingBox();
      reporter.check(
        `fechamento de caixa cabe na tela${at}`,
        !!box && box.x >= -1 && box.y >= -1 && box.x + box.width <= caso.width + 1 && box.y + box.height <= caso.height + 1,
        box ? `x=${Math.round(box.x)}, y=${Math.round(box.y)}, w=${Math.round(box.width)}, h=${Math.round(box.height)}` : 'sem caixa',
      );
      await page.keyboard.press('Escape');

      await snap(page, SHOTS, `caixa-${caso.nome}`);

      await page.context().close();
    }

    reporter.section('Prints');
    console.log(`  Prints salvos em: ${SHOTS}`);
  } catch (e) {
    console.error('[e2e-responsivo-vendas-caixa] erro fatal:', e);
    reporter.check('execução sem exceção', false, (e as Error).message);
  } finally {
    if (server) await teardown(server.server, desktopBrowser);
    if (touchBrowser) await touchBrowser.close().catch(() => {});
  }

  reporter.finish();
}

void main();
