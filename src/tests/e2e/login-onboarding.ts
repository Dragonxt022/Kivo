/**
 * QA E2E (Playwright) — Login e primeiro acesso.
 *
 * Cobre o que nenhum teste de API enxerga: a tela de "Crie seu acesso" do primeiro boot,
 * a validação de senha fraca no formulário, o login pela UI, o logout pelo menu do usuário
 * e o erro de credencial inválida.
 *
 * Uso:
 *   node scripts/test-isolated.js src/tests/e2e/login-onboarding.ts
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
  type E2EServer,
} from './harness';

const PORT = Number(process.env.KIVO_PORT ?? 3601);
const SHOTS = snapDir('e2e-login');

const NOVA_SENHA = 'Kivo@2026';

async function wait(page: Page, ms = 400): Promise<void> {
  await page.waitForTimeout(ms);
}

async function main(): Promise<void> {
  const reporter = new Reporter('Login/Onboarding');
  let server: E2EServer | undefined;
  let browser: Browser | undefined;

  try {
    server = await setupServer({ port: PORT, firstRun: true });
    browser = await openBrowser();
    const page = await newPage(browser);

    // ─── 1. Primeiro acesso: a tela pede para criar o acesso, não para logar ───
    reporter.section('Primeiro acesso');
    await page.goto(`${server.base}/?login=1`, { waitUntil: 'load', timeout: 20000 });
    await page.waitForSelector('#setup-user', { state: 'visible', timeout: 10000 });
    reporter.check('tela "Crie seu acesso" aparece no primeiro boot', true);
    reporter.check('formulário de login NÃO é exibido', (await page.locator('#login-user').count()) === 0);
    await snap(page, SHOTS, 'primeiro-acesso');

    // ─── 2. Senha fraca é recusada pelo próprio formulário ───
    reporter.section('Validação de senha');
    await page.fill('#setup-name', 'Maria Teste');
    await page.fill('#setup-user', 'maria');
    await page.fill('#setup-pass', '123');
    await page.fill('#setup-pass2', '123');
    await page.click('.login-card button[type="submit"]');
    await wait(page, 700);
    const erroSenha = (await page.locator('.login-card .error').first().innerText()).trim();
    reporter.check('senha fraca é recusada com mensagem', erroSenha.length > 0, erroSenha);
    reporter.check('continua na tela de primeiro acesso', await page.locator('#setup-user').isVisible());
    await snap(page, SHOTS, 'senha-fraca-recusada');

    // ─── 3. Criação válida entra direto na home ───
    reporter.section('Criar acesso e entrar');
    await page.fill('#setup-pass', NOVA_SENHA);
    await page.fill('#setup-pass2', NOVA_SENHA);
    await Promise.all([
      page.waitForURL(`${server.base}/`, { waitUntil: 'load', timeout: 20000 }),
      page.click('.login-card button[type="submit"]'),
    ]);
    await page.waitForSelector('.app-grid', { state: 'visible', timeout: 10000 });
    reporter.check('acesso criado e sessão iniciada', page.url() === `${server.base}/`);
    const cards = await page.locator('.app-grid .app-card .card-title').count();
    reporter.check('home renderiza os cards de aplicativo', cards > 0, `${cards} card(s)`);
    await snap(page, SHOTS, 'home-pos-setup');

    // ─── 4. Logout pelo menu do usuário ───
    reporter.section('Logout');
    await page.click('button[title="Sair / trocar usuário"]');
    await wait(page, 400);
    const sair = page.locator('dialog[x-ref="userDlg"] button:has-text("Sair")').last();
    reporter.check('menu do usuário abre com a opção Sair', await sair.isVisible());
    // "Sair" recarrega a própria `/` (não muda a URL), então não dá para esperar por
    // navegação — o sinal de sucesso é o overlay de login voltar a ficar visível.
    await Promise.all([
      page.waitForSelector('#login-user', { state: 'visible', timeout: 20000 }),
      sair.click(),
    ]);
    reporter.check('logout volta para o formulário de login', true);
    await snap(page, SHOTS, 'apos-logout');

    // ─── 5. Credencial inválida mostra erro ───
    reporter.section('Credencial inválida');
    await page.fill('#login-user', 'maria');
    await page.fill('#login-pass', 'senha-errada');
    await page.click('.login-card button[type="submit"]');
    await wait(page, 900);
    const erroLogin = (await page.locator('.login-card .error').first().innerText()).trim();
    reporter.check('login inválido exibe erro', erroLogin.length > 0, erroLogin);
    reporter.check('não autenticou com senha errada', await page.locator('#login-user').isVisible());
    await snap(page, SHOTS, 'login-invalido');

    // ─── 6. Credencial correta entra na home ───
    reporter.section('Login válido');
    await page.fill('#login-pass', NOVA_SENHA);
    await Promise.all([
      page.waitForURL(`${server.base}/`, { waitUntil: 'load', timeout: 20000 }),
      page.click('.login-card button[type="submit"]'),
    ]);
    await page.waitForSelector('.app-grid', { state: 'visible', timeout: 10000 });
    reporter.check('login com a senha criada funciona', page.url() === `${server.base}/`);
    reporter.check(
      'saudação com o nome do usuário aparece',
      (await page.locator('.greeting h1').innerText()).includes('Maria Teste'),
    );
    await snap(page, SHOTS, 'home-logado');
  } catch (e) {
    console.error('[e2e-login] erro fatal:', e);
    reporter.check('execução sem exceção', false, (e as Error).message);
  } finally {
    if (server) await teardown(server.server, browser);
  }

  reporter.finish();
}

void main();
