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
import fs from 'node:fs';
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

  // Cada execução recomeça a numeração dos prints. Sem limpar, sobras de execuções
  // antigas (rotas que mudaram de ordem) ficam misturadas com as novas.
  fs.rmSync(SHOTS, { recursive: true, force: true });
  fs.mkdirSync(SHOTS, { recursive: true });

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
    // O tour de produtos abre sozinho na primeira visita e cobre a tela; aqui ele só
    // atrapalharia o print e o teste de largura. O tour do PDV já é desligado pelo harness.
    await page.addInitScript(() => {
      try {
        localStorage.setItem('kivo-tour-produtos-v1', '1');
      } catch {
        // localStorage indisponível (about:blank): sem consequência.
      }
    });
    await loginUi(page, base);

    for (const [nome, rota] of ROTAS) {
      await page.goto(`${base}${rota}`, { waitUntil: 'load', timeout: 20000 });
      await page.waitForTimeout(600);

      // O PDV só mostra a barra fixa com o carrinho preenchido; coloca um item antes do
      // print e do teste de estouro para exercitar o estado real de uso.
      let pdvItemOk = true;
      if (nome === 'pdv') {
        try {
          await page.locator('.pdv-search-box input').fill('Refrigerante');
          await page.locator('.pdv-result').first().waitFor({ state: 'visible', timeout: 5000 });
          await page.locator('.pdv-result').first().click();
          await page.locator('.pdv-mobile-bar').waitFor({ state: 'visible', timeout: 5000 });
        } catch {
          pdvItemOk = false;
        }
      }

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

      if (nome === 'home') {
        const labels = (await page.locator('.mobile-bottom-nav .mbn-item span').allTextContents()).map((s) => s.trim());
        reporter.check(
          'home: barra inferior com as cinco abas',
          labels.join('|') === 'Início|PDV|Mesas|Vendas|Mais',
          labels.join(', '),
        );
        const navBox = await page.locator('.mobile-bottom-nav').boundingBox();
        reporter.check(
          'home: barra inferior colada na base da tela',
          !!navBox && Math.abs(navBox.y + navBox.height - 844) <= 1,
          navBox ? `${Math.round(navBox.y)}..${Math.round(navBox.y + navBox.height)}` : 'sem caixa',
        );
      }

      if (nome === 'produtos') {
        const cards = await page.locator('table.table-cards').count();
        const titulos = await page.locator('table.table-cards td.table-card-title').count();
        reporter.check(
          'produtos: listagem larga vira cartões',
          cards > 0 && titulos >= 3,
          `tabelas=${cards}, títulos=${titulos}`,
        );

        // Favorito/cardápio e menu são duas células de ação na mesma linha da tabela.
        // No cartão elas precisam dividir um rodapé só; com width:1% inline a primeira
        // encolhia para 3px e os botões transbordavam sobre os detalhes.
        const acoes = await page.locator('table.table-cards tbody tr').first().locator('td.table-card-actions').all();
        const caixas: { x: number; y: number; width: number; height: number }[] = [];
        for (const acao of acoes) {
          const caixa = await acao.boundingBox();
          if (caixa) caixas.push(caixa);
        }
        reporter.check(
          'produtos: ações em um rodapé só',
          caixas.length >= 2
            && caixas[0].width >= 100
            && caixas[1].width >= 100
            && Math.abs(caixas[0].y - caixas[1].y) <= 1,
          caixas.map((c) => `${Math.round(c.width)}x${Math.round(c.height)}@${Math.round(c.y)}`).join(', '),
        );
      }

      if (nome === 'vendas') {
        const selects = await page.locator('.toolbar > select').all();
        const larguras: number[] = [];
        for (const select of selects) {
          const caixa = await select.boundingBox();
          if (caixa) larguras.push(Math.round(caixa.width));
        }
        reporter.check(
          'vendas: filtros de seleção ocupam a linha',
          larguras.length === 2 && larguras.every((w) => w >= 300),
          larguras.join(', '),
        );
      }

      if (nome === 'pagar') {
        const datas = await page.locator('.toolbar input[type=date]:visible').all();
        const larguras: number[] = [];
        for (const data of datas) {
          const caixa = await data.boundingBox();
          if (caixa) larguras.push(Math.round(caixa.width));
        }
        reporter.check(
          'pagar: campos de data largos o bastante para dd/mm/aaaa',
          larguras.length === 2 && larguras.every((w) => w >= 240),
          larguras.join(', '),
        );
      }

      if (nome === 'compras') {
        const layout = await page.evaluate(() => {
          type Rect = { left: number; right: number; top: number; bottom: number; width: number; height: number };
          type El = {
            getBoundingClientRect(): Rect;
            querySelector(sel: string): El | null;
          };
          const g = globalThis as unknown as { document: { querySelector(sel: string): El | null } };
          const row = g.document.querySelector('.ps-list-row');
          if (!row) return null;
          const rr = row.getBoundingClientRect();
          const name = row.querySelector('.ps-list-name');
          const price = row.querySelector('.ps-list-price');
          const add = row.querySelector('.ps-list-add');
          if (!name || !price || !add) return null;
          const nr = name.getBoundingClientRect();
          const pr = price.getBoundingClientRect();
          const ar = add.getBoundingClientRect();
          return {
            nameWidth: Math.round(nr.width),
            dentro: pr.right <= rr.right + 1 && ar.right <= rr.right + 1 && nr.right <= rr.right + 1,
            precoAbaixo: pr.top >= nr.bottom - 1,
          };
        });
        reporter.check(
          'compras: lista em duas fileiras, sem sobreposição',
          !!layout && layout.nameWidth >= 130 && layout.dentro && layout.precoAbaixo,
          layout ? JSON.stringify(layout) : 'sem .ps-list-row',
        );
      }

      if (nome === 'pdv') {
        reporter.check('pdv: item entra no carrinho', pdvItemOk);
        const barBox = pdvItemOk ? await page.locator('.pdv-mobile-bar').boundingBox() : null;
        const navBox = await page.locator('.mobile-bottom-nav').boundingBox();
        reporter.check(
          'pdv: barra fixa de total acima da navegação',
          !!barBox && !!navBox && Math.abs(barBox.y + barBox.height - navBox.y) <= 2 && barBox.width >= 389,
          barBox && navBox
            ? `barra=${Math.round(barBox.y)}..${Math.round(barBox.y + barBox.height)}, nav=${Math.round(navBox.y)}`
            : 'barra ou navegação ausente',
        );

        if (pdvItemOk) {
          await page.locator('.pdv-mobile-bar .btn-finalize').click();
          const dlg = page.locator('dialog[open]').first();
          let abriu = true;
          try {
            await dlg.waitFor({ state: 'visible', timeout: 5000 });
            // A folha sobe com uma animação de 220ms; medir no meio dela daria uma caixa
            // deslocada para baixo (translateY(40px)).
            await page.waitForTimeout(300);
          } catch {
            abriu = false;
          }
          const dlgBox = abriu ? await dlg.boundingBox() : null;
          reporter.check(
            'pdv: pagamento abre como folha inferior dentro da tela',
            abriu && !!dlgBox && dlgBox.x >= -1 && dlgBox.x + dlgBox.width <= 391 && dlgBox.y >= -1 && dlgBox.y + dlgBox.height <= 845,
            dlgBox
              ? `x=${Math.round(dlgBox.x)}, w=${Math.round(dlgBox.width)}, y=${Math.round(dlgBox.y)}, h=${Math.round(dlgBox.height)}`
              : 'diálogo não abriu',
          );
          if (abriu) await page.keyboard.press('Escape');
        }
      }
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
