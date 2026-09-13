/**
 * QA E2E (Playwright) — Financeiro / Caixa.
 *
 * Exercita o ciclo completo da gaveta pela UI: abrir com fundo de troco, lançar
 * suprimento e sangria, fechar contando o dinheiro e conferir o histórico pela API.
 *
 * Uso:
 *   node scripts/test-isolated.js src/tests/e2e/financeiro-caixa.ts
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

const PORT = Number(process.env.KIVO_PORT ?? 3603);
const SHOTS = snapDir('e2e-caixa');

interface HistoryRow {
  expected_cents: number;
  counted_cents: number;
  difference_cents: number;
  status: string;
}

async function wait(page: Page, ms = 400): Promise<void> {
  await page.waitForTimeout(ms);
}

async function main(): Promise<void> {
  const reporter = new Reporter('Financeiro/Caixa');
  let server: E2EServer | undefined;
  let browser: Browser | undefined;

  try {
    server = await setupServer({ port: PORT });
    const base = server.base;
    const admin = await loginApi(base);
    if (!admin) throw new Error('login admin falhou');

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

    reporter.section('Abrir caixa');
    await page.goto(`${base}/app/finance/caixa`, { waitUntil: 'load', timeout: 20000 });
    await page.waitForSelector('button:has-text("Abrir caixa")', { state: 'visible', timeout: 10000 });
    reporter.check('tela mostra caixa fechado', await page.locator('text=Nenhum caixa aberto').isVisible());
    await snap(page, SHOTS, 'caixa-fechado');

    await page.locator('button:has-text("Abrir caixa")').click();
    await page.waitForSelector('dialog[x-ref="openDlg"][open]', { state: 'visible', timeout: 8000 });
    await page.fill('dialog[x-ref="openDlg"] input[x-model="opening"]', '100,00');
    await page.locator('dialog[x-ref="openDlg"] button:has-text("Abrir")').click();
    await page.waitForSelector('.badge.ok:has-text("aberto")', { state: 'visible', timeout: 8000 });
    reporter.check('caixa aberto com o fundo de troco', true);
    reporter.check(
      'esperado inicial = fundo informado',
      (await page.locator('.toolbar').first().innerText()).includes('R$ 100,00'),
    );
    await snap(page, SHOTS, 'caixa-aberto');

    reporter.section('Suprimento');
    await page.locator('button:has-text("Suprimento")').click();
    await page.waitForSelector('dialog[x-ref="mv"][open]', { state: 'visible', timeout: 8000 });
    await page.fill('dialog[x-ref="mv"] input[x-model="move.amount"]', '50,00');
    await page.fill('dialog[x-ref="mv"] input[x-model="move.description"]', 'Reforço de troco');
    await page.locator('dialog[x-ref="mv"] button:has-text("Confirmar")').click();
    await wait(page, 700);
    reporter.check(
      'suprimento eleva o esperado para R$ 150,00',
      (await page.locator('.toolbar').first().innerText()).includes('R$ 150,00'),
    );
    const tabelaAposSuprimento = await page.locator('table').first().innerText();
    reporter.check('suprimento aparece na lista de movimentos', tabelaAposSuprimento.includes('suprimento'));
    await snap(page, SHOTS, 'apos-suprimento');

    reporter.section('Sangria');
    await page.locator('button:has-text("Sangria")').click();
    await page.waitForSelector('dialog[x-ref="mv"][open]', { state: 'visible', timeout: 8000 });
    await page.fill('dialog[x-ref="mv"] input[x-model="move.amount"]', '30,00');
    await page.fill('dialog[x-ref="mv"] input[x-model="move.description"]', 'Retirada para o cofre');
    await page.locator('dialog[x-ref="mv"] button:has-text("Confirmar")').click();
    await wait(page, 700);
    reporter.check(
      'sangria reduz o esperado para R$ 120,00',
      (await page.locator('.toolbar').first().innerText()).includes('R$ 120,00'),
    );
    reporter.check(
      'sangria aparece na lista de movimentos',
      (await page.locator('table').first().innerText()).includes('sangria'),
    );
    await snap(page, SHOTS, 'apos-sangria');

    reporter.section('Fechar caixa');
    await page.locator('main .toolbar button:has-text("Fechar caixa")').first().click();
    await page.waitForSelector('dialog[x-ref="close"][open]', { state: 'visible', timeout: 8000 });
    await page.fill('dialog[x-ref="close"] input[x-model="counted"]', '120,00');
    await page.locator('dialog[x-ref="close"] .actions button:has-text("Fechar")').click();
    await page.waitForSelector('dialog[x-ref="closeResultDlg"][open]', { state: 'visible', timeout: 8000 });
    const resultado = await page.locator('dialog[x-ref="closeResultDlg"]').innerText();
    reporter.check('resultado do fechamento aparece', resultado.includes('Caixa fechado'));
    reporter.check('esperado do fechamento = R$ 120,00', resultado.includes('R$ 120,00'), resultado.replace(/\s+/g, ' '));
    await snap(page, SHOTS, 'fechamento');
    await page.locator('dialog[x-ref="closeResultDlg"] button:has-text("OK")').click();
    await wait(page, 500);
    reporter.check(
      'volta ao estado "sem caixa aberto"',
      await page.locator('text=Nenhum caixa aberto').isVisible(),
    );

    reporter.section('Histórico pela API');
    const historico = await unwrap<HistoryRow[]>(await api(base, '/api/finance/cash/history', {}, admin));
    const registro = historico.find((h) => h.expected_cents === 12000);
    reporter.check('fechamento gravado no histórico', !!registro, JSON.stringify(historico[0] ?? {}));
    reporter.check('valor contado gravado', registro?.counted_cents === 12000);
    reporter.check('diferença zero (sem quebra de caixa)', registro?.difference_cents === 0);
  } catch (e) {
    console.error('[e2e-caixa] erro fatal:', e);
    reporter.check('execução sem exceção', false, (e as Error).message);
  } finally {
    if (server) await teardown(server.server, browser);
  }

  reporter.finish();
}

void main();
