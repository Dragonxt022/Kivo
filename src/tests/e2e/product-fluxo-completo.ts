/**
 * Teste E2E (Playwright) — Fluxo completo de cadastro de produtos.
 *
 * Roda contra um servidor Express recém-iniciado com DB de teste limpo.
 * Usa Playwright como biblioteca (não @playwright/test) para manter
 * consistência com o resto do projeto (testes sem framework).
 *
 * Uso:
 *   npx tsx src/tests/e2e/product-fluxo-completo.ts
 */

import { chromium, type Page } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { migrateUp } from '../../core/database/migrator';
import { runSeeds } from '../../core/database/seeds';
import { getSqlite, closeDb } from '../../core/database/connection';
import { createServer } from '../../core/server';
import { resetTestDb, activateTestLicense } from '../resetTestDb';

const PORT = Number(process.env.KIVO_PORT ?? 3599);
const BASE = `http://localhost:${PORT}`;
const SCREENSHOT_DIR = path.resolve(process.cwd(), '.qa-screenshots', 'e2e-products');

let failures = 0;
let screenshotCounter = 0;

function check(label: string, ok: boolean, extra = '') {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${label}${extra ? ' — ' + extra : ''}`);
  if (!ok) failures++;
}

async function snap(page: Page, label: string) {
  screenshotCounter++;
  const name = `${String(screenshotCounter).padStart(3, '0')}_${label.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60)}.png`;
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, name), fullPage: true });
}

async function wait(page: Page, ms = 600) {
  await page.waitForTimeout(ms);
}

// ─── Server Setup ──────────────────────────────────────────────────────────
async function startServer() {
  resetTestDb();
  migrateUp();
  runSeeds();
  activateTestLicense();

  const db = getSqlite();
  const CAPS = [
    { key: 'commercial.variantes', description: 'Produtos com variantes' },
    { key: 'commercial.complementos', description: 'Grupos de complementos' },
    { key: 'commercial.kits', description: 'Kits e combos' },
    { key: 'commercial.producao', description: 'Ficha técnica' },
    { key: 'commercial.cardapio_online', description: 'Cardápio online' },
  ];
  for (const cap of CAPS) {
    const existing = db.prepare('SELECT id FROM capabilities WHERE key = ?').get(cap.key) as { id: number } | undefined;
    if (!existing) {
      db.prepare('INSERT INTO capabilities (key, description, module, enabled, uuid) VALUES (?, ?, ?, 1, ?)')
        .run(cap.key, cap.description, 'commercial', randomUUID());
    } else {
      db.prepare('UPDATE capabilities SET enabled = 1 WHERE id = ?').run(existing.id);
    }
  }

  const { app } = await createServer();
  const server = app.listen(PORT);
  console.log(`[e2e] Servidor em ${BASE}`);
  return { server, db };
}

// ─── Login ─────────────────────────────────────────────────────────────────
async function login(page: Page) {
  await page.goto(`${BASE}/?login=1`, { waitUntil: 'load', timeout: 15000 });
  await wait(page, 500);
  await page.waitForSelector('#login-user', { state: 'visible', timeout: 5000 });
  await page.fill('#login-user', 'admin');
  await page.fill('#login-pass', 'admin');
  await Promise.all([
    page.waitForURL(`${BASE}/`, { waitUntil: 'load', timeout: 15000 }),
    page.click('button[type="submit"]'),
  ]);
  check('Login realizado com sucesso', true);
}

// ─── Navegar para Produtos ─────────────────────────────────────────────────
async function goToProducts(page: Page) {
  await page.goto(`${BASE}/app/commercial/produtos`, { waitUntil: 'load', timeout: 15000 });
  await wait(page, 800);
  const title = await page.title();
  check('Página de produtos carregada', title.includes('Produtos'));
  const empty = await page.isVisible('text=Nenhum produto cadastrado ainda');
  check('Estado vazio visível', empty);
  await snap(page, 'pagina-produtos-vazia');
}

// ─── Helper: abrir Novo Produto ────────────────────────────────────────────
async function openNewProduct(page: Page) {
  await page.click('button.btn:has-text("Novo produto")');
  await wait(page, 600);
  // Verificar se dialog abriu
  const h1 = await page.locator('dialog[class*="product-modal"] h1').textContent();
  check('Dialog "Novo produto" aberto', h1?.trim() === 'Novo produto');
}

// ─── Helper: preencher campo pelo x-model ──────────────────────────────────
async function fillModel(page: Page, model: string, value: string) {
  // Escapa o ponto para CSS: [x-model="form.name"]
  const sel = `[x-model="${model}"]`;
  await page.locator(sel).fill(value);
}

async function selectModel(page: Page, model: string, value: string) {
  const sel = `[x-model\\.number="${model}"]`;
  await page.locator(sel).selectOption(value);
}

// ─── 1. Criar categoria inline + produto simples ──────────────────────────
async function testCriarProdutoSimples(page: Page) {
  console.log('\n── Produto Simples (físico) ──');

  await openNewProduct(page);
  await snap(page, 'dialog-novo-produto');

  // Criar categoria inline
  const catInput = page.locator('[x-model="newCat"]');
  await catInput.fill('Bebidas');
  await page.locator('button:has-text("Criar")').first().click();
  await wait(page, 600);
  check('Categoria "Bebidas" criada inline', true);

  // Preencher formulário
  await fillModel(page, 'form.name', 'Coca-Cola 350ml');
  await fillModel(page, 'form.sku', 'SKU-001');
  await fillModel(page, 'form.unit', 'un');
  await fillModel(page, 'form.price', '49,90');
  await fillModel(page, 'form.cost', '25,00');
  await fillModel(page, 'form.minStock', '10');

  // Estoque inicial (visível apenas quando não tem form.id)
  const initialStock = page.locator('[x-model="form.initialStock"]');
  if (await initialStock.isVisible()) {
    await initialStock.fill('100');
  }

  // Selecionar categoria
  const catSelect = page.locator('[x-model\\.number="form.categoryId"]');
  await catSelect.selectOption({ label: 'Bebidas' });

  await snap(page, 'produto-simples-preenchido');

  // Salvar
  await page.locator('dialog[class*="product-modal"] .actions button.btn:has-text("Salvar")').click();
  await wait(page, 1000);

  // Verificar na lista
  const visible = await page.isVisible('text=Coca-Cola 350ml');
  check('Produto "Coca-Cola 350ml" criado com sucesso', visible);
  await snap(page, 'produto-simples-criado');
}

// ─── 2. Busca ──────────────────────────────────────────────────────────────
async function testBusca(page: Page) {
  console.log('\n── Busca ──');
  const search = page.locator('input[placeholder*="Buscar nome"]');
  await search.fill('Coca');
  await wait(page, 800); // debounce 400ms
  const found = await page.isVisible('text=Coca-Cola 350ml');
  check('Busca por "Coca" encontra o produto', found);
  await search.clear();
  await wait(page, 800);
}

// ─── 3. Editar produto ────────────────────────────────────────────────────
async function testEditarProduto(page: Page) {
  console.log('\n── Edição ──');
  // Clicar na linha do produto para editar
  await page.locator('text=Coca-Cola 350ml').click();
  await wait(page, 600);
  await snap(page, 'editar-produto');

  // Renomear
  const nameInput = page.locator('[x-model="form.name"]');
  await nameInput.clear();
  await nameInput.fill('Coca-Cola 350ml Lata');

  // Mudar preço
  const priceInput = page.locator('[x-model="form.price"]');
  await priceInput.clear();
  await priceInput.fill('55,00');

  await snap(page, 'produto-editado');
  await page.locator('dialog[class*="product-modal"] .actions button.btn:has-text("Salvar")').click();
  await wait(page, 1000);

  const edited = await page.isVisible('text=Coca-Cola 350ml Lata');
  check('Produto renomeado com sucesso', edited);
}

// ─── 4. Favoritar ─────────────────────────────────────────────────────────
async function testFavoritar(page: Page) {
  console.log('\n── Favoritar ──');
  const favBtn = page.locator('tr:has-text("Coca-Cola") button.icon-btn[title*="favorito"]').first();
  await favBtn.click();
  await wait(page, 600);
  const active = await page.locator('tr:has-text("Coca-Cola") button.icon-btn.active[title*="favorito"]').count();
  check('Produto favoritado', active > 0);
  await snap(page, 'produto-favoritado');
}

// ─── 5. Duplicar ──────────────────────────────────────────────────────────
async function testDuplicar(page: Page) {
  console.log('\n── Duplicar ──');
  // Abrir menu de ações
  await page.locator('tr:has-text("Coca-Cola") button.icon-btn[title="Mais ações"]').first().click();
  await wait(page, 300);
  await page.locator('button:has-text("Duplicar")').click();
  await wait(page, 1000);

  const count = await page.locator('text=Coca-Cola 350ml Lata').count();
  check('Produto duplicado aparece na lista', count >= 2);
  await snap(page, 'produto-duplicado');
}

// ─── 6. Movimentar estoque ────────────────────────────────────────────────
async function testMovimentarEstoque(page: Page) {
  console.log('\n── Estoque ──');
  await page.locator('tr:has-text("Coca-Cola") button.icon-btn[title="Mais ações"]').first().click();
  await wait(page, 300);
  await page.locator('button:has-text("Estoque")').first().click();
  await wait(page, 400);
  await snap(page, 'dialog-movimento-estoque');

  // Preencher movimentação
  const moveDialog = page.locator('dialog[x-ref="mv"]');
  await moveDialog.locator('input[type="number"]').fill('50');
  await moveDialog.locator('input[type="text"]').last().fill('Reposição');
  await moveDialog.locator('.actions button.btn:has-text("Confirmar")').click();
  await wait(page, 1000);

  // Verificar estoque
  const stockCell = page.locator('tr:has-text("Coca-Cola") td:nth-child(7)').first();
  const stockText = await stockCell.textContent();
  check('Movimentação de estoque realizada', stockText !== null && stockText !== '—' && parseInt(stockText) >= 50);
  await snap(page, 'estoque-atualizado');
}

// ─── 7. Produto com variantes ─────────────────────────────────────────────
async function testProdutoVariantes(page: Page) {
  console.log('\n── Produto com Variantes ──');

  // Criar produto pai (tipo variante)
  await page.locator('button.btn:has-text("Novo produto")').click();
  await wait(page, 500);

  await fillModel(page, 'form.name', 'Camiseta Básica');
  await fillModel(page, 'form.price', '89,90');
  await fillModel(page, 'form.unit', 'un');

  // Selecionar tipo "Produto com variantes"
  await page.locator('[x-model="form.productType"]').selectOption('variante');
  await wait(page, 300);

  await snap(page, 'criar-produto-variante');
  await page.locator('dialog[class*="product-modal"] .actions button.btn:has-text("Salvar")').click();
  await wait(page, 1000);
  check('Produto variante "Camiseta Básica" criado',
    await page.isVisible('text=Camiseta Básica'));

  // Editar o produto para gerenciar variantes
  await page.locator('text=Camiseta Básica').click();
  await wait(page, 600);

  // O painel de variantes deve aparecer (form.productType === 'variante' e form.id existe)
  const variantSection = page.locator('h2:has-text("Variantes")');
  if (await variantSection.isVisible()) {
    // Gerenciar Atributos
    await page.locator('button:has-text("Atributos")').click();
    await wait(page, 500);
    await snap(page, 'gerenciar-atributos');

    // Criar atributo Tamanho
    await page.locator('[x-model="newAttrName"]').fill('Tamanho');
    await page.locator('button:has-text("Adicionar")').first().click();
    await wait(page, 500);

    // Adicionar valores ao atributo Tamanho
    // Encontra a primeira seção de atributo
    const attrSection = page.locator('dialog[x-ref="attrDlg"] > div > div').first();
    // O campo de input para novo valor aparece ao clicar no "+"
    const addValueBtns = page.locator('button.icon-btn[title*="Adicionar valor"]');
    if (await addValueBtns.count() > 0) {
      await addValueBtns.first().click();
      await wait(page, 200);
      // Digitar valor
      const valInput = page.locator('[x-model="addAttrValName"]');
      if (await valInput.isVisible()) {
        await valInput.fill('P');
        await page.locator('button:has-text("Adicionar")').last().click();
        await wait(page, 300);
      }
    }

    // Fechar gerenciador de atributos
    await page.locator('dialog[x-ref="attrDlg"] .actions button:has-text("Fechar")').click();
    await wait(page, 300);

    // Abrir gerar variantes
    await page.locator('button:has-text("Gerar variantes")').click();
    await wait(page, 500);
    await snap(page, 'gerar-variantes');

    // Fechar gerar variantes
    if (await page.locator('dialog[x-ref="genVarDlg"] .actions button:has-text("Cancelar")').isVisible()) {
      await page.locator('dialog[x-ref="genVarDlg"] .actions button:has-text("Cancelar")').click();
    } else {
      await page.locator('button:has-text("Cancelar")').first().click();
    }
    await wait(page, 300);
  } else {
    check('Painel de variantes visível', false, 'Seção de variantes não encontrada');
  }

  // Fechar dialog do produto
  await page.locator('dialog[class*="product-modal"] .actions button.btn.secondary:has-text("Cancelar")').click();
  await wait(page, 500);
  await snap(page, 'variantes-gerenciadas');
}

// ─── 8. Kit / Combo ───────────────────────────────────────────────────────
async function testKitCombo(page: Page) {
  console.log('\n── Kit ──');

  // Primeiro precisamos de produtos para adicionar como componentes
  // Criar "Arroz 5kg" como produto simples (via API direta para agilizar)
  // Mas vamos usar a UI para criar o kit

  await page.locator('button.btn:has-text("Novo produto")').click();
  await wait(page, 500);

  await fillModel(page, 'form.name', 'Cesta Básica');
  await fillModel(page, 'form.price', '199,90');

  // Selecionar tipo "Kit"
  await page.locator('[x-model="form.productType"]').selectOption('kit');
  await wait(page, 300);

  await snap(page, 'criar-kit');
  await page.locator('dialog[class*="product-modal"] .actions button.btn:has-text("Salvar")').click();
  await wait(page, 1000);
  check('Produto kit "Cesta Básica" criado',
    await page.isVisible('text=Cesta Básica'));

  // Editar para ver painel de componentes
  await page.locator('text=Cesta Básica').click();
  await wait(page, 600);

  const kitSection = page.locator('h2:has-text("Componentes fixos")');
  if (await kitSection.isVisible()) {
    await snap(page, 'kit-componentes-visivel');
    // Verificar que o botão "Adicionar" está lá  
    const addBtn = page.locator('button:has-text("Adicionar")').first();
    check('Botão "Adicionar" visível no painel de componentes', await addBtn.isVisible());
  } else {
    check('Painel de componentes do kit visível', false);
  }

  await page.locator('dialog[class*="product-modal"] .actions button.btn.secondary:has-text("Cancelar")').click();
  await wait(page, 500);
}

// ─── 9. Produzido (Ficha Técnica) ─────────────────────────────────────────
async function testProduzido(page: Page) {
  console.log('\n── Produzido ──');

  await page.locator('button.btn:has-text("Novo produto")').click();
  await wait(page, 500);

  await fillModel(page, 'form.name', 'Pão Artesanal');
  await fillModel(page, 'form.price', '15,00');

  // Selecionar tipo "Produzido (ficha técnica)"
  await page.locator('[x-model="form.productType"]').selectOption('produzido');
  await wait(page, 300);

  await snap(page, 'criar-produzido');
  await page.locator('dialog[class*="product-modal"] .actions button.btn:has-text("Salvar")').click();
  await wait(page, 1000);
  check('Produto produzido "Pão Artesanal" criado',
    await page.isVisible('text=Pão Artesanal'));

  // Editar para ver ficha técnica
  await page.locator('text=Pão Artesanal').click();
  await wait(page, 600);

  const recipeSection = page.locator('h2:has-text("Ficha técnica")');
  if (await recipeSection.isVisible()) {
    await snap(page, 'ficha-tecnica-visivel');
    const addBtn = page.locator('button:has-text("Adicionar insumo")');
    check('Botão "Adicionar insumo" visível', await addBtn.isVisible());
  } else {
    check('Painel de ficha técnica visível', false);
  }

  await page.locator('dialog[class*="product-modal"] .actions button.btn.secondary:has-text("Cancelar")').click();
  await wait(page, 500);
}

// ─── 10. Exclusão em massa ────────────────────────────────────────────────
async function testExclusaoMassa(page: Page) {
  console.log('\n── Exclusão em Massa ──');

  // Selecionar o checkbox do produto duplicado (2ª ocorrência)
  const checkboxes = page.locator('tr:has-text("Coca-Cola 350ml Lata") input[type="checkbox"]');
  const count = await checkboxes.count();
  if (count >= 2) {
    await checkboxes.nth(1).check();
    await wait(page, 300);

    // Barra bulk deve aparecer
    const bulkBar = page.locator('.bulk-count');
    check('Barra de seleção em massa visível', await bulkBar.isVisible());

    await page.locator('button:has-text("Excluir selecionados")').click();
    await wait(page, 500);

    // Confirmar no dialog de confirmação
    await page.locator('#confirm-dlg button.btn:has-text("Confirmar")').click();
    await wait(page, 1500);

    // Aguardar reload da lista
    await wait(page, 2000);

    // Verificar que a contagem total de produtos diminuiu
    const totalText = await page.locator('.toolbar .muted').first().textContent() ?? '';
    const totalMatch = totalText.match(/(\d+)\s+registro/);
    const totalAfter = totalMatch ? parseInt(totalMatch[1]) : 0;
    // Antes da exclusão tínhamos 5 produtos; após deve ser 4
    check('Exclusão em massa reduziu total de produtos', totalAfter === 4, `total=${totalAfter}`);
    await snap(page, 'exclusao-massa-concluida');
  } else {
    check('Checkboxes para exclusão em massa', false, `Só ${count} checkbox(es) encontrado(s)`);
  }
}

// ─── 11. Cardápio Online ──────────────────────────────────────────────────
async function testCardapioOnline(page: Page) {
  console.log('\n── Cardápio Online ──');
  const cardapioBtn = page.locator('tr:has-text("Coca-Cola") button.icon-btn[title*="cardápio online"]').first();
  if (await cardapioBtn.isVisible()) {
    await cardapioBtn.click();
    await wait(page, 600);
    const active = await page.locator('tr:has-text("Coca-Cola") button.icon-btn.active[title*="cardápio online"]').count();
    check('Produto marcado como visível no cardápio online', active > 0);
    await snap(page, 'cardapio-online-ativado');
  } else {
    check('Botão cardápio online visível', false, 'Pode ser por capability não estar ativa');
  }
}

// ─── 12. Verificação final da lista ────────────────────────────────────────
async function testListaFinal(page: Page) {
  console.log('\n── Lista Final ──');

  // Verificar que todos os produtos esperados estão visíveis
  const produtos = [
    { nome: 'Coca-Cola 350ml Lata', tipo: 'Físico' },
    { nome: 'Camiseta Básica', tipo: 'Variante' },
    { nome: 'Cesta Básica', tipo: 'Kit' },
    { nome: 'Pão Artesanal', tipo: 'Produzido' },
  ];

  let ok = 0;
  for (const p of produtos) {
    if (await page.isVisible(`text=${p.nome}`)) {
      ok++;
    } else {
      console.log(`  AVISO: "${p.nome}" (${p.tipo}) não encontrado na lista`);
    }
  }
  check(`Produtos visíveis na lista: ${ok}/${produtos.length}`, ok === produtos.length);

  await snap(page, 'lista-final-produtos');
}

// ─── Main ──────────────────────────────────────────────────────────────────
async function main() {
  console.log('══════════════════════════════════════════════════');
  console.log('  E2E: Fluxo Completo de Cadastro de Produtos');
  console.log('══════════════════════════════════════════════════\n');

  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  const { server } = await startServer();

  let browser;
  const consoleErrors: string[] = [];

  try {
    browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    const page = await ctx.newPage();

    page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
    page.on('pageerror', (err) => { consoleErrors.push('PageError: ' + err.message); });
    page.on('response', (res) => {
      if (res.status() >= 400 && !res.url().includes('favicon')) {
        consoleErrors.push(`HTTP ${res.status()} ${res.url()}`);
      }
    });

    // ─── Execução dos testes ───
    await login(page);
    await snap(page, 'home-pos-login');

    await goToProducts(page);
    await testCriarProdutoSimples(page);
    await testBusca(page);
    await testEditarProduto(page);
    await testFavoritar(page);
    await testDuplicar(page);
    await testMovimentarEstoque(page);
    await testProdutoVariantes(page);
    await testKitCombo(page);
    await testProduzido(page);
    await testCardapioOnline(page);
    await testExclusaoMassa(page);
    await testListaFinal(page);

    // ─── Report ───
    if (consoleErrors.length) {
      console.log('\n⚠ Erros encontrados:\n');
      for (const err of consoleErrors.slice(0, 25)) {
        console.log(`  • ${err}`);
      }
      if (consoleErrors.length > 25) console.log(`  … e mais ${consoleErrors.length - 25} erro(s)`);
    }
  } finally {
    if (browser) await browser.close();
    server.close();
    closeDb();
  }

  console.log(`\n${'='.repeat(55)}`);
  console.log(`\n${failures === 0 ? '✓ TODOS OS TESTES PASSARAM' : `✗ ${failures} FALHA(S)`}`);
  console.log(`\nScreenshots: ${SCREENSHOT_DIR}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('[e2e] Erro fatal:', err);
  process.exit(1);
});
