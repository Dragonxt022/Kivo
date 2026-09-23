/**
 * Teste da importação de NF-e (módulo nfe): parse do XML → classificação (EAN casa com
 * produto existente; sem EAN vira produto novo) → conferência → commit atômico
 * (fornecedor novo + produto + vínculo + compra recebida com estoque/custo). E o
 * requisito mais sensível: a mesma chave de acesso nunca entra duas vezes.
 *
 * KIVO_DB_PATH TEM que vir do ambiente:
 *   node scripts/test-isolated.js src/tests/nfe-import.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { migrateUp } from '../core/database/migrator';
import { runSeeds } from '../core/database/seeds';
import { createServer } from '../core/server';
import { getSqlite, closeDb } from '../core/database/connection';
import { activateTestLicense } from './resetTestDb';
import { unwrap } from './testUtils';

const PORT = Number(process.env.KIVO_PORT ?? 3860);
const base = `http://localhost:${PORT}`;
let failures = 0;

function check(label: string, ok: boolean, extra = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures++;
}

let cookie = '';
async function api(p: string, opts: RequestInit = {}, extraCookie?: string): Promise<Response> {
  return fetch(`${base}${p}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(extraCookie ? { cookie: extraCookie } : cookie ? { cookie } : {}), ...(opts.headers ?? {}) },
  });
}

function assertBancoDescartavel(): string {
  const alvo = process.env.KIVO_DB_PATH;
  if (!alvo) {
    throw new Error(
      'KIVO_DB_PATH não definida. Este teste APAGA o banco que usar — rode via ' +
      '`node scripts/test-isolated.js src/tests/nfe-import.ts`.',
    );
  }
  if (path.resolve(alvo) === path.resolve(process.cwd(), 'database', 'kivo.db')) {
    throw new Error('Recusado: KIVO_DB_PATH aponta para o banco de dev.');
  }
  return alvo;
}

/** Gera uma chave de acesso de 44 dígitos com DV (módulo 11) válido. */
function makeAccessKey(): string {
  const base = Array.from({ length: 43 }, () => String(Math.floor(Math.random() * 10))).join('');
  let sum = 0;
  let weight = 2;
  for (let idx = base.length - 1; idx >= 0; idx--) {
    sum += Number(base[idx]) * weight;
    weight = weight === 9 ? 2 : weight + 1;
  }
  const dv = 11 - (sum % 11);
  return base + (dv >= 10 ? '0' : String(dv));
}

