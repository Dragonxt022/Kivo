/**
 * QA visual — abre o Katsu num Chromium real (Playwright), loga, visita cada rota
 * informada, e reporta erros de console/página/rede + screenshot de cada uma.
 *
 * Uso:
 *   node scripts/qa-browser.js /app/store/pdv /app/commercial/produtos
 *   node scripts/qa-browser.js --user admin --pass admin /
 *   node scripts/qa-browser.js --dark /app/store/pdv     (força tema escuro)
 *   node scripts/qa-browser.js --mobile /app/store/pdv   (viewport de celular, 390x844)
 *   BASE_URL=http://localhost:3123 node scripts/qa-browser.js /
 *
 * Screenshots em .qa-screenshots/ (gitignored). Requer `npm run dev` já rodando.
 */
const { chromium } = require('playwright');
const path = require('node:path');
const fs = require('node:fs');

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3123';
const OUT_DIR = path.resolve(__dirname, '..', '.qa-screenshots');

function parseArgs(argv) {
  const routes = [];
  let user = 'admin';
  let pass = 'admin';
  let dark = false;
  let mobile = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--user') user = argv[++i];
    else if (argv[i] === '--pass') pass = argv[++i];
    else if (argv[i] === '--dark') dark = true;
    else if (argv[i] === '--mobile') mobile = true;
    else routes.push(argv[i]);
  }
  return { routes: routes.length ? routes : ['/'], user, pass, dark, mobile };
}

async function main() {
  const { routes, user, pass, dark, mobile } = parseArgs(process.argv.slice(2));
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const browser = await chromium.launch();
  const context = await browser.newContext(
    mobile
      ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }
      : { viewport: { width: 1400, height: 900 } },
  );
  if (dark) {
    // theme-init.ejs lê isso do localStorage antes de pintar a página — precisa estar
    // presente ANTES do 1º load, daí addInitScript (roda em toda navegação futura).
    await context.addInitScript(() => localStorage.setItem('katsu-theme', 'dark'));
  }
  const page = await context.newPage();

  const results = [];
  let current = null;

  page.on('console', (msg) => {
    if (msg.type() === 'error' && current) current.consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => {
    if (current) current.pageErrors.push(err.message);
  });
  page.on('response', (res) => {
    if (current && res.status() >= 400 && !res.url().includes('favicon')) {
      current.failedRequests.push(`${res.status()} ${res.request().method()} ${res.url()}`);
    }
  });

  // Login real via UI (exercita o próprio formulário de login, não só a API).
  // O próprio login já navega para "/" (home.ejs faz location.href = '/' no sucesso),
  // então esperamos essa navegação assentar aqui — senão o goto() da 1a rota do loop
  // corre contra ela e o Chromium aborta com net::ERR_ABORTED.
  await page.goto(`${BASE_URL}/?login=1`, { waitUntil: 'load' });
  await page.fill('#login-user', user);
  await page.fill('#login-pass', pass);
  await Promise.all([
    page.waitForURL(`${BASE_URL}/`, { waitUntil: 'load', timeout: 10000 }),
    page.click('button[type="submit"]'),
  ]);

  for (const route of routes) {
    current = { route, consoleErrors: [], pageErrors: [], failedRequests: [] };
    results.push(current);
    try {
      await page.goto(`${BASE_URL}${route}`, { waitUntil: 'load', timeout: 15000 });
      await page.waitForTimeout(300); // dá tempo pro Alpine terminar x-init/fetch
      const base = (route.replace(/[/?]/g, '_').replace(/^_+/, '') || 'home') + (dark ? '.dark' : '') + (mobile ? '.mobile' : '');
      const file = path.join(OUT_DIR, base) + '.png';
      await page.screenshot({ path: file, fullPage: true });
      current.screenshot = file;
      current.title = await page.title();
      // Redirect silencioso (ex.: gate de licença/capability mandando de volta pra "/")
      // não conta como erro de rede/console — precisa comparar a URL final à pedida.
      const finalPath = new URL(page.url()).pathname;
      if (route !== '/' && finalPath !== route) {
        current.redirectedTo = finalPath;
      }
    } catch (e) {
      current.navError = e.message;
    }
  }

  await browser.close();

  console.log('\n=== QA report ===\n');
  let hasIssues = false;
  for (const r of results) {
    const issues = r.consoleErrors.length + r.pageErrors.length + r.failedRequests.length
      + (r.navError ? 1 : 0) + (r.redirectedTo ? 1 : 0);
    console.log(`${issues ? '✗' : '✓'} ${r.route}  ${r.title ? `(${r.title})` : ''}`);
    if (r.navError) { console.log(`    erro de navegação: ${r.navError}`); hasIssues = true; }
    if (r.redirectedTo) { console.log(`    redirecionado para: ${r.redirectedTo} (bloqueado por auth/licença/capability?)`); hasIssues = true; }
    for (const e of r.consoleErrors) { console.log(`    [console] ${e}`); hasIssues = true; }
    for (const e of r.pageErrors) { console.log(`    [page error] ${e}`); hasIssues = true; }
    for (const e of r.failedRequests) { console.log(`    [request] ${e}`); hasIssues = true; }
    if (r.screenshot) console.log(`    screenshot: ${r.screenshot}`);
  }
  console.log(`\n${results.length} rota(s) visitadas, ${hasIssues ? 'com problemas acima' : 'sem erros'}.`);
  process.exit(hasIssues ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
