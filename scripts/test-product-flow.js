/**
 * Teste E2E do fluxo de cadastro de produto via UI
 * Uso: node scripts/test-product-flow.js
 * Requer: npm run dev rodando (localhost:3123)
 */
const { chromium } = require('playwright');
const path = require('node:path');
const fs = require('node:fs');

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3123';
const OUT_DIR = path.resolve(__dirname, '..', '.qa-screenshots');

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();

  let errors = [];

  page.on('console', msg => {
    if (msg.type() === 'error') errors.push(`[console] ${msg.text()}`);
  });
  page.on('pageerror', err => errors.push(`[pageerror] ${err.message}`));
  page.on('response', res => {
    if (res.status() >= 400 && !res.url().includes('favicon')) {
      errors.push(`[request ${res.status()}] ${res.request().method()} ${res.url()}`);
    }
  });

  async function screenshot(name) {
    await page.screenshot({ path: path.join(OUT_DIR, `${name}.png`), fullPage: true });
  }

  try {
    // 1. Login
    console.log('1. Login...');
    await page.goto(`${BASE_URL}/?login=1`, { waitUntil: 'load' });
    await page.fill('#login-user', 'admin');
    await page.fill('#login-pass', 'admin');
    await Promise.all([
      page.waitForURL(`${BASE_URL}/`, { waitUntil: 'load', timeout: 10000 }),
      page.click('button[type="submit"]'),
    ]);
    await screenshot('01-login');

    // 2. Ir para produtos
    console.log('2. Abrir página de produtos...');
    await page.goto(`${BASE_URL}/app/commercial/produtos`, { waitUntil: 'load', timeout: 15000 });
    await page.waitForTimeout(500);
    await screenshot('02-produtos-list');

    // 3. Clicar "Novo produto"
    console.log('3. Clicar Novo produto...');
    await page.click('button:has-text("Novo produto")');
    await page.waitForSelector('dialog.product-modal[open]', { timeout: 5000 });
    await screenshot('03-modal-open');

    // 4. Preencher campos obrigatórios
    console.log('4. Preencher formulário...');
    await page.fill('input[x-model="form.name"]', 'Hambúrguer Artesanal Teste');
    await page.fill('input[x-model="form.sku"]', 'HBG-TEST-001');
    await page.fill('input[x-model="form.unit"]', 'un');
    await page.fill('input[x-model="form.price"]', '29,90');
    await page.fill('input[x-model="form.cost"]', '12,00');

    // Selecionar categoria (primeira disponível)
    await page.selectOption('select[x-model.number="form.categoryId"]', { index: 1 });
    await page.waitForTimeout(200);

    // Selecionar tipo "Produto simples" (já é o padrão)
    await screenshot('04-form-filled');

    // 5. Salvar
    console.log('5. Salvar...');
    await Promise.all([
      page.waitForResponse(r => r.url().includes('/api/commercial/products') && r.status() === 201, { timeout: 10000 }),
      page.click('dialog.product-modal button:has-text("Salvar")'),
    ]);
    await screenshot('05-saved');

    // 6. Verificar se apareceu na lista
    console.log('6. Verificar na lista...');
    await page.waitForTimeout(500);
    const row = await page.locator('table tbody tr:has-text("Hambúrguer Artesanal Teste")').first();
    await row.waitFor({ state: 'visible', timeout: 5000 });
    await screenshot('06-list-verification');

    // 7. Testar complementos - abrir edição
    console.log('7. Testar complementos (editar)...');
    await row.click();
    await page.waitForSelector('dialog.product-modal[open]', { timeout: 5000 });
    await screenshot('07-edit-modal');

    // Verificar se seção "Complementos / adicionais" está visível
    const complementSection = await page.locator('.complement-link-box');
    await complementSection.waitFor({ state: 'visible', timeout: 3000 });
    console.log('   ✓ Seção de complementos visível para produto simples!');

    // 8. Clicar "Vincular grupo"
    console.log('8. Vincular grupo de complemento...');
    await page.click('.complement-link-box button:has-text("Vincular grupo")');
    await page.waitForSelector('dialog:has-text("Vincular grupo de complementos")[open]', { timeout: 5000 });
    await screenshot('08-link-complement-modal');

    // Fechar modal de vincular (sem criar grupo agora)
    await page.click('dialog:has-text("Vincular grupo de complementos") button:has-text("Fechar")');
    await page.waitForTimeout(300);

    // 9. Fechar modal de edição
    console.log('9. Fechar modal...');
    await page.click('dialog.product-modal button:has-text("Cancelar")');
    await page.waitForTimeout(300);

    // 10. Testar abas Vendáveis/Complementos
    console.log('10. Testar abas...');
    await page.click('.product-tabs button:has-text("Complementos")');
    await page.waitForTimeout(300);
    await screenshot('10-tab-complementos');

    await page.click('.product-tabs button:has-text("Produtos")');
    await page.waitForTimeout(300);
    await screenshot('11-tab-produtos');

    console.log('\n✅ FLUXO COMPLETO COM SUCESSO!');
    if (errors.length) {
      console.log('\n⚠️  Erros não-fatais capturados:');
      errors.forEach(e => console.log('  -', e));
    }

  } catch (e) {
    console.error('\n❌ ERRO NO TESTE:', e.message);
    await screenshot('error-state');
    errors.push(e.message);
  }

  await browser.close();

  if (errors.length > 0) {
    console.log('\n=== RESUMO DE ERROS ===');
    errors.forEach(e => console.log('  -', e));
    process.exit(1);
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});