function nfeXml(accessKey: string, firstEan: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<nfeProc versao="4.00" xmlns="http://www.portalfiscal.inf.br/nfe">
  <NFe>
    <infNFe Id="NFe${accessKey}" versao="4.00">
      <ide><cUF>35</cUF><mod>55</mod><serie>1</serie><nNF>101</nNF><dhEmi>2026-03-02T14:10:00-03:00</dhEmi></ide>
      <emit><CNPJ>11222333000181</CNPJ><xNome>Distribuidora Teste LTDA</xNome><xFant>Dist Teste</xFant>
        <IE>123456789</IE><fone>1130001000</fone>
        <enderEmit><xLgr>Rua das Flores</xLgr><nro>100</nro><xBairro>Centro</xBairro><xMun>Sao Paulo</xMun><UF>SP</UF><CEP>01000000</CEP></enderEmit>
      </emit>
      <dest><CNPJ>22333444000199</CNPJ><xNome>Mercado Dois Irmaos</xNome></dest>
      <det nItem="1"><prod>
        <cProd>001</cProd><cEAN>${firstEan}</cEAN><xProd>Refrigerante Cola Lata 350ml</xProd>
        <NCM>22021000</NCM><CFOP>2101</CFOP><uCom>UN</uCom><qCom>20</qCom><vUnCom>24.00</vUnCom><vProd>480.00</vProd>
      </prod></det>
      <det nItem="2"><prod>
        <cProd>050</cProd><cEAN>SEM GTIN</cEAN><xProd>Pao de Forma Integral</xProd>
        <NCM>19059000</NCM><CFOP>2101</CFOP><uCom>UN</uCom><qCom>10</qCom><vUnCom>8.50</vUnCom><vProd>85.00</vProd>
      </prod></det>
      <total><ICMSTot><vNF>565.00</vNF></ICMSTot></total>
    </infNFe>
  </NFe>
</nfeProc>`;
}

/**
 * NF-e faturada em CAIXA: cEAN é o código da caixa (GTIN-14), cEANTrib é o código da
 * unidade, uCom=CX com uTrib=UN (12 un por caixa). É o cenário que antes lançava estoque
 * e custo errados e gravava o EAN da caixa como código do produto.
 */
function nfeXmlBox(accessKey: string, boxEan: string, unitEan: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<nfeProc versao="4.00" xmlns="http://www.portalfiscal.inf.br/nfe">
  <NFe>
    <infNFe Id="NFe${accessKey}" versao="4.00">
      <ide><cUF>35</cUF><mod>55</mod><serie>1</serie><nNF>202</nNF><dhEmi>2026-03-05T10:00:00-03:00</dhEmi></ide>
      <emit><CNPJ>11222333000181</CNPJ><xNome>Distribuidora Teste LTDA</xNome></emit>
      <dest><CNPJ>22333444000199</CNPJ><xNome>Mercado Dois Irmaos</xNome></dest>
      <det nItem="1"><prod>
        <cProd>CX-COLA</cProd><cEAN>${boxEan}</cEAN><cEANTrib>${unitEan}</cEANTrib>
        <xProd>Refrigerante Cola Lata 350ml</xProd>
        <NCM>22021000</NCM><CFOP>2101</CFOP>
        <uCom>CX</uCom><qCom>2</qCom><vUnCom>60.00</vUnCom><vProd>120.00</vProd>
        <uTrib>UN</uTrib><qTrib>24</qTrib><vUnTrib>5.00</vUnTrib>
      </prod></det>
      <total><ICMSTot><vNF>120.00</vNF></ICMSTot></total>
    </infNFe>
  </NFe>
</nfeProc>`;
}

/**
 * NF-e com siglas de unidade FORA do conjunto canônico do catálogo: 'FD' (fardo) e 'KG'
 * com quantidade fracionada. O importador deve aceitar e preservar a sigla — não existe
 * lista fixa que rejeite unidade (o leiaute da NF-e aceita siglas livres).
 */
