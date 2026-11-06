/**
 * QA E2E (Playwright) — abertura personalizada por usuário.
 *
 * Liga a preferência via API e abre a home: o `theme-init` deve redirecionar para o
 * módulo escolhido uma única vez por sessão da janela. Depois de já estar aberto, clicar
 * em Início não pode jogar o usuário de volta para o módulo. Com a preferência desligada,
 * uma janela nova continua na home.
 *
 * Uso:
 *   node scripts/test-isolated.js src/tests/e2e/user-startup.ts
 */
import { chromium, type Browser, type Page } from 'playwright';
import {
  Reporter,
  setupServer,
  newPage,
  loginApi,
  api,
  unwrap,
  teardown,
  type E2EServer,
} from './harness';

const PORT = Number(process.env.KIVO_PORT ?? 3622);

async function main(): Promise<void> {
  const reporter = new Reporter('Abertura personalizada por usuário');
  let server: E2EServer | undefined;
  let browser: Browser | undefined;

  try {
    server = await setupServer({ port: PORT });
    const base = server.base;
    const admin = await loginApi(base);
    if (!admin) throw new Error('login via API falhou');

    const users = await unwrap<{ id: number; username: string }[]>(await api(base, '/api/users', {}, admin));
    const adminUser = users.find((u) => u.username === 'admin');
    if (!adminUser) throw new Error('usuário admin não encontrado');

    const startup = await unwrap<{ modules: { href: string }[] }>(
      await api(base, `/api/users/${adminUser.id}/startup`, {}, admin),
    );
    const alvo = startup.modules.find((m) => m.href === '/app/store/vendas') ?? startup.modules[0];
    if (!alvo) throw new Error('nenhum módulo disponível para o teste');

    const enable = await api(base, `/api/users/${adminUser.id}`, {
      method: 'PUT',
      body: JSON.stringify({ startup: { enabled: true, moduleHref: alvo.href, fullscreen: false } }),
    }, admin);
    reporter.check('preferência ligada via API', enable.ok, String(enable.status));

    browser = await chromium.launch({ headless: true });
    const page: Page = await newPage(browser, { viewport: { width: 1366, height: 768 } });
    const cookie = admin.split(';')[0];
    const value = cookie.split('=').slice(1).join('=');
    await page.context().addCookies([{
      name: 'kivo_session', value, domain: new URL(base).hostname, path: '/',
    }]);

    // Primeira abertura da janela: home redireciona para o módulo escolhido.
    // O `goto` pode ser interrompido pela navegação do próprio script; o waitForURL é a
    // asserção que importa.
    await page.goto(base + '/', { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
    await page.waitForURL((url) => url.pathname === alvo.href, { timeout: 10000 });
    reporter.check('primeira abertura vai direto para o módulo', new URL(page.url()).pathname === alvo.href, page.url());
    const marcador = await page.evaluate(() => {
      try { return sessionStorage.getItem('kivo-startup-open'); } catch { return null; }
    });
    reporter.check('marca a abertura para não redirecionar de novo', marcador === '1', String(marcador));

    // Voltar para a home na MESMA janela deve respeitar a navegação do usuário.
    await page.goto(base + '/', { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(500);
    reporter.check('depois de aberto, Início não redireciona de novo', new URL(page.url()).pathname === '/', page.url());
    await page.context().close();

    // Preferência desligada: janela nova (sessão limpa) fica na home.
    await api(base, `/api/users/${adminUser.id}`, {
      method: 'PUT',
      body: JSON.stringify({ startup: { enabled: false, moduleHref: alvo.href, fullscreen: false } }),
    }, admin);
    const page2 = await newPage(browser, { viewport: { width: 1366, height: 768 } });
    await page2.context().addCookies([{
      name: 'kivo_session', value, domain: new URL(base).hostname, path: '/',
    }]);
    await page2.goto(base + '/', { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page2.waitForTimeout(700);
    reporter.check('desligada por padrão não redireciona', new URL(page2.url()).pathname === '/', page2.url());
    await page2.context().close();
  } catch (e) {
    console.error('[e2e-user-startup] erro fatal:', e);
    reporter.check('execução sem exceção', false, (e as Error).message);
  } finally {
    if (server) await teardown(server.server, browser);
  }

  reporter.finish();
}

void main();
