/**
 * QA E2E (Playwright) — Estoque / Compras.
 *
 * Lança uma compra pela tela de Compras, recebe o rascunho pelo Histórico (com a confirmação
 * do usuário) e confere que o estoque subiu e que o movimento de entrada foi gravado.
 *
 * Uso:
 *   node scripts/test-isolated.js src/tests/e2e/estoque-compras.ts
 */
import type { Browser, Page } from 'playwright';
import {
  Reporter,
  setupServer,
  openBrowser,
  newPage,
  snapDir,
  snap,
  teardown,
  api,
  loginApi,
  unwrap,
  type E2EServer,
} from './harness';

const PORT = Number(process.env.KIVO_PORT ?? 3604);
const SHOTS = snapDir('e2e-compras');
const ESTOQUE_INICIAL = 10;
const QTD_COMPRA = 20;
const CUSTO_UNIT_CENTS = 2000;

interface IdRow {
  id: number;
}
interface ProdutoListRow {
  id: number;
  name: string;
  stock_qty: number;
}
interface MovimentoRow {
  type: string;
  qty: number;
}

async function wait(page: Page, ms = 500): Promise<void> {
  await page.waitForTimeout(ms);
}

async function main(): Promise<void> {
  const reporter = new Reporter('Estoque/Compras');
  let server: E2EServer | undefined;
  let browser: Browser | undefined;

  try {
    server = await setupServer({ port: PORT });
    const base = server.base;
    const admin = await loginApi(base);
    if (!admin) throw new Error('login admin falhou');

    const fornecedor = await unwrap<IdRow>(
      await api(base, '/api/commercial/suppliers', {
        method: 'POST',
        body: JSON.stringify({ name: 'Distribuidora Teste' }),
      }, admin),
    );
    reporter.check('fornecedor de teste criado', !!fornecedor.id);

    const produto = await unwrap<IdRow>(
      await api(base, '/api/commercial/products', {
        method: 'POST',
        body: JSON.stringify({
          name: 'Arroz Tipo 1 5kg',
          sku: 'ARR-5',
          unit: 'un',
          priceCents: 3000,
          costCents: CUSTO_UNIT_CENTS,
          trackStock: true,
          initialStock: ESTOQUE_INICIAL,
          productType: 'fisico',
        }),
      }, admin),
    );
    reporter.check('produto de teste criado com estoque inicial', !!produto.id);

    browser = await openBrowser();
    const page = await newPage(browser);
    await page.goto(`${base}/?login=1`, { waitUntil: 'load', timeout: 20000 });
    await page.waitForSelector('#login-user', { state: 'visible', timeout: 10000 });
    await page.fill('#login-user', 'admin');
    await page.fill('#login-pass', 'admin');
    await Promise.all([
      page.waitForURL(`${base}/`, { waitUntil: 'load', timeout: 20000 }),
      page.click('.login-card button[type="submit"]'),
    ]);

    reporter.section('Lançar a compra');
    await page.goto(`${base}/app/commercial/compras`, { waitUntil: 'load', timeout: 20000 });
    await page.waitForSelector('.ps-list-row', { state: 'visible', timeout: 10000 });
    await page.locator('.ps-list-row:has-text("Arroz Tipo 1 5kg") .ps-list-add').click();
    await page.waitForSelector('dialog[x-ref="addDlg"][open]', { state: 'visible', timeout: 8000 });

    await page.fill('dialog[x-ref="addDlg"] input[x-ref="addQtyInput"]', String(QTD_COMPRA));
    await page.fill('dialog[x-ref="addDlg"] input[x-model="addForm.unitCostStr"]', '20,00');
    await page.locator('dialog[x-ref="addDlg"] button:has-text("Adicionar ao carrinho")').click();
    await wait(page, 600);
    const carrinho = await page.locator('.ps-cart').innerText();
    reporter.check('item entra no carrinho da compra', carrinho.includes('Arroz Tipo 1 5kg'));
    await snap(page, SHOTS, 'carrinho-compra');

    await page.selectOption('select[x-model\\.number="checkoutSupplierId"]', { label: 'Distribuidora Teste' });
    await page.locator('button:has-text("Finalizar compra")').click();
    await page.waitForSelector('dialog[x-ref="paymentDlg"][open]', { state: 'visible', timeout: 8000 });
    await page.locator('dialog[x-ref="paymentDlg"] button:has-text("Confirmar compra")').click();
    await wait(page, 1200);
    reporter.check('carrinho é esvaziado após finalizar', (await page.locator('.ps-cart').innerText()).includes('Carrinho vazio'));
    await snap(page, SHOTS, 'compra-finalizada');

    reporter.section('Receber a compra');
    await page.locator('button:has-text("Histórico")').click();
    await wait(page, 700);
    const linha = page.locator('tr:has-text("Distribuidora Teste")').first();
    reporter.check('compra aparece no histórico', await linha.isVisible());
    reporter.check('compra nasce como rascunho', (await linha.innerText()).includes('rascunho'), (await linha.innerText()).replace(/\s+/g, ' '));
    await snap(page, SHOTS, 'historico-rascunho');

    await linha.locator('button[title="Mais ações"]').click();
    await wait(page, 300);
    await page.locator('button:has-text("Receber")').first().click();
    await page.waitForSelector('#confirm-dlg[open]', { state: 'visible', timeout: 8000 });
    await page.locator('#confirm-ok').click();
    await wait(page, 1200);
    reporter.check(
      'compra passa a "recebida" no histórico',
      (await page.locator('tr:has-text("Distribuidora Teste")').first().innerText()).includes('recebida'),
    );
    await snap(page, SHOTS, 'compra-recebida');

    reporter.section('Conferência pela API');
    const produtos = await unwrap<ProdutoListRow[]>(
      await api(base, '/api/commercial/products?q=Arroz', {}, admin),
    );
    const atual = produtos.find((p) => p.id === produto.id);
    reporter.check(
      'estoque sobe com a quantidade recebida',
      atual?.stock_qty === ESTOQUE_INICIAL + QTD_COMPRA,
      `estoque=${atual?.stock_qty}`,
    );

    const movimentos = await unwrap<MovimentoRow[]>(
      await api(base, `/api/commercial/stock/movements?productId=${produto.id}`, {}, admin),
    );
    const entrada = movimentos.find((m) => m.type === 'entrada' && m.qty === QTD_COMPRA);
    reporter.check('movimento de entrada gravado no estoque', !!entrada, JSON.stringify(movimentos[0] ?? {}));
  } catch (e) {
    console.error('[e2e-compras] erro fatal:', e);
    reporter.check('execução sem exceção', false, (e as Error).message);
  } finally {
    if (server) await teardown(server.server, browser);
  }

  reporter.finish();
}

void main();
