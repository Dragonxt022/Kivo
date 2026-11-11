/**
 * QA E2E (Playwright) — Layout da comanda no celular.
 *
 * O print do garçom mostrou o preço caindo por cima do nome do produto: o stepper
 * (− qtd +), o nome, o preço e a lixeira não cabiam numa linha só a 390px. Este teste
 * trava o layout em duas linhas (nome/lixeira em cima, stepper/preço embaixo) nas
 * larguras reais de celular, e confere que o botão de suporte não cobre o "Fechar
 * comanda" fixo.
 *
 * Uso:
 *   node scripts/test-isolated.js src/tests/e2e/comandas-mobile-layout.ts
 */
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

const PORT = Number(process.env.KURUK_PORT ?? 3612);
const SHOTS = snapDir('comandas-mobile');

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
  right: number;
  bottom: number;
}

function overlap(a: Rect, b: Rect): boolean {
  return a.x < b.right && b.x < a.right && a.y < b.bottom && b.y < a.bottom;
}

async function main(): Promise<void> {
  const reporter = new Reporter('Comanda mobile');
  let server: E2EServer | undefined;

  try {
    server = await setupServer({
      port: PORT,
      capabilities: [{ key: 'comandas.mesas', module: 'comandas' }],
    });
    const cookie = await loginApi(server.base);
    if (!cookie) throw new Error('login via API falhou');

    const post = async <T = unknown>(route: string, body: unknown): Promise<T> => {
      const r = await api(server!.base, route, { method: 'POST', body: JSON.stringify(body) }, cookie);
      const j = (await r.json()) as { data?: T };
      if (!r.ok) throw new Error(`${route} ${r.status}: ${JSON.stringify(j)}`);
      return (j.data ?? j) as T;
    };

    const mesa = await post<{ id: number }>('/api/comandas/tables', { label: 'Mesa 01' });
    const produto = await post<{ id: number }>('/api/commercial/products', {
      name: 'X-File Combo Duplo Bacon Cheddar',
      priceCents: 2600,
    });
    const comanda = await post<{ id: number }>('/api/comandas/comandas', { tableId: mesa.id });
    await post(`/api/comandas/comandas/${comanda.id}/items`, { productId: produto.id, qty: 1 });

    const browser = await openBrowser();
    const page = await newPage(browser, { mobile: true });
    await loginUi(page, server.base);
    await page.goto(`${server.base}/app/comandas/mesas/${comanda.id}`, { waitUntil: 'load' });
    await page.waitForSelector('.comanda-item-name', { state: 'visible', timeout: 10000 });
    await page.waitForTimeout(500);

    for (const width of [320, 360, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await page.waitForTimeout(250);

      const m = await page.evaluate(() => {
        const parts: Record<string, Rect> = {};
        const sels: Record<string, string> = {
          item: '.comanda-item',
          name: '.comanda-item-name',
          price: '.comanda-item-price',
          del: '.comanda-item .icon-btn',
          qty: '.comanda-item .qty-wrap',
          notes: '.comanda-add-panel .comanda-notes-input',
          closeBar: '.close-bar',
          fab: '.fab',
        };
        for (const key of Object.keys(sels)) {
          const el = document.querySelector(sels[key]) as HTMLElement | null;
          if (!el) continue;
          const b = el.getBoundingClientRect();
          parts[key] = { x: b.x, y: b.y, w: b.width, h: b.height, right: b.right, bottom: b.bottom };
        }
        return { overflowX: document.documentElement.scrollWidth - window.innerWidth, parts };
      });

      const at = ` @${width}px`;
      const p = m.parts;
      reporter.check(`sem rolagem horizontal${at}`, m.overflowX <= 0, String(m.overflowX));
      reporter.check(`nome e preço não se sobrepõem${at}`, !overlap(p.name, p.price));
      reporter.check(`nome e lixeira não se sobrepõem${at}`, !overlap(p.name, p.del));
      reporter.check(`stepper e preço não se sobrepõem${at}`, !overlap(p.qty, p.price));
      reporter.check(`lixeira dentro do cartão${at}`, p.del.right <= p.item.right + 0.5);
      // O campo de observação precisa caber "Observação" sem cortar no placeholder.
      reporter.check(`campo de observação legível${at}`, p.notes.w >= 118, `${Math.round(p.notes.w)}px`);
      reporter.check(
        `botão de suporte acima do "Fechar comanda"${at}`,
        p.fab.bottom <= p.closeBar.y + 1,
        `fab.bottom=${Math.round(p.fab.bottom)} bar.top=${Math.round(p.closeBar.y)}`,
      );

      await snap(page, SHOTS, `comanda-${width}`);
    }

    await teardown(server.server, browser);
  } catch (e) {
    console.error('[e2e-comanda-mobile] erro fatal:', e);
    reporter.check('execução sem exceção', false, (e as Error).message);
  }

  reporter.finish();
}

void main();