function nfeXmlUnits(accessKey: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<nfeProc versao="4.00" xmlns="http://www.portalfiscal.inf.br/nfe">
  <NFe>
    <infNFe Id="NFe${accessKey}" versao="4.00">
      <ide><cUF>35</cUF><mod>55</mod><serie>1</serie><nNF>303</nNF><dhEmi>2026-03-07T09:00:00-03:00</dhEmi></ide>
      <emit><CNPJ>11222333000181</CNPJ><xNome>Distribuidora Teste LTDA</xNome></emit>
      <dest><CNPJ>22333444000199</CNPJ><xNome>Mercado Dois Irmaos</xNome></dest>
      <det nItem="1"><prod>
        <cProd>FD-1</cProd><cEAN>SEM GTIN</cEAN><xProd>Guardanapo Fardo</xProd>
        <NCM>48181000</NCM><CFOP>5102</CFOP><uCom>FD</uCom><qCom>3</qCom><vUnCom>20.00</vUnCom><vProd>60.00</vProd>
        <uTrib>FD</uTrib><qTrib>3</qTrib><vUnTrib>20.00</vUnTrib>
      </prod></det>
      <det nItem="2"><prod>
        <cProd>KG-1</cProd><cEAN>SEM GTIN</cEAN><xProd>Queijo Mussarela</xProd>
        <NCM>04061010</NCM><CFOP>5102</CFOP><uCom>KG</uCom><qCom>2.5</qCom><vUnCom>38.00</vUnCom><vProd>95.00</vProd>
        <uTrib>KG</uTrib><qTrib>2.5</qTrib><vUnTrib>38.00</vUnTrib>
      </prod></det>
      <total><ICMSTot><vNF>155.00</vNF></ICMSTot></total>
    </infNFe>
  </NFe>
</nfeProc>`;
}

async function main(): Promise<void> {
  const TMP_DB = assertBancoDescartavel();
  fs.mkdirSync(path.dirname(TMP_DB), { recursive: true });
  fs.rmSync(TMP_DB, { force: true });

  migrateUp();
  runSeeds();
  activateTestLicense();
  const { app } = await createServer();
  const server = app.listen(PORT);
  const db = getSqlite();

  try {
    const login = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'admin', password: 'admin' }) });
    const m = (login.headers.get('set-cookie') ?? '').match(/kivo_session=([^;]+)/);
    cookie = m ? `kivo_session=${m[1]}` : '';
    check('login admin', cookie !== '');
    if (!cookie) return;

    // Módulo nasce desligado; liga a capability para o teste.
    check('capability nfe.import nasce desligada',
      (db.prepare("SELECT enabled FROM capabilities WHERE key='nfe.import'").get() as { enabled: number } | undefined)?.enabled === 0);
    check('liga capability nfe.import',
      (await api('/api/core/capabilities/nfe.import', { method: 'PUT', body: JSON.stringify({ enabled: true }) }, cookie)).status === 200);

    // Produto já cadastrado com o EAN da linha 1.
    const ean = '7891000100100';
    const existingProductId = Number(db.prepare(
      `INSERT INTO products (name, sku, barcode, unit, price_cents, cost_cents, track_stock, active, uuid)
       VALUES ('Refrigerante Cola Lata 350ml', 'COLA350', ?, 'UN', 3200, 0, 1, 1, ?)`,
    ).run(ean, randomUUID()).lastInsertRowid);
    check('produto existente criado', existingProductId > 0);

    const accessKey = makeAccessKey();
    const xml = nfeXml(accessKey, ean);

    // ── Preview: classificação, nada gravado ──
    const prevR = await api('/api/nfe/preview', { method: 'POST', body: JSON.stringify({ xml }) }, cookie);
    const prev = await unwrap<{ supplier: { exists: boolean; cnpj: string }; items: { line: number; kind: string; ean: string | null; product: { id: number } | null }[] }>(prevR);
    check('preview responde', prevR.status === 200, `status=${prevR.status}`);
    check('fornecedor novo (não cadastrado)', prev.supplier.exists === false && prev.supplier.cnpj === '11222333000181');
    check('item 1 identificado por EAN', prev.items[0].kind === 'matched' && prev.items[0].product?.id === existingProductId);
    check('item 2 sem correspondência é novo', prev.items[1].kind === 'new');

    const countInvoicesBefore = (db.prepare('SELECT COUNT(*) c FROM purchase_invoices').get() as { c: number }).c;
    check('preview não gravou NF-e', countInvoicesBefore === 0);

    // ── Commit: conferência aplicada ──
    const commitR = await api('/api/nfe/commit', { method: 'POST', body: JSON.stringify({
      xml,
      decisions: [
        { line: 1, action: 'link', productId: existingProductId, qty: 20, unitCostCents: 2400 },
        { line: 2, action: 'create', productId: null, qty: 10, unitCostCents: 850 },
      ],
    }) }, cookie);
    const result = await unwrap<{ invoiceId: number; purchaseId: number; created: number; linked: number; ignored: number }>(commitR);
    check('commit responde', commitR.status === 200, `status=${commitR.status}`);
    check('contagens da importação', result.linked === 1 && result.created === 1, `linked=${result.linked} created=${result.created}`);

    const invoice = db.prepare('SELECT * FROM purchase_invoices WHERE id = ?').get(result.invoiceId) as { access_key: string; supplier_id: number; total_cents: number };
    check('NF-e registrada com a chave', invoice?.access_key === accessKey && invoice.total_cents === 56500);
    const supplier = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(invoice.supplier_id) as { name: string; document: string; ie: string | null; city: string | null; state: string | null };
    check('fornecedor criado pelo CNPJ do XML', supplier.document === '11222333000181' && supplier.name.includes('Distribuidora Teste'));
    check('fornecedor recebeu IE e endereço do XML', supplier.ie === '123456789' && supplier.city === 'Sao Paulo' && supplier.state === 'SP');

    const prod = db.prepare('SELECT * FROM products WHERE id = ?').get(existingProductId) as { cost_cents: number; stock_qty: number };
    check('estoque do produto existente entrou (20)', prod.stock_qty === 20, `saldo=${prod.stock_qty}`);
    check('custo do produto existente = custo da NF-e (1ª compra)', prod.cost_cents === 2400, `custo=${prod.cost_cents}`);

    const novoProd = db.prepare("SELECT * FROM products WHERE name = 'Pao de Forma Integral'").get() as { id: number; unit: string; cost_cents: number; stock_qty: number };
    check('produto novo criado da linha 2', !!novoProd && novoProd.stock_qty === 10 && novoProd.cost_cents === 850, `id=${novoProd?.id}`);

    const mapping = db.prepare('SELECT supplier_code, last_cost_cents FROM product_suppliers WHERE product_id = ? AND supplier_id = ?').get(existingProductId, invoice.supplier_id) as { supplier_code: string; last_cost_cents: number };
    check('vínculo produto × fornecedor com o cProd', mapping?.supplier_code === '001' && mapping.last_cost_cents === 2400);
    const stockMove = (db.prepare("SELECT COUNT(*) c FROM stock_movements WHERE ref_entity = 'purchase' AND ref_id = ?").get(String(result.purchaseId)) as { c: number }).c;
    check('movimentações de estoque da compra', stockMove === 2, `mov=${stockMove}`);
    check('compra recebida criada (custo/CMV no fluxo normal)', result.purchaseId > 0);

    // ── Duplicidade: mesma chave nunca importa de novo ──
    const dupR = await api('/api/nfe/commit', { method: 'POST', body: JSON.stringify({
      xml,
      decisions: [{ line: 1, action: 'ignore', qty: 1, unitCostCents: 2400 }, { line: 2, action: 'ignore', qty: 1, unitCostCents: 850 }],
    }) }, cookie);
    const dupJson = await dupR.json().catch(() => ({})) as { error?: string };
    check('mesma chave recusada (duplicado)', dupR.status === 400 && !!dupJson.error && dupJson.error.includes('já foi importada'));
    const invoicesTotal = (db.prepare('SELECT COUNT(*) c FROM purchase_invoices').get() as { c: number }).c;
    check('só 1 NF-e registrada', invoicesTotal === 1, `total=${invoicesTotal}`);

    // ── XML inválido não passa ──
    const bad = await api('/api/nfe/preview', { method: 'POST', body: JSON.stringify({ xml: xml.replace('4.00', '3.10') }) }, cookie);
    check('versão 3.10 é recusada', bad.status === 400);

    // ── Tela abre (EJS sem typo) ──
    const page = await api('/app/nfe/importar', {}, cookie);
    const html = await page.text();
    check('página de importação abre', page.status === 200 && html.includes('nfeImportPage'), `status=${page.status}`);

    // ── Reversão: desfaz a importação e volta ao estado anterior ──
    const revertR = await api(`/api/nfe/invoices/${result.invoiceId}/revert`, { method: 'POST' }, cookie);
    const rev = await unwrap<{ stockReversed: number; costRestored: number; productsDeleted: number; supplierDeleted: boolean; purchaseDeleted: boolean }>(revertR);
    check('reversão responde', revertR.status === 200, `status=${revertR.status}`);
    check('reversão devolveu o estoque (2 itens)', rev.stockReversed === 2, `stockReversed=${rev.stockReversed}`);
    check('reversão restaurou o custo', rev.costRestored === 1, `costRestored=${rev.costRestored}`);
    check('reversão apagou o produto criado', rev.productsDeleted === 1, `productsDeleted=${rev.productsDeleted}`);
    check('reversão apagou o fornecedor criado', rev.supplierDeleted === true);
    check('reversão apagou a compra', rev.purchaseDeleted === true);

    const prodAfter = db.prepare('SELECT stock_qty, cost_cents FROM products WHERE id = ?').get(existingProductId) as { stock_qty: number; cost_cents: number };
    check('estoque do produto vinculado voltou a 0', prodAfter.stock_qty === 0, `saldo=${prodAfter.stock_qty}`);
    check('custo do produto vinculado restaurado (0)', prodAfter.cost_cents === 0, `custo=${prodAfter.cost_cents}`);

    const novoDepois = db.prepare("SELECT deleted_at FROM products WHERE name = 'Pao de Forma Integral'").get() as { deleted_at: string | null } | undefined;
    check('produto novo ficou soft-deleted', !!novoDepois && novoDepois.deleted_at != null);

    const invoiceDepois = db.prepare('SELECT deleted_at FROM purchase_invoices WHERE id = ?').get(result.invoiceId) as { deleted_at: string | null };
    check('NF-e ficou soft-deleted', invoiceDepois.deleted_at != null);
    const supplierDepois = db.prepare('SELECT deleted_at FROM suppliers WHERE id = ?').get(invoice.supplier_id) as { deleted_at: string | null };
    check('fornecedor ficou soft-deleted', supplierDepois.deleted_at != null);

    // A chave fica livre de novo (o índice único é parcial em deleted_at IS NULL).
    const reimportR = await api('/api/nfe/commit', { method: 'POST', body: JSON.stringify({
      xml,
      decisions: [{ line: 1, action: 'ignore', qty: 1, unitCostCents: 2400 }, { line: 2, action: 'ignore', qty: 1, unitCostCents: 850 }],
    }) }, cookie);
    check('mesma chave pode ser reimportada após reverter', reimportR.status === 200, `status=${reimportR.status}`);

    // ── Preço sugerido + conversão un/cx + EAN de caixa ──
    const boxEan = '17891000100100';
    const unitEan = '7891000100100';
    const boxKey = makeAccessKey();
    const boxXml = nfeXmlBox(boxKey, boxEan, unitEan);

    const boxPrevR = await api('/api/nfe/preview', { method: 'POST', body: JSON.stringify({ xml: boxXml }) }, cookie);
    const boxPrev = await unwrap<{ markupBps: number; items: {
      kind: string; saleUnit: string; conversionQty: number | null; conversionSource: string;
      costSaleCents: number; suggestedPriceCents: number; salePriceCents: number;
      eanBox: string | null; eanUnit: string | null;
    }[] }>(boxPrevR);
    const bl = boxPrev.items[0];
    check('preview box: reconhecido por nome', bl.kind === 'possible' || bl.kind === 'matched', `kind=${bl.kind}`);
    check('preview box: unidade de venda = un', bl.saleUnit === 'un');
    check('preview box: conversão 12 (uTrib)', bl.conversionQty === 12 && bl.conversionSource === 'trib', `qty=${bl.conversionQty} src=${bl.conversionSource}`);
    check('preview box: custo convertido 5,00/un', bl.costSaleCents === 500, `custo=${bl.costSaleCents}`);
    check('preview box: preço sugerido = markup 100%', bl.suggestedPriceCents === 1000, `sug=${bl.suggestedPriceCents}`);
    check('preview box: EAN da caixa separado do da unidade', bl.eanBox === boxEan && bl.eanUnit === unitEan, `box=${bl.eanBox} un=${bl.eanUnit}`);

    const boxCommitR = await api('/api/nfe/commit', { method: 'POST', body: JSON.stringify({
      xml: boxXml,
      decisions: [{ line: 1, action: 'link', productId: existingProductId, qty: 2, unitCostCents: 6000, salePriceCents: 999, conversionQty: 12, unit: 'un' }],
    }) }, cookie);
    check('commit box responde', boxCommitR.status === 200, `status=${boxCommitR.status}`);
    const boxProd = db.prepare('SELECT cost_cents, stock_qty, price_cents, barcode FROM products WHERE id = ?').get(existingProductId) as
      { cost_cents: number; stock_qty: number; price_cents: number; barcode: string | null };
    check('conversão lançou 24 unidades no estoque', boxProd.stock_qty === 24, `saldo=${boxProd.stock_qty}`);
    check('custo convertido gravado (5,00/un)', boxProd.cost_cents === 500, `custo=${boxProd.cost_cents}`);
    check('preço de venda conferido foi gravado', boxProd.price_cents === 999, `preco=${boxProd.price_cents}`);
    check('EAN da caixa NÃO virou o código do produto', boxProd.barcode === unitEan, `barcode=${boxProd.barcode}`);
    const boxLink = db.prepare('SELECT kind, pack_qty FROM product_barcodes WHERE barcode = ?').get(boxEan) as { kind: string; pack_qty: number } | undefined;
    check('EAN da caixa guardado como código secundário', boxLink?.kind === 'caixa' && boxLink.pack_qty === 12, `kind=${boxLink?.kind} pack=${boxLink?.pack_qty}`);

    // Reabrir a edição de uma compra por caixa não pode acusar conflito falso: o EAN da
    // caixa identifica o produto e a unidade da nota (CX) converte para a de venda (un).
    const boxRes = await unwrap<{ invoiceId: number }>(boxCommitR);
    const boxEditR = await api(`/api/nfe/invoices/${boxRes.invoiceId}/edit`, {}, cookie);
    const boxEdit = await unwrap<{ preview: { items: { line: number; kind: string; flags: string[] }[] } }>(boxEditR);
    const boxLine = boxEdit.preview.items[0];
    check('edição box: identificado pelo EAN da caixa', boxLine.kind === 'matched', `kind=${boxLine.kind}`);
    check('edição box: sem conflito falso de EAN/unidade',
      !boxLine.flags.includes('ean_conflict') && !boxLine.flags.includes('unit_conflict'),
      `flags=${JSON.stringify(boxLine.flags)}`);

    // ── Unidades livres (FD) e fracionadas (KG) ──
    const unitsKey = makeAccessKey();
    const unitsXml = nfeXmlUnits(unitsKey);
    const unitsPrevR = await api('/api/nfe/preview', { method: 'POST', body: JSON.stringify({ xml: unitsXml }) }, cookie);
    const unitsPrev = await unwrap<{ items: { line: number; kind: string; saleUnit: string }[] }>(unitsPrevR);
    check('preview aceita unidade FD (não canônica)', unitsPrev.items[0].kind === 'new' && unitsPrev.items[0].saleUnit === 'FD', `unit=${unitsPrev.items[0]?.saleUnit}`);
    check('preview aceita unidade KG', unitsPrev.items[1].saleUnit === 'kg', `unit=${unitsPrev.items[1]?.saleUnit}`);

    const unitsCommitR = await api('/api/nfe/commit', { method: 'POST', body: JSON.stringify({
      xml: unitsXml,
      decisions: [
        { line: 1, action: 'create', productId: null, qty: 3, unitCostCents: 2000, salePriceCents: 3000, unit: 'FD' },
        { line: 2, action: 'create', productId: null, qty: 2.5, unitCostCents: 3800, salePriceCents: 5000, unit: 'kg' },
      ],
    }) }, cookie);
    check('commit com unidades livres responde', unitsCommitR.status === 200, `status=${unitsCommitR.status}`);
    const fdProd = db.prepare("SELECT unit, stock_qty, cost_cents FROM products WHERE name = 'Guardanapo Fardo'").get() as { unit: string; stock_qty: number; cost_cents: number };
    check('produto criado preserva a sigla FD', fdProd?.unit === 'FD', `unit=${fdProd?.unit}`);
    check('estoque do fardo = 3', fdProd?.stock_qty === 3, `saldo=${fdProd?.stock_qty}`);
    const kgProd = db.prepare("SELECT unit, stock_qty, cost_cents FROM products WHERE name = 'Queijo Mussarela'").get() as { unit: string; stock_qty: number; cost_cents: number };
    check('produto KG normalizado para kg', kgProd?.unit === 'kg', `unit=${kgProd?.unit}`);
    check('estoque fracionado = 2.5', kgProd?.stock_qty === 2.5, `saldo=${kgProd?.stock_qty}`);

    // ── Edição de uma importação já feita ──
    const editProdId = Number(db.prepare(
      `INSERT INTO products (name, sku, barcode, unit, price_cents, cost_cents, track_stock, active, uuid)
       VALUES ('Suco Editavel', 'SUCO1', '7891000999900', 'UN', 1000, 0, 1, 1, ?)`,
    ).run(randomUUID()).lastInsertRowid);
    const editKey = makeAccessKey();
    const editXml = nfeXml(editKey, 'SEM GTIN');
    const editCommit = await api('/api/nfe/commit', { method: 'POST', body: JSON.stringify({
      xml: editXml,
      decisions: [
        { line: 1, action: 'link', productId: editProdId, qty: 10, unitCostCents: 500 },
        { line: 2, action: 'create', productId: null, qty: 5, unitCostCents: 800 },
      ],
    }) }, cookie);
    const editRes = await unwrap<{ invoiceId: number; purchaseId: number }>(editCommit);
    check('edição: importação inicial responde', editCommit.status === 200, `status=${editCommit.status}`);
    let editProd = db.prepare('SELECT stock_qty FROM products WHERE id = ?').get(editProdId) as { stock_qty: number };
    check('edição: estoque inicial do vinculado = 10', editProd.stock_qty === 10, `saldo=${editProd.stock_qty}`);
    const createdEdit = db.prepare(
      "SELECT id FROM products WHERE name = 'Pao de Forma Integral' AND deleted_at IS NULL ORDER BY id DESC LIMIT 1",
    ).get() as { id: number } | undefined;

    // GET /edit reabre a conferência pré-preenchida com as decisões gravadas.
    const editDataR = await api(`/api/nfe/invoices/${editRes.invoiceId}/edit`, {}, cookie);
    const editData = await unwrap<{
      decisions: { line: number; action: string; productId: number | null; qty: number }[];
      divergence: { changed: boolean };
    }>(editDataR);
    check('edição: GET /edit responde', editDataR.status === 200, `status=${editDataR.status}`);
    check('edição: linha 1 pré-preenchida como link', editData.decisions[0].action === 'link' && editData.decisions[0].productId === editProdId);
    check('edição: linha 2 pré-preenchida como link ao produto criado',
      editData.decisions[1].action === 'link' && editData.decisions[1].productId === createdEdit?.id,
      `action=${editData.decisions[1]?.action} id=${editData.decisions[1]?.productId}`);
    check('edição: sem divergência logo após importar', editData.divergence.changed === false);

    // Edita: linha 1 passa a 30; linha 2 ignorada.
    const saveR = await api(`/api/nfe/invoices/${editRes.invoiceId}/edit`, { method: 'POST', body: JSON.stringify({
      stockMode: 'restore',
      decisions: [
        { line: 1, action: 'link', productId: editProdId, qty: 30, unitCostCents: 500 },
        { line: 2, action: 'ignore', qty: 1, unitCostCents: 800 },
      ],
    }) }, cookie);
    check('edição: salvar responde', saveR.status === 200, `status=${saveR.status}`);
    editProd = db.prepare('SELECT stock_qty FROM products WHERE id = ?').get(editProdId) as { stock_qty: number };
    check('edição: estoque do vinculado = 30', editProd.stock_qty === 30, `saldo=${editProd.stock_qty}`);
    const createdAfter = db.prepare('SELECT deleted_at FROM products WHERE id = ?').get(createdEdit!.id) as { deleted_at: string | null };
    check('edição: produto criado que saiu da nota foi removido', createdAfter.deleted_at != null);
    const invoiceSame = db.prepare('SELECT id, purchase_id FROM purchase_invoices WHERE access_key = ? AND deleted_at IS NULL').get(editKey) as { id: number; purchase_id: number } | undefined;
    check('edição: mantém a mesma NF-e (id)', !!invoiceSame && invoiceSame.id === editRes.invoiceId);
    check('edição: aponta para a nova compra', !!invoiceSame && invoiceSame.purchase_id > 0 && invoiceSame.purchase_id !== editRes.purchaseId);
    const oldPurchase = db.prepare('SELECT deleted_at FROM purchases WHERE id = ?').get(editRes.purchaseId) as { deleted_at: string | null };
    check('edição: compra antiga estornada', oldPurchase.deleted_at != null);
    const itemLines = db.prepare('SELECT COUNT(*) c FROM purchase_invoice_items WHERE purchase_invoice_id = ? AND deleted_at IS NULL').get(editRes.invoiceId) as { c: number };
    check('edição: itens da nota recriados (2)', itemLines.c === 2, `itens=${itemLines.c}`);

    // ── Edição com estoque vendido: a tela precisa escolher o modo ──
    const divProdId = Number(db.prepare(
      `INSERT INTO products (name, sku, barcode, unit, price_cents, cost_cents, track_stock, active, uuid)
       VALUES ('Produto Divergente', 'DIV1', '7891000888800', 'UN', 1000, 0, 1, 1, ?)`,
    ).run(randomUUID()).lastInsertRowid);
    const divKey = makeAccessKey();
    const divCommit = await api('/api/nfe/commit', { method: 'POST', body: JSON.stringify({
      xml: nfeXml(divKey, 'SEM GTIN'),
      decisions: [
        { line: 1, action: 'link', productId: divProdId, qty: 10, unitCostCents: 500 },
        { line: 2, action: 'ignore', qty: 1, unitCostCents: 800 },
      ],
    }) }, cookie);
    const divRes = await unwrap<{ invoiceId: number }>(divCommit);
    check('divergência: importação inicial responde', divCommit.status === 200, `status=${divCommit.status}`);
    db.prepare('UPDATE products SET stock_qty = 4 WHERE id = ?').run(divProdId); // simula venda de 6

    const editBody = (stockMode: string | null, qty: number) => JSON.stringify({
      stockMode,
      decisions: [
        { line: 1, action: 'link', productId: divProdId, qty, unitCostCents: 500 },
        { line: 2, action: 'ignore', qty: 1, unitCostCents: 800 },
      ],
    });
    const noMode = await api(`/api/nfe/invoices/${divRes.invoiceId}/edit`, { method: 'POST', body: editBody(null, 15) }, cookie);
    const noModeJson = await noMode.json().catch(() => ({})) as { needsStockChoice?: boolean };
    check('divergência: sem modo de estoque -> 409 pedindo escolha',
      noMode.status === 409 && noModeJson.needsStockChoice === true,
      `status=${noMode.status} body=${JSON.stringify(noModeJson)}`);

    const restoreR = await api(`/api/nfe/invoices/${divRes.invoiceId}/edit`, { method: 'POST', body: editBody('restore', 15) }, cookie);
    check('divergência: restaurar estado falha com estoque vendido', restoreR.status === 400, `status=${restoreR.status}`);

    const keepR = await api(`/api/nfe/invoices/${divRes.invoiceId}/edit`, { method: 'POST', body: editBody('keep', 15) }, cookie);
    check('divergência: manter estoque atual responde', keepR.status === 200, `status=${keepR.status}`);
    const divProd = db.prepare('SELECT stock_qty FROM products WHERE id = ?').get(divProdId) as { stock_qty: number };
    check('divergência: saldo preserva a venda (4 - 10 + 15 = 9)', divProd.stock_qty === 9, `saldo=${divProd.stock_qty}`);

    // ── Download do XML original da NF-e de compra ──
    const xmlR = await api(`/api/nfe/invoices/${editRes.invoiceId}/xml`, {}, cookie);
    const xmlBody = await xmlR.text();
    check('download do XML responde', xmlR.status === 200 && xmlBody.includes('<nfeProc'), `status=${xmlR.status}`);
    check('download do XML traz a chave de acesso', xmlBody.includes(editKey));
    check('download do XML vem como anexo',
      (xmlR.headers.get('content-disposition') ?? '').includes(editKey), xmlR.headers.get('content-disposition') ?? '');

    // ── Capability desligada bloqueia a API de novo ──
    check('desliga capability nfe.import',
      (await api('/api/core/capabilities/nfe.import', { method: 'PUT', body: JSON.stringify({ enabled: false }) }, cookie)).status === 200);
    check('capability desligada: preview -> 403',
      (await api('/api/nfe/preview', { method: 'POST', body: JSON.stringify({ xml }) }, cookie)).status === 403);
  } finally {
    server.close();
    closeDb();
  }

  console.log(failures === 0 ? '\nImportação de NF-e: TODOS OS TESTES PASSARAM' : `\n${failures} falha(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
