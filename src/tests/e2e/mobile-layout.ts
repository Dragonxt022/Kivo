/**
 * QA E2E (Playwright) — Layout no celular.
 *
 * O app desktop é acessado pelo celular na rede local. Este teste abre as telas principais
 * num viewport de 390x844 e falha quando a página estoura a largura (scroll horizontal) ou
 * quando um elemento do conteúdo passa da borda direita sem estar dentro de um contêiner
 * rolável de propósito.
 *
 * Uso:
 *   node scripts/test-isolated.js src/tests/e2e/mobile-layout.ts
 */
import type { Browser } from 'playwright';
import {
  Reporter,
  setupServer,
  openBrowser,
  newPage,
  loginUi,
  snapDir,
  snap,
  teardown,
  api,
  loginApi,
  unwrap,
  type E2EServer,
} from './harness';

const PORT = Number(process.env.KIVO_PORT ?? 3606);
const SHOTS = snapDir('e2e-mobile-layout');

interface ProdutoRow {
  id: number;
}

const ROTAS: [string, string][] = [
  ['home', '/'],
  ['produtos', '/app/commercial/produtos'],
  ['clientes', '/app/commercial/clientes'],
  ['categorias', '/app/commercial/categorias'],
  ['fornecedores', '/app/commercial/fornecedores'],
  ['listas-de-preco', '/app/commercial/listas-de-preco'],
  ['compras', '/app/commercial/compras'],
  ['pdv', '/app/store/pdv'],
  ['vendas', '/app/store/vendas'],
  ['orcamentos', '/app/store/orcamentos'],
  ['caixa', '/app/finance/caixa'],
  ['pagar', '/app/finance/pagar'],
  ['receber', '/app/finance/receber'],
  ['fluxo', '/app/finance/fluxo'],
  ['formas-pagamento', '/app/finance/formas-pagamento'],
  ['convenios', '/app/finance/convenios'],
  ['reconciliacao', '/app/finance/reconciliacao'],
  ['dre', '/app/dre/relatorio'],
  ['dre-categorias', '/app/dre/categorias'],
  ['comandas-mesas', '/app/comandas/mesas'],
  ['cozinha', '/app/foodservice/cozinha'],
  ['notificacoes', '/notificacoes'],
  ['usuarios', '/admin/usuarios'],
  ['cargos', '/admin/cargos'],
  ['auditoria', '/admin/auditoria'],
  ['backup', '/admin/backup'],
  ['configuracoes', '/admin/configuracoes'],
];

async function main(): Promise<void> {
  const reporter = new Reporter('Layout mobile');
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
    const admin = await loginApi(base);
    if (!admin) throw new Error('login admin falhou');

    await api(base, '/api/finance/cash/open', {
      method: 'POST',
      body: JSON.stringify({ openingCents: 10000 }),
    }, admin);

    const nomes = ['Refrigerante Lata', 'Arroz Tipo 1 5kg', 'Café Torrado 500g'];
    for (const [i, name] of nomes.entries()) {
      await api(base, '/api/commercial/products', {
        method: 'POST',
        body: JSON.stringify({
          name,
          sku: `SKU-${i + 1}`,
          unit: 'un',
          priceCents: 1000 + i * 500,
          trackStock: true,
          initialStock: 20,
          productType: 'fisico',
        }),
      }, admin);
    }
    await api(base, '/api/commercial/customers', {
      method: 'POST',
      body: JSON.stringify({ name: 'Maria Aparecida de Souza Oliveira', phone: '(69) 99999-0000' }),
    }, admin);

    // Uma venda, para a lista de vendas não ficar vazia.
    const prods = await unwrap<ProdutoRow[]>(await api(base, '/api/commercial/products', {}, admin));
    const methods = await unwrap<{ id: number; type: string }[]>(await api(base, '/api/store/payment-methods', {}, admin));
    const dinheiro = methods.find((m) => m.type === 'dinheiro')!;
    await api(base, '/api/store/sales', {
      method: 'POST',
      body: JSON.stringify({
        items: [{ productId: prods[0].id, qty: 2, unitPriceCents: 1000 }],
        payments: [{ methodId: dinheiro.id, amountCents: 2000 }],
      }),
    }, admin);

    browser = await openBrowser();
    const page = await newPage(browser, { viewport: { width: 390, height: 844 } });
    await loginUi(page, base);

    for (const [nome, rota] of ROTAS) {
      await page.goto(`${base}${rota}`, { waitUntil: 'load', timeout: 20000 });
      await page.waitForTimeout(600);

      const info = await page.evaluate(() => {
        // `globalThis` em vez de `document`/`getComputedStyle` diretos: o tsconfig do
        // projeto não traz a lib DOM (o código de produção roda no Node), e este callback
        // roda no navegador.
        type El = {
          tagName: string;
          className: unknown;
          parentElement: El | null;
          getBoundingClientRect(): { width: number; height: number; right: number; left: number };
        };
        const g = globalThis as unknown as {
          document: {
            documentElement: { clientWidth: number; scrollWidth: number };
            querySelectorAll(sel: string): ArrayLike<El>;
          };
          getComputedStyle(el: El): { overflowX: string };
        };
        const root = g.document.documentElement;
        const vw = root.clientWidth;
        const docW = root.scrollWidth;
        const offenders: string[] = [];
        const els = g.document.querySelectorAll('main *, dialog[open] *');
        for (let i = 0; i < els.length; i++) {
          const el = els[i];
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue;
          if (r.right <= vw + 1 && r.left >= -1) continue;
          let p = el.parentElement;
          let rolavel = false;
          while (p) {
            const cs = g.getComputedStyle(p);
            if (cs.overflowX === 'auto' || cs.overflowX === 'scroll') {
              rolavel = true;
              break;
            }
            p = p.parentElement;
          }
          if (rolavel) continue;
          const cls = typeof el.className === 'string' ? el.className.split(' ')[0] : '';
          offenders.push(`${el.tagName.toLowerCase()}.${cls} (right=${Math.round(r.right)})`);
        }
        return { vw, docW, offenders: [...new Set(offenders)].slice(0, 8), count: offenders.length };
      });

      const estoura = info.docW > info.vw + 1;
      const finalPath = new URL(page.url()).pathname;
      const redirecionou = rota !== '/' && finalPath !== rota;
      reporter.check(
        `"${nome}" abre sem estourar a largura (${info.docW}px vs ${info.vw}px)`,
        !estoura && !redirecionou,
        redirecionou ? `redirecionado para ${finalPath}` : estoura ? info.offenders.join(', ') : '',
      );
      await snap(page, SHOTS, `mobile-${nome}`);
    }
  } catch (e) {
    console.error('[e2e-mobile-layout] erro fatal:', e);
    reporter.check('execução sem exceção', false, (e as Error).message);
  } finally {
    if (server) await teardown(server.server, browser);
  }

  reporter.finish();
}

void main();
