/**
 * QA E2E (Playwright) — PDV / vendas.
 *
 * Fluxo real de balcão pela UI: abrir o caixa, buscar o produto pelo código/nome, jogar
 * no carrinho, pagar no PIX e confirmar — e conferir, pela API, que a venda e o caixa
 * ficaram certos.
 *
 * Uso:
 *   node scripts/test-isolated.js src/tests/e2e/pdv-venda.ts
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

const PORT = Number(process.env.KIVO_PORT ?? 3602);
const SHOTS = snapDir('e2e-pdv');
const PRECO_CENTS = 700;
const FUNDO_CENTS = 10000;

interface ProdutoRow {
  id: number;
}
interface SaleRow {
  id: number;
  total_cents: number;
  status: string;
}

async function wait(page: Page, ms = 400): Promise<void> {
  await page.waitForTimeout(ms);
}

async function main(): Promise<void> {
  const reporter = new Reporter('PDV/Vendas');
  let server: E2EServer | undefined;
  let browser: Browser | undefined;

  try {
    server = await setupServer({ port: PORT });
    const base = server.base;
    const admin = await loginApi(base);
    if (!admin) throw new Error('login admin falhou');

    // ─── Preparo por API (o foco do teste é a tela do PDV, não o cadastro) ───
    const abertura = await api(base, '/api/finance/cash/open', {
      method: 'POST',
      body: JSON.stringify({ openingCents: FUNDO_CENTS }),
    }, admin);
    reporter.check('caixa aberto para permitir a venda', abertura.status === 201, String(abertura.status));

    const produto = await unwrap<ProdutoRow>(
      await api(base, '/api/commercial/products', {
        method: 'POST',
        body: JSON.stringify({
          name: 'Refrigerante Lata',
          sku: 'REF-350',
          unit: 'un',
          priceCents: PRECO_CENTS,
          costCents: 350,
          trackStock: true,
          initialStock: 50,
          productType: 'fisico',
        }),
      }, admin),
    );
    reporter.check('produto de teste criado', !!produto.id);

    // ─── UI ───
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

    reporter.section('Buscar e adicionar ao carrinho');
    await page.goto(`${base}/app/store/pdv`, { waitUntil: 'load', timeout: 20000 });
    await page.waitForSelector('.pdv-search-box input', { state: 'visible', timeout: 10000 });

    await page.fill('.pdv-search-box input', 'Refrigerante');
    await page.waitForSelector('.pdv-results .pdv-result', { state: 'visible', timeout: 8000 });
    const primeiroResultado = (await page.locator('.pdv-results .pdv-result .name').first().innerText()).trim();
    reporter.check('busca do PDV encontra o produto', primeiroResultado === 'Refrigerante Lata', primeiroResultado);
    await snap(page, SHOTS, 'busca-produto');

    await page.locator('.pdv-results .pdv-result').first().click();
    await wait(page, 500);
    const carrinho = await page.locator('.cart-items').innerText();
    reporter.check('produto entra no carrinho', carrinho.includes('Refrigerante Lata'));
    const contador = await page.locator('.cart-header .count').innerText();
    reporter.check('carrinho conta 1 item', contador.includes('(1)'), contador);
    await snap(page, SHOTS, 'carrinho-com-item');

    reporter.section('Pagamento em dinheiro');
    const finalizar = page.locator('#tour-pdv-finalizar');
    reporter.check('botão finalizar habilita com o carrinho cheio', await finalizar.isEnabled());
    await finalizar.click();
    await page.waitForSelector('dialog[x-ref="pay"][open]', { state: 'visible', timeout: 8000 });
    reporter.check('modal de pagamento abre', true);

    // Dinheiro (e não PIX): só pagamento em espécie mexe na gaveta e gera movimento de
    // caixa — é o que permite conferir o efeito da venda no caixa no fim.
    await page.locator('.pay-quick-method:has-text("Dinheiro")').first().click();
    await page.locator('.pay-method-row button:has-text("Adicionar")').click();
    await wait(page, 400);

    const resumo = await page.locator('.pay-items-list').innerText();
    reporter.check('pagamento em dinheiro lançado no resumo', resumo.toLowerCase().includes('dinheiro'), resumo.trim());
    reporter.check('banner "pronta para finalizar" aparece', await page.locator('.pay-ready-banner').isVisible());
    const confirmar = page.locator('.pay-confirm-btn');
    reporter.check('botão confirmar venda habilita', await confirmar.isEnabled());
    await snap(page, SHOTS, 'pagamento-dinheiro');

    await confirmar.click();
    await page.waitForSelector('dialog[x-ref="postSale"][open]', { state: 'visible', timeout: 10000 });
    reporter.check(
      'modal pós-venda confirma a finalização',
      (await page.locator('dialog[x-ref="postSale"]').innerText()).includes('Venda finalizada'),
    );
    await snap(page, SHOTS, 'pos-venda');
    await page.locator('dialog[x-ref="postSale"] button:has-text("Não")').click();
    await wait(page, 300);

    // ─── Conferência pela API ───
    reporter.section('Conferência na API');
    const vendas = await unwrap<SaleRow[]>(await api(base, '/api/store/sales', {}, admin));
    const venda = vendas.find((v) => v.total_cents === PRECO_CENTS && v.status === 'concluida');
    reporter.check('venda registrada com o total correto', !!venda, `total=${venda?.total_cents}`);
    const carrinhoVazio = await page.locator('.cart-items').innerText();
    reporter.check('carrinho é limpo após a venda', !carrinhoVazio.includes('Refrigerante Lata'));

    const caixa = await unwrap<{ open: boolean; expectedCents: number }>(
      await api(base, '/api/finance/cash/current', {}, admin),
    );
    reporter.check('caixa continua aberto', caixa.open === true);
    reporter.check(
      'esperado na gaveta = fundo + venda',
      caixa.expectedCents === FUNDO_CENTS + PRECO_CENTS,
      `${caixa.expectedCents}`,
    );

    const movimentos = await unwrap<{ type: string }[]>(
      await api(base, '/api/finance/cash/movements', {}, admin),
    );
    reporter.check(
      'movimento de venda lançado no caixa',
      movimentos.some((m) => m.type === 'venda'),
      movimentos.map((m) => m.type).join(', '),
    );
  } catch (e) {
    console.error('[e2e-pdv] erro fatal:', e);
    reporter.check('execução sem exceção', false, (e as Error).message);
  } finally {
    if (server) await teardown(server.server, browser);
  }

  reporter.finish();
}

void main();
