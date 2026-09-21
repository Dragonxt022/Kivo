/**
 * Captura as telas reais do Kivo para a Wiki (cloud/src/public/img/wiki).
 *
 * Sobe contra o app desktop em dev (`npm run dev`), loga, e tira um screenshot
 * claro e um escuro de cada rota mapeada, em JPEG (viewport 1440x900) — bem mais
 * leve que PNG para versionar no repositório.
 *
 * Pré-requisitos (para as telas de Fiscal/NF-e aparecerem, e não a home):
 *   npm run kivo db:seed:demo   # ~30 dias de operação simulada (dados reais na tela)
 *   # habilite as capabilities fiscal.nfce e nfe.import em Configurações → Recursos
 *   npm run dev                 # em outro terminal (porta 3123)
 *
 * Uso:
 *   node scripts/wiki-shots.js      # grava em cloud/src/public/img/wiki/
 *   BASE_URL=http://localhost:3123 node scripts/wiki-shots.js
 */
const { chromium } = require('playwright');
const path = require('node:path');
const fs = require('node:fs');

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3123';
const OUT_DIR = path.resolve(__dirname, '..', 'cloud', 'src', 'public', 'img', 'wiki');

/** nome do arquivo (sem tema) → rota do app. */
const PAGES = {
  'home': '/',
  'painel': '/app/overview',
  'clientes': '/app/commercial/clientes',
  'fornecedores': '/app/commercial/fornecedores',
  'produtos': '/app/commercial/produtos',
  'categorias': '/app/commercial/categorias',
  'listas-preco': '/app/commercial/listas-de-preco',
  'compras': '/app/commercial/compras',
  'caixa': '/app/finance/caixa',
  'contas-pagar': '/app/finance/pagar',
  'contas-receber': '/app/finance/receber',
  'fluxo-caixa': '/app/finance/fluxo',
  'formas-pagamento': '/app/finance/formas-pagamento',
  'convenios': '/app/finance/convenios',
  'reconciliacao': '/app/finance/reconciliacao',
  'pdv': '/app/store/pdv',
  'vendas': '/app/store/vendas',
  'orcamentos': '/app/store/orcamentos',
  'mesas-comandas': '/app/comandas/mesas',
  'cozinha': '/app/foodservice/cozinha',
  'roteamento-cozinha': '/app/foodservice/roteamento',
  'dre': '/app/dre/relatorio',
  'dre-categorias': '/app/dre/categorias',
  'fiscal-notas': '/app/fiscal/notas',
  'fiscal-config': '/app/fiscal/configuracao',
  'nfe-importar': '/app/nfe/importar',
  'etiquetas': '/app/labels',
  'etiquetas-historico': '/app/labels/historico',
  'notificacoes': '/notificacoes',
  'usuarios': '/admin/usuarios',
  'cargos': '/admin/cargos',
  'auditoria': '/admin/auditoria',
  'backup': '/admin/backup',
  'configuracoes': '/admin/configuracoes',
  'cobrancas': '/admin/cobrancas',
  'recursos': '/admin/recursos',
};

async function login(page) {
  await page.goto(`${BASE_URL}/?login=1`, { waitUntil: 'load' });
  await page.fill('#login-user', 'admin');
  await page.fill('#login-pass', 'admin');
  await Promise.all([
    page.waitForURL(`${BASE_URL}/`, { waitUntil: 'load', timeout: 15000 }),
    page.click('button[type="submit"]'),
  ]);
}

async function captureTheme(browser, theme) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  await context.addInitScript((t) => {
    try { localStorage.setItem('kivo-theme', t); } catch (e) { /* sem storage */ }
  }, theme);
  const page = await context.newPage();
  await login(page);
  let count = 0;
  for (const [name, route] of Object.entries(PAGES)) {
    try {
      await page.goto(`${BASE_URL}${route}`, { waitUntil: 'load', timeout: 20000 });
      await page.waitForTimeout(450); // deixa o Alpine terminar os fetch/x-init
      const file = path.join(OUT_DIR, theme === 'dark' ? `${name}-dark.jpg` : `${name}.jpg`);
      await page.screenshot({ path: file, type: 'jpeg', quality: 82, fullPage: false });
      count++;
      console.log(`  ${theme} ${name} -> ${path.relative(process.cwd(), file)}`);
    } catch (e) {
      console.warn(`  ${theme} ${name}: FALHOU (${e.message})`);
    }
  }
  await context.close();
  return count;
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const browser = await chromium.launch();
  console.log(`Capturando de ${BASE_URL} para ${OUT_DIR}`);
  const light = await captureTheme(browser, 'light');
  const dark = await captureTheme(browser, 'dark');
  await browser.close();
  console.log(`\nConcluído: ${light} claras + ${dark} escuras.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
