/**
 * QA E2E (Playwright) — complementos no grupo certo (comanda + cozinha).
 *
 * O que protege:
 *  - a comanda agrupa o principal com os adicionais mesmo quando o banco devolve os
 *    grupos intercalados (A principal, B principal, A adicional...);
 *  - o KDS recebe os complementos no item principal, mesmo que eles não sejam produtos
 *    roteados individualmente para a cozinha.
 *
 * Uso:
 *   node scripts/test-isolated.js src/tests/e2e/complementos-cozinha.ts
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

const PORT = Number(process.env.KURUK_PORT ?? 3624);
const SHOTS = snapDir('complementos-cozinha');

interface TicketItem {
  product_name: string;
  notes: string | null;
  complements: string | null;
}

interface Ticket {
  id: number;
  source_type: string;
  source_id: number;
  items: TicketItem[];
}

async function main(): Promise<void> {
  const reporter = new Reporter('Complementos no grupo');
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

    const acai = await call<{ id: number; name: string }>('POST', '/api/commercial/products', {
      name: 'Açaí 300ml', priceCents: 1900,
    });
    const granola = await call<{ id: number; name: string }>('POST', '/api/commercial/products', {
      name: 'Granola', priceCents: 300,
    });
    const leite = await call<{ id: number; name: string }>('POST', '/api/commercial/products', {
      name: 'Leite condensado', priceCents: 300,
    });
    // Só o Açaí vai para a cozinha; Granola/Leite são complementos e não têm roteamento.
    await call('POST', '/api/foodservice/kitchen-routing', { productId: acai.id, station: 'Cozinha' });

    const mesa = await call<{ id: number }>('POST', '/api/comandas/tables', { label: 'Mesa 01' });
    const comanda = await call<{ id: number }>('POST', '/api/comandas/comandas', { tableId: mesa.id });
    const add = (productId: number, lineGroupUuid: string) =>
      call('POST', `/api/comandas/comandas/${comanda.id}/items`, { productId, qty: 1, lineGroupUuid });

    // Duas confirmações do diálogo, intercaladas de propósito (caso real de duplo toque).
    const groupA = 'grupo-a';
    const groupB = 'grupo-b';
    await add(acai.id, groupA);
    await add(acai.id, groupB);
    await add(granola.id, groupA);
    await add(granola.id, groupB);
    await add(leite.id, groupA);
    await add(leite.id, groupB);

    // ─── Comanda: adicionais indentados abaixo do principal ────────────────
    browser = await openBrowser();
    const page = await newPage(browser);
    await loginUi(page, base);
    await page.goto(`${base}/app/comandas/mesas/${comanda.id}`, { waitUntil: 'load' });
    await page.waitForSelector('.comanda-item', { state: 'visible', timeout: 10000 });
    const linhas = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.comanda-item')).map((el) => ({
        name: el.querySelector('.comanda-item-name')?.textContent?.trim() ?? '',
        complement: el.classList.contains('is-complement'),
        markVisible: !!el.querySelector('.comanda-item-mark') &&
          getComputedStyle(el.querySelector('.comanda-item-mark') as HTMLElement).display !== 'none',
      })),
    );
    reporter.check(
      'comanda agrupa principal + adicionais mesmo intercalados',
      linhas.map((l) => l.name).join('|') === 'Açaí 300ml|Granola|Leite condensado|Açaí 300ml|Granola|Leite condensado',
      linhas.map((l) => l.name).join('|'),
    );
    reporter.check(
      'adicionais marcados como complemento',
      linhas.filter((l) => l.complement).length === 4,
      String(linhas.filter((l) => l.complement).length),
    );
    reporter.check(
      'seta de complemento visível',
      linhas.filter((l) => l.markVisible).length === 4,
      String(linhas.filter((l) => l.markVisible).length),
    );
    await snap(page, SHOTS, 'comanda-complementos');

    // ─── Cozinha: complementos vão no item principal ──────────────────────
    await call('POST', `/api/comandas/comandas/${comanda.id}/enviar-cozinha`);
    const tickets = await call<Ticket[]>('GET', '/api/foodservice/kitchen/tickets');
    const ticket = tickets.find((t) => t.source_type === 'comanda' && t.source_id === comanda.id);
    reporter.check('ticket da comanda criado', !!ticket);
    reporter.check(
      'cozinha recebeu só o Açaí (complementos não duplicam item)',
      (ticket?.items.length ?? 0) === 2,
      String(ticket?.items.length),
    );
    reporter.check(
      'cada Açaí leva Granola e Leite condensado',
      (ticket?.items ?? []).every(
        (i) => (i.complements ?? '').includes('Granola') && (i.complements ?? '').includes('Leite condensado'),
      ),
      JSON.stringify(ticket?.items.map((i) => i.complements)),
    );

    await page.goto(`${base}/app/foodservice/cozinha`, { waitUntil: 'load' });
    await page.waitForSelector('.kds-card', { state: 'visible', timeout: 10000 });
    const kdsTexts = await page.locator('.kds-item-complements').allTextContents();
    reporter.check(
      'KDS mostra os complementos no card',
      kdsTexts.length === 2 && kdsTexts.every((t) => t.includes('Granola') && t.includes('Leite condensado')),
      kdsTexts.join(' || '),
    );
    await snap(page, SHOTS, 'cozinha-complementos');

    // ─── PDV direto também mantém o grupo ─────────────────────────────────
    const draftId = 600000 + Math.floor(Math.random() * 1000);
    await call('POST', '/api/store/kitchen/send', {
      draftId,
      items: [
        { productId: acai.id, name: acai.name, qty: 1, lineGroupUuid: 'pdv-grupo', notes: 'sem cebola' },
        { productId: granola.id, name: granola.name, qty: 1, lineGroupUuid: 'pdv-grupo' },
      ],
    });
    const allTickets = await call<Ticket[]>('GET', '/api/foodservice/kitchen/tickets');
    const pdvTicket = allTickets.find((t) => t.source_id === -Math.abs(draftId));
    reporter.check(
      'PDV também envia complemento no item principal',
      !!pdvTicket && pdvTicket.items.length === 1 && (pdvTicket.items[0].complements ?? '').includes('Granola'),
      JSON.stringify(pdvTicket?.items),
    );

    await teardown(server.server, browser);
  } catch (e) {
    console.error('[e2e-complementos-cozinha] erro fatal:', e);
    reporter.check('execução sem exceção', false, (e as Error).message);
  }

  reporter.finish();
}

void main();
