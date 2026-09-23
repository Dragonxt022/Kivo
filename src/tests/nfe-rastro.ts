/**
 * NF-e com rastro (lote/validade) → lotes no estoque.
 *
 * Cobre: parse do `<rastro>` (nLote/dVal/qLote), criação de lotes na importação para
 * produto que controla lote, divisão de uma linha entre dois lotes e o produto novo que
 * já nasce controlando lote quando a nota traz rastro.
 *
 *   node scripts/test-isolated.js src/tests/nfe-rastro.ts
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

const PORT = Number(process.env.KIVO_PORT ?? 3862);
const base = `http://localhost:${PORT}`;
let failures = 0;
function check(label: string, ok: boolean, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures++;
}

let cookie = '';
async function api(p: string, opts: RequestInit = {}): Promise<Response> {
  return fetch(`${base}${p}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}), ...(opts.headers ?? {}) },
  });
}

function assertBancoDescartavel(): string {
  const alvo = process.env.KIVO_DB_PATH;
  if (!alvo) throw new Error('KIVO_DB_PATH não definida — rode via scripts/test-isolated.js.');
  if (path.resolve(alvo) === path.resolve(process.cwd(), 'database', 'kivo.db')) {
    throw new Error('Recusado: KIVO_DB_PATH aponta para o banco de dev.');
  }
  return alvo;
}

function makeAccessKey(): string {
  const b = Array.from({ length: 43 }, () => String(Math.floor(Math.random() * 10))).join('');
  let sum = 0, weight = 2;
  for (let i = b.length - 1; i >= 0; i--) { sum += Number(b[i]) * weight; weight = weight === 9 ? 2 : weight + 1; }
  const dv = 11 - (sum % 11);
  return b + (dv >= 10 ? '0' : String(dv));
}

/** Uma NF-e com dois itens: o 1º com um lote; o 2º com dois lotes (qLote 6 + 4). */
function nfeXml(accessKey: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<nfeProc versao="4.00" xmlns="http://www.portalfiscal.inf.br/nfe">
  <NFe>
    <infNFe Id="NFe${accessKey}" versao="4.00">
      <ide><cUF>35</cUF><mod>55</mod><serie>1</serie><nNF>909</nNF><dhEmi>2026-03-10T10:00:00-03:00</dhEmi></ide>
      <emit><CNPJ>11222333000181</CNPJ><xNome>Distribuidora Teste LTDA</xNome></emit>
      <dest><CNPJ>22333444000199</CNPJ><xNome>Mercado Dois Irmaos</xNome></dest>
      <det nItem="1"><prod>
        <cProd>IOG-1</cProd><cEAN>SEM GTIN</cEAN><xProd>Iogurte Natural</xProd>
        <NCM>04031000</NCM><CFOP>2101</CFOP><uCom>UN</uCom><qCom>10</qCom><vUnCom>5.00</vUnCom><vProd>50.00</vProd>
        <rastro><nLote>L-1</nLote><qLote>10</qLote><dFab>2026-01-01</dFab><dVal>2027-01-01</dVal></rastro>
      </prod></det>
      <det nItem="2"><prod>
        <cProd>QUEI-1</cProd><cEAN>SEM GTIN</cEAN><xProd>Queijo Minas</xProd>
        <NCM>04061010</NCM><CFOP>2101</CFOP><uCom>UN</uCom><qCom>10</qCom><vUnCom>8.00</vUnCom><vProd>80.00</vProd>
        <rastro><nLote>QA</nLote><qLote>6</qLote><dVal>2026-06-30</dVal></rastro>
        <rastro><nLote>QB</nLote><qLote>4</qLote><dVal>2026-12-31</dVal></rastro>
      </prod></det>
      <total><ICMSTot><vNF>130.00</vNF></ICMSTot></total>
    </infNFe>
  </NFe>
</nfeProc>`;
}

async function main(): Promise<void> {
  const tmp = assertBancoDescartavel();
  fs.mkdirSync(path.dirname(tmp), { recursive: true });
  fs.rmSync(tmp, { force: true });
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
    await api('/api/core/capabilities/nfe.import', { method: 'PUT', body: JSON.stringify({ enabled: true }) });

    // Produto já cadastrado, controlando lote, para o item 1.
    const iogurteId = Number(db.prepare(
      `INSERT INTO products (name, barcode, unit, price_cents, cost_cents, track_stock, controla_lote, active, uuid)
       VALUES ('Iogurte Natural', NULL, 'un', 900, 0, 1, 1, 1, ?)`,
    ).run(randomUUID()).lastInsertRowid);
    check('produto com lote criado', iogurteId > 0);

    const key = makeAccessKey();
    const xml = nfeXml(key);

    const commitR = await api('/api/nfe/commit', { method: 'POST', body: JSON.stringify({
      xml,
      decisions: [
        { line: 1, action: 'link', productId: iogurteId, qty: 10, unitCostCents: 500 },
        { line: 2, action: 'create', productId: null, qty: 10, unitCostCents: 800 },
      ],
    }) });
    check('commit responde', commitR.status === 200, `status=${commitR.status}`);

    // Item 1: lote L-1 com validade e custo.
    const lote1 = db.prepare('SELECT code, expires_at, qty, cost_cents FROM product_lots WHERE product_id = ?').get(iogurteId) as
      { code: string; expires_at: string; qty: number; cost_cents: number } | undefined;
    check('lote L-1 criado com validade', lote1?.code === 'L-1' && lote1?.expires_at === '2027-01-01', JSON.stringify(lote1));
    check('lote L-1 com 10 un a 5,00', lote1?.qty === 10 && lote1?.cost_cents === 500, JSON.stringify(lote1));

    // Item 2: produto novo nasce controlando lote, com os dois lotes do rastro.
    const queijo = db.prepare("SELECT id, controla_lote FROM products WHERE name = 'Queijo Minas'").get() as
      { id: number; controla_lote: number } | undefined;
    check('produto novo com rastro nasce controlando lote', queijo?.controla_lote === 1, JSON.stringify(queijo));
    const lotesQueijo = db.prepare('SELECT code, qty FROM product_lots WHERE product_id = ? ORDER BY code').all(queijo!.id) as
      { code: string; qty: number }[];
    check('linha dividida em dois lotes (6 + 4)', lotesQueijo.length === 2
      && lotesQueijo[0].code === 'QA' && lotesQueijo[0].qty === 6
      && lotesQueijo[1].code === 'QB' && lotesQueijo[1].qty === 4, JSON.stringify(lotesQueijo));

    // Saldo do produto vinculado bate com o lote.
    const saldo = db.prepare('SELECT stock_qty FROM products WHERE id = ?').get(iogurteId) as { stock_qty: number };
    check('estoque do iogurte = 10', saldo.stock_qty === 10, `saldo=${saldo.stock_qty}`);

    // Download/preview continuam funcionando (rastro não quebra o resto).
    const prevR = await api('/api/nfe/preview', { method: 'POST', body: JSON.stringify({ xml: nfeXml(makeAccessKey()) }) });
    const prev = await unwrap<{ items: { line: number }[] }>(prevR);
    check('preview de nota com rastro responde', prevR.status === 200 && prev.items.length === 2, `status=${prevR.status}`);
  } finally {
    server.close();
    closeDb();
  }

  console.log(failures === 0 ? '\nNF-e com rastro: TODOS OS TESTES PASSARAM' : `\n${failures} falha(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
