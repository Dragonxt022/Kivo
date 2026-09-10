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
      <emit><CNPJ>11222333000181</CNPJ><xNome>Distribuidora Teste LTDA</xNome><xFant>Dist Teste</xFant></emit>
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
    const supplier = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(invoice.supplier_id) as { name: string; document: string };
    check('fornecedor criado pelo CNPJ do XML', supplier.document === '11222333000181' && supplier.name.includes('Distribuidora Teste'));

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
