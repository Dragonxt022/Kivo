/**
 * Teste: gerador de etiquetas (módulo labels).
 *
 * Cobre a ponta inteira: presets de folha semeados no boot, criação de modelo custom,
 * prévia de código de barras e a folha de impressão montada no servidor (posições em mm,
 * código de barras, preço). Roda contra banco descartável:
 *   node scripts/test-isolated.js src/tests/labels.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { migrateUp } from '../core/database/migrator';
import { runSeeds } from '../core/database/seeds';
import { createServer } from '../core/server';
import { getSqlite, closeDb } from '../core/database/connection';
import { activateTestLicense } from './resetTestDb';
import { eanCheckDigit, generateInternalBarcode, validateBarcode } from '../shared/barcode';

const PORT = Number(process.env.KIVO_PORT ?? 3831);
const base = `http://localhost:${PORT}`;
let failures = 0;

function check(label: string, ok: boolean, extra = ''): void {
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

/** O middleware `responseEnvelope` embrulha JSON em `{ success, data }`. */
async function jsonData<T>(r: Response): Promise<T> {
  const body = (await r.json()) as Record<string, unknown>;
  return (body && typeof body === 'object' && 'data' in body ? body.data : body) as T;
}

function assertBancoDescartavel(): string {
  const alvo = process.env.KIVO_DB_PATH;
  if (!alvo) throw new Error('KIVO_DB_PATH não definida. Rode via scripts/test-isolated.js.');
  if (path.resolve(alvo) === path.resolve(process.cwd(), 'database', 'kivo.db')) {
    throw new Error('Recusado: KIVO_DB_PATH aponta para o banco de dev.');
  }
  return alvo;
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

    // Recurso nasce desligado (padrão do manifesto).
    const beforeCap = await api('/api/labels/sheets');
    check('capability desligada bloqueia a API (403)', beforeCap.status === 403, String(beforeCap.status));
    db.prepare("UPDATE capabilities SET enabled = 1 WHERE key = 'labels.generator'").run();

    // Presets de fábrica semeados pelo setup do módulo.
    const pageRes = await api('/app/labels');
    const pageHtml = await pageRes.text();
    check('tela do gerador renderiza', pageRes.ok && pageHtml.includes('Gerador de Etiquetas'), String(pageRes.status));

    const sheetsRes = await api('/api/labels/sheets');
    const sheets = await jsonData<{ id: number; name: string; code: string | null; is_preset: number; cols: number; rows: number }[]>(sheetsRes);
    check('lista de folhas responde', sheetsRes.ok);
    check('presets Pimaco presentes', sheets.some((s) => s.code === '6180') && sheets.some((s) => s.code === '6187'), `${sheets.length} modelos`);
    const preset6180 = sheets.find((s) => s.code === '6180');
    check('6180 é preset 3×10', !!preset6180 && preset6180.is_preset === 1 && preset6180.cols === 3 && preset6180.rows === 10);

    // Produtos: um com EAN válido, um sem código (cai para EAN interno).
    const ean = `789123456789${eanCheckDigit('789123456789')}`;
    const p1 = Number(db.prepare(
      `INSERT INTO products (name, unit, price_cents, cost_cents, track_stock, min_stock, active, barcode, uuid)
       VALUES ('Refrigerante 350ml', 'un', 600, 0, 0, 0, 1, ?, ?)`,
    ).run(ean, randomUUID()).lastInsertRowid);
    const p2 = Number(db.prepare(
      `INSERT INTO products (name, unit, price_cents, cost_cents, track_stock, min_stock, active, uuid)
       VALUES ('Salgado Assado', 'un', 850, 0, 0, 0, 1, ?)`,
    ).run(randomUUID()).lastInsertRowid);

    const search = await api('/api/labels/products?q=Refrigerante');
    const found = await jsonData<{ id: number }[]>(search);
    check('busca de produto do gerador', found.some((p) => p.id === p1));

    const preview = await api(`/api/labels/barcode-preview?symbology=ean13&text=${ean}`);
    const previewBody = await jsonData<{ svg: string; used: string }>(preview);
    check('prévia EAN-13 gera SVG', preview.ok && previewBody.svg.includes('<svg') && previewBody.used === 'ean13', previewBody.used);

    const previewFallback = await api('/api/labels/barcode-preview?symbology=ean13&text=SKU-ABC');
    const fbBody = await jsonData<{ svg: string; used: string; note?: string }>(previewFallback);
    check('código inválido cai para Code128', fbBody.used === 'code128' && !!fbBody.note);

    // Folha de impressão: 2 + 1 = 3 etiquetas no preset 6180.
    const payload = {
      items: [{ id: p1, qty: 2 }, { id: p2, qty: 1 }],
      sheetId: preset6180!.id,
      symbology: 'ean13',
      fields: { name: true, price: true, sku: false, company: true },
    };
    const printRes = await api('/app/labels/imprimir', { method: 'POST', body: JSON.stringify({ payload: JSON.stringify(payload) }) });
    const html = await printRes.text();
    check('folha de impressão responde', printRes.ok, String(printRes.status));
    check('folha tem 3 etiquetas', (html.match(/class="label"/g) ?? []).length === 3);
    check('folha traz nome e preço', html.includes('Refrigerante 350ml') && html.includes('R$ 6,00') && html.includes('R$ 8,50'));
    check('folha traz código de barras', html.includes('<svg') && html.includes('class="l-code"'));
    check('posiciona em mm', html.includes('left:') && html.includes('mm;'));

    // Opção B: produto sem código ganha um EAN interno SALVO no cadastro, senão o bipe no PDV
    // nunca acharia o produto (o PDV resolve por products.barcode).
    const p2Row = db.prepare('SELECT barcode FROM products WHERE id = ?').get(p2) as { barcode: string | null };
    check('EAN interno salvo no produto sem código', !!p2Row?.barcode && p2Row.barcode === generateInternalBarcode(p2) && validateBarcode(p2Row.barcode), String(p2Row?.barcode));
    const p1Row = db.prepare('SELECT barcode FROM products WHERE id = ?').get(p1) as { barcode: string | null };
    check('código de fábrica não foi alterado', p1Row?.barcode === ean, String(p1Row?.barcode));

    // Modelo custom: cria, edita e exclui.
    const createRes = await api('/api/labels/sheets', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Minha folha', page_w_mm: 210, page_h_mm: 297, label_w_mm: 50, label_h_mm: 30,
        cols: 3, rows: 8, margin_top_mm: 10, margin_left_mm: 5, gutter_x_mm: 2, gutter_y_mm: 2,
      }),
    });
    const created = await jsonData<{ id: number; is_preset: number }>(createRes);
    check('cria modelo custom', createRes.status === 201 && created.is_preset === 0, String(createRes.status));

    const editRes = await api(`/api/labels/sheets/${created.id}`, { method: 'PUT', body: JSON.stringify({ name: 'Folha renomeada' }) });
    const edited = await jsonData<{ name: string }>(editRes);
    check('edita modelo custom', editRes.ok && edited.name === 'Folha renomeada');

    const editPreset = await api(`/api/labels/sheets/${preset6180!.id}`, { method: 'PUT', body: JSON.stringify({ name: 'x' }) });
    check('preset de fábrica não é editável', editPreset.status === 400);

    const delRes = await api(`/api/labels/sheets/${created.id}`, { method: 'DELETE' });
    const after = await jsonData<{ id: number }[]>(await api('/api/labels/sheets'));
    check('exclui modelo custom', delRes.ok && !after.some((s) => s.id === created.id));
  } finally {
    server.close();
    closeDb();
  }

  console.log(failures ? `\n${failures} falha(s).` : '\nTodos os testes passaram.');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
