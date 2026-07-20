/**
 * Teste de integração da importação/exportação de produtos (rotas + banco).
 *
 * KIVO_DB_PATH TEM que vir do ambiente, não ser setado aqui dentro:
 *   npx tsx src/tests/products-import-api.ts   ← NÃO faça isso direto
 *   node scripts/kivo test:products-import    ← use o comando (define a env var)
 *
 * Motivo: `import` é hoisted. Um `process.env.KIVO_DB_PATH = ...` no topo deste
 * arquivo roda DEPOIS de connection.ts já ter lido a variável e fixado o caminho —
 * o teste rodaria contra database/kivo.db, o mesmo banco do `npm run dev`.
 * A checagem abaixo é a rede de segurança para isso.
 */
import fs from 'node:fs';
import path from 'node:path';

import { migrateUp } from '../core/database/migrator';
import { runSeeds } from '../core/database/seeds';
import { createServer } from '../core/server';
import { getSqlite, closeDb } from '../core/database/connection';
import { activateTestLicense } from './resetTestDb';
import { unwrap } from './testUtils';

const PORT = Number(process.env.KIVO_PORT ?? 3711);
const base = `http://localhost:${PORT}`;
let failures = 0;

function check(label: string, ok: boolean, extra = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures++;
}

async function api(p: string, opts: RequestInit = {}, cookie?: string): Promise<Response> {
  return fetch(`${base}${p}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}), ...(opts.headers ?? {}) },
  });
}

/** Sem a coluna uuid: cobre também o arquivo que o cliente monta na mão. */
const H = 'sku;codigo_barras;nome;descricao;categoria;unidade;preco_venda;preco_custo;estoque_minimo;estoque_inicial';
/** O cabeçalho completo, como sai no modelo e na exportação. */
const H_COM_UUID = 'uuid;' + H;

/**
 * Trava: aborta ANTES de migrar/semear se o banco alvo não for descartável.
 * É o que impede este teste de recriar o banco de quem está desenvolvendo.
 */
function assertBancoDescartavel(): string {
  const alvo = process.env.KIVO_DB_PATH;
  if (!alvo) {
    throw new Error(
      'KIVO_DB_PATH não definida. Este teste APAGA o banco que usar — rode via `node scripts/kivo test:products-import`, ' +
      'que aponta para um arquivo temporário. Nunca `npx tsx` direto.',
    );
  }
  const devDb = path.resolve(process.cwd(), 'database', 'kivo.db');
  if (path.resolve(alvo) === devDb) {
    throw new Error(`Recusado: KIVO_DB_PATH aponta para o banco de dev (${devDb}).`);
  }
  return alvo;
}

async function main(): Promise<void> {
  const TMP_DB = assertBancoDescartavel();
  fs.mkdirSync(path.dirname(TMP_DB), { recursive: true });
  fs.rmSync(TMP_DB, { force: true }); // começa do zero a cada execução

  migrateUp();
  runSeeds();
  activateTestLicense();
  const { app } = await createServer();
  const server = app.listen(PORT);
  const db = getSqlite();

  try {
    const r = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'admin', password: 'admin' }) });
    const m = (r.headers.get('set-cookie') ?? '').match(/kivo_session=([^;]+)/);
    const cookie = m ? `kivo_session=${m[1]}` : null;
    check('login admin', !!cookie);
    if (!cookie) return;

    const preview = (csv: string) =>
      api('/api/commercial/products/import/preview', { method: 'POST', body: JSON.stringify({ csv }) }, cookie);
    const commit = (csv: string) =>
      api('/api/commercial/products/import/commit', { method: 'POST', body: JSON.stringify({ csv }) }, cookie);
    // A API responde { success, data } — unwrap devolve só o data.
    const body = <T>(r: Response): Promise<T> => unwrap<T>(r);
    const countProducts = () => (db.prepare('SELECT COUNT(*) n FROM products WHERE deleted_at IS NULL').get() as { n: number }).n;

    // ── modelo ──
    const tpl = await api('/api/commercial/products/import-template.csv', {}, cookie);
    const tplBytes = Buffer.from(await tpl.arrayBuffer());
    const tplText = tplBytes.toString('utf8');
    check('modelo baixa como CSV', tpl.status === 200 && tpl.headers.get('content-type')!.includes('text/csv'));
    // Nos bytes, não no texto: text() já teria comido o BOM.
    check('modelo vem com BOM (Excel lê acento certo)', tplBytes[0] === 0xef && tplBytes[1] === 0xbb && tplBytes[2] === 0xbf,
      tplBytes.subarray(0, 3).toString('hex'));
    const tplHeader = tplText.replace(/^\uFEFF/, '').split('\r\n')[0];
    check('modelo traz o cabeçalho esperado', tplHeader === H_COM_UUID, tplHeader);
    check('modelo usa ; como separador (padrão do Excel BR)', tplHeader.includes(';') && !tplHeader.includes(','));

    // ── preview não grava nada ──
    const antes = countProducts();
    const pv = await preview(`${H}\r\nA-1;;Produto A;;Bebidas;un;10,00;5,00;2;7\r\n`);
    const pvBody = await body<{ rows: { status: string }[]; newCategories: string[] }>(pv);
    check('preview responde 200', pv.status === 200, String(pv.status));
    check('preview marca linha como nova', pvBody.rows?.[0]?.status === 'novo');
    check('preview lista categoria nova', JSON.stringify(pvBody.newCategories) === '["Bebidas"]');
    check('PREVIEW NÃO GRAVA NADA', countProducts() === antes, `antes=${antes} depois=${countProducts()}`);

    // ── commit cria produto, categoria e estoque via movimentação ──
    const cm = await commit(`${H}\r\nA-1;;Produto A;Desc;Bebidas;un;10,00;5,00;2;7\r\n`);
    const cmBody = await body<{ criados: number; atualizados: number; categoriasCriadas: number }>(cm);
    check('commit responde 200', cm.status === 200, JSON.stringify(cmBody));
    check('commit reporta 1 criado', cmBody.criados === 1, JSON.stringify(cmBody));
    check('commit reporta 1 categoria criada', cmBody.categoriasCriadas === 1);

    const p = db.prepare("SELECT * FROM products WHERE sku = 'A-1'").get() as Record<string, unknown>;
    check('produto gravado', !!p);
    check('preço em centavos (10,00 → 1000)', p.price_cents === 1000, String(p.price_cents));
    check('custo em centavos (5,00 → 500)', p.cost_cents === 500, String(p.cost_cents));
    check('tipo fisico', p.product_type === 'fisico');
    check('uuid gerado (sync depende dele)', typeof p.uuid === 'string' && (p.uuid as string).length > 30);
    check('categoria vinculada', !!p.category_id);

    // A garantia central: saldo veio do ledger, não de escrita direta.
    check('estoque inicial aplicado (7)', p.stock_qty === 7, String(p.stock_qty));
    const mov = db.prepare('SELECT * FROM stock_movements WHERE product_id = ?').all(p.id) as Record<string, unknown>[];
    check('estoque gerou MOVIMENTAÇÃO (não escrita direta)', mov.length === 1, `movimentos=${mov.length}`);
    check('movimentação é entrada de 7', mov[0]?.type === 'entrada' && mov[0]?.qty === 7);
    check('movimentação registra balance_after = 7', mov[0]?.balance_after === 7);
    check('saldo do produto == soma do ledger', p.stock_qty === mov[0]?.balance_after);

    // ── reimportar o mesmo SKU atualiza, não duplica ──
    const up = await commit(`${H}\r\nA-1;;Produto A Renomeado;;Bebidas;un;12,00;5,00;2;\r\n`);
    const upBody = await body<{ criados: number; atualizados: number; categoriasCriadas: number }>(up);
    check('reimportar atualiza (não cria)', upBody.atualizados === 1 && upBody.criados === 0, JSON.stringify(upBody));
    const p2 = db.prepare("SELECT * FROM products WHERE sku = 'A-1'").get() as Record<string, unknown>;
    check('nome atualizado', p2.name === 'Produto A Renomeado');
    check('preço atualizado (1200)', p2.price_cents === 1200);
    check('NÃO duplicou categoria "Bebidas"', upBody.categoriasCriadas === 0);
    check('estoque intacto no update (7)', p2.stock_qty === 7, String(p2.stock_qty));
    check('update não gerou movimentação nova',
      (db.prepare('SELECT COUNT(*) n FROM stock_movements WHERE product_id = ?').get(p.id) as { n: number }).n === 1);

    // ── arquivo com erro: tudo-ou-nada ──
    const n1 = countProducts();
    const bad = await commit(`${H}\r\nOK-1;;Bom;;Bebidas;un;1,00;0;0;\r\nDUP;;Um;;Bebidas;un;1,00;0;0;\r\nDUP;;Dois;;Bebidas;un;1,00;0;0;\r\n`);
    const badBody = (await bad.json()) as { error?: string };
    check('commit com duplicata é rejeitado (400)', bad.status === 400, String(bad.status));
    check('erro explica o motivo', String(badBody.error).includes('erro'), String(badBody.error));
    check('NADA foi gravado — nem a linha boa (tudo-ou-nada)', countProducts() === n1, `antes=${n1} depois=${countProducts()}`);

    // ── categoria repetida com grafia diferente não vira duas ──
    const catAntes = (db.prepare('SELECT COUNT(*) n FROM categories WHERE deleted_at IS NULL').get() as { n: number }).n;
    await commit(`${H}\r\nC-1;;Um;;Doces;un;1,00;0;0;\r\nC-2;;Dois;;doces;un;1,00;0;0;\r\n`);
    const catDepois = (db.prepare('SELECT COUNT(*) n FROM categories WHERE deleted_at IS NULL').get() as { n: number }).n;
    check('"Doces" e "doces" criam UMA categoria só', catDepois === catAntes + 1, `antes=${catAntes} depois=${catDepois}`);

    // ── código de barras: mesma regra do cadastro manual (shared/barcode) ──
    // EAN-13 com dígito verificador errado (o correto termina em 7) é barrado.
    const bc = await preview(`${H}\r\nX-9;7891000315508;Ruim;;Bebidas;un;1,00;0;0;\r\n`);
    const bcBody = await body<{ rows: { status: string; errors: string[] }[] }>(bc);
    check('EAN-13 com dígito verificador errado vira erro no preview',
      bcBody.rows?.[0]?.status === 'erro' && JSON.stringify(bcBody.rows[0].errors).includes('dígito'),
      JSON.stringify(bcBody.rows?.[0]?.errors));

    // Código livre (não-EAN) passa: validateBarcode só checa dígito em 8/12/13 dígitos,
    // porque nem todo código de fornecedor é EAN/UPC. O import segue a mesma regra.
    const bcFree = await preview(`${H}\r\nX-10;ABC-123-XYZ;Livre;;Bebidas;un;1,00;0;0;\r\n`);
    const bcFreeBody = await body<{ rows: { status: string; errors: string[] }[] }>(bcFree);
    check('código de barras livre (não-EAN) é aceito, como no cadastro manual',
      bcFreeBody.rows?.[0]?.status === 'novo', JSON.stringify(bcFreeBody.rows?.[0]?.errors));

    // ── exportação ──
    const ex = await api('/api/commercial/products/export.csv', {}, cookie);
    const exText = await ex.text();
    check('export responde CSV', ex.status === 200 && ex.headers.get('content-type')!.includes('text/csv'));
    check('export tem Content-Disposition (baixa como arquivo)', (ex.headers.get('content-disposition') ?? '').includes('attachment'));
    check('export traz o produto importado', exText.includes('Produto A Renomeado'));
    check('export formata preço no padrão BR (12,00)', exText.includes('12,00'), exText.split('\r\n')[1]);
    check('export traz a coluna estoque_atual', exText.split('\r\n')[0].includes('estoque_atual'));

    // ── ida e volta: exportar → importar de volta não muda nada ──
    const antesRt = countProducts();
    const rt = await commit(exText);
    const rtBody = await body<{ criados: number; atualizados: number }>(rt);
    check('exportado importa de volta sem erro (ida e volta)', rt.status === 200, JSON.stringify(rtBody));
    check('ida e volta não cria produto novo', countProducts() === antesRt, `antes=${antesRt} depois=${countProducts()}`);
    check('ida e volta só atualiza', rtBody.criados === 0, JSON.stringify(rtBody));
    const p3 = db.prepare("SELECT * FROM products WHERE sku = 'A-1'").get() as Record<string, unknown>;
    check('ida e volta preserva o preço (1200)', p3.price_cents === 1200, String(p3.price_cents));
    check('ida e volta preserva o estoque (7)', p3.stock_qty === 7, String(p3.stock_qty));
  } finally {
    server.close();
    closeDb();
    console.log(failures ? `\n${failures} FALHA(S)` : '\nTodos os testes passaram.');
    process.exit(failures ? 1 : 0);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
