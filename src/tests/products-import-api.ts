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
/** O cabeçalho completo, como sai no modelo e na exportação (16 colunas v1 + 8 de v2). */
const H_COM_UUID = 'uuid;' + H + ';ncm;cest;csosn;cst;origem;tipo;produto_pai;atributos;componentes;ficha_tecnica;grupos_complemento;controla_estoque;visivel_cardapio';

/** Linhas do catálogo completo (v2) montadas por array: nada de errar coluna na mão. */
const v2Csv = (rows: (string | number)[][]): string =>
  H_COM_UUID + '\r\n' + rows.map((r) => r.join(';')).join('\r\n') + '\r\n';

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
    check('export traz as colunas novas (tipo/atributos/componentes...)',
      ['tipo', 'produto_pai', 'atributos', 'componentes', 'ficha_tecnica', 'grupos_complemento', 'controla_estoque', 'visivel_cardapio']
        .every((c) => exText.split('\r\n')[0].includes(c)));

    // ── v2: kit, variante (mestre + filha), produzido e grupos de complemento ──
    db.prepare("UPDATE capabilities SET enabled = 1 WHERE key = 'commercial.variantes'").run();
    db.prepare("UPDATE capabilities SET enabled = 1 WHERE key = 'commercial.complementos'").run();
    const v2Body = v2Csv([
      ['', 'FAR-01', '', 'Farofa Pronta', '', 'Bebidas', 'un', '15,00', '8,00', '0', '', '', '', '', '', '', 'fisico', '', '', '', '', '', 'sim', 'sim'],
      ['', 'CAF-001', '', 'Café Teste', '', 'Bebidas', 'un', '10,00', '4,00', '0', '', '', '', '', '', '', 'fisico', '', '', '', '', '', 'sim', 'sim'],
      ['', 'KIT-T1', '', 'Kit Teste', '', 'Bebidas', 'un', '25,00', '0', '0', '', '', '', '', '', '', 'kit', '', '', 'CAF-001*2|FAR-01*1', '', '', 'sim', 'sim'],
      ['', 'CAM-T1', '', 'Camisa Teste', 'Mestre', 'Bebidas', 'un', '0', '0', '0', '', '', '', '', '', '', 'variante', '', 'Tamanho', '', '', '', 'nao', 'nao'],
      ['', 'CAM-T1-P', '', 'Camisa Teste P', '', 'Bebidas', 'un', '30,00', '10,00', '0', '', '', '', '', '', '', 'variante', 'CAM-T1', 'Tamanho=P', '', '', '', 'sim', 'nao'],
      ['', 'PROD-T1', '', 'Produzido Teste', '', 'Bebidas', 'un', '12,00', '0', '0', '', '', '', '', '', '', 'produzido', '', '', '', 'FAR-01*0,5', '', 'sim', 'nao'],
      ['', 'PROD-T2', '', 'Produto com Grupos', '', 'Bebidas', 'un', '9,00', '3,00', '0', '', '', '', '', '', '', 'fisico', '', '', '', '', 'Bordas|Molhos', 'sim', 'sim'],
    ]);
    const v2cm = await commit(v2Body);
    const v2cmBody = await body<{ criados: number; atualizados: number }>(v2cm);
    check('commit v2 responde 200', v2cm.status === 200, JSON.stringify(v2cmBody));
    check('commit v2 cria os 7 produtos', v2cmBody.criados === 7, JSON.stringify(v2cmBody));

    const kit = db.prepare("SELECT id FROM products WHERE sku = 'KIT-T1'").get() as { id: number };
    const kitItems = db.prepare(
      'SELECT ki.qty, p.sku FROM kit_items ki JOIN products p ON p.id = ki.component_product_id WHERE ki.kit_product_id = ? ORDER BY p.sku',
    ).all(kit.id) as { qty: number; sku: string }[];
    check('kit tem 2 componentes', kitItems.length === 2, JSON.stringify(kitItems));
    check('componentes com as quantidades (CAF-001*2, FAR-01*1)',
      JSON.stringify(kitItems) === JSON.stringify([{ qty: 2, sku: 'CAF-001' }, { qty: 1, sku: 'FAR-01' }]), JSON.stringify(kitItems));

    const mestre = db.prepare("SELECT id, track_stock FROM products WHERE sku = 'CAM-T1'").get() as { id: number; track_stock: number };
    const filha = db.prepare("SELECT * FROM products WHERE sku = 'CAM-T1-P'").get() as { id: number; parent_product_id: number | null; track_stock: number };
    check('filha aponta o pai', filha.parent_product_id === mestre.id, String(filha.parent_product_id));
    check('track_stock canônico: filha = 1, mestre = 0', filha.track_stock === 1 && mestre.track_stock === 0,
      `filha=${filha.track_stock} mestre=${mestre.track_stock}`);
    const pvv = db.prepare(
      `SELECT a.name, v.value FROM product_variant_values pvv
       JOIN product_attributes a ON a.id = pvv.attribute_id
       JOIN product_attribute_values v ON v.id = pvv.attribute_value_id
       WHERE pvv.product_id = ?`,
    ).get(filha.id) as { name: string; value: string };
    check('filha tem atributo Tamanho=P', pvv && pvv.name === 'Tamanho' && pvv.value === 'P', JSON.stringify(pvv));

    const prodT1 = db.prepare("SELECT id FROM products WHERE sku = 'PROD-T1'").get() as { id: number };
    const ri = db.prepare(
      'SELECT ri.qty, p.sku FROM product_recipe_items ri JOIN products p ON p.id = ri.input_product_id WHERE ri.produced_product_id = ?',
    ).get(prodT1.id) as { qty: number; sku: string };
    check('ficha técnica gravada (0,5 de FAR-01)', ri && ri.qty === 0.5 && ri.sku === 'FAR-01', JSON.stringify(ri));

    const prodT2 = db.prepare("SELECT id FROM products WHERE sku = 'PROD-T2'").get() as { id: number };
    const groups = db.prepare(
      'SELECT g.name FROM product_complement_groups pcg JOIN complement_groups g ON g.id = pcg.group_id WHERE pcg.product_id = ? ORDER BY g.name',
    ).all(prodT2.id) as { name: string }[];
    check('PROD-T2 ligado a Bordas e Molhos', groups.length === 2 && groups[0].name === 'Bordas' && groups[1].name === 'Molhos',
      JSON.stringify(groups));

    // ── capability desligada barra a linha (e só a linha) ──
    db.prepare("UPDATE capabilities SET enabled = 0 WHERE key = 'commercial.variantes'").run();
    const pvCap = await preview(v2Csv([['', 'CAM-X', '', 'Variante Sem Capability', '', 'Bebidas', 'un', '0', '0', '0', '', '', '', '', '', '', 'variante', '', '', '', '', '', '', '']]));
    const pvCapBody = await body<{ rows: { status: string; errors: string[] }[] }>(pvCap);
    check('variante com capability desligada → erro no preview',
      pvCapBody.rows?.[0]?.status === 'erro' && JSON.stringify(pvCapBody.rows[0].errors).includes('commercial.variantes'),
      JSON.stringify(pvCapBody.rows?.[0]?.errors));
    db.prepare("UPDATE capabilities SET enabled = 1 WHERE key = 'commercial.variantes'").run();
    const pvCap2 = await preview(v2Csv([['', 'CAM-X', '', 'Variante Capability Ligada', '', 'Bebidas', 'un', '0', '0', '0', '', '', '', '', '', '', 'variante', '', '', '', '', '', '', '']]));
    check('com capability ligada de volta, a mesma linha passa', (await body<{ rows: { status: string }[] }>(pvCap2)).rows?.[0]?.status === 'novo');

    // ── complementos: etapa 2 da importação ──
    const pendenteCsv = v2Csv([['', 'NOVO-PDT', '', 'Produto Pendente', '', 'Bebidas', 'un', '5,00', '1,00', '0', '', '', '', '', '', '', 'fisico', '', '', '', '', '', 'sim', 'nao']]);
    const compCsv = 'grupo;min_selecao;max_selecao;opcao_sku;preco_opcao;ordem\r\n' +
      'Bordas;1;2;CAF-001;;1\r\nBordas;1;2;FAR-01;2,50;2\r\nMolhos;0;1;KIT-T1;;1\r\nMolhos;0;1;NOVO-PDT;;2\r\n';
    const compPreview = (csv: string, productsCsv?: string) =>
      api('/api/commercial/products/complements/import/preview', { method: 'POST', body: JSON.stringify({ csv, productsCsv }) }, cookie);
    const compCommit = (csv: string, productsCsv?: string) =>
      api('/api/commercial/products/complements/import/commit', { method: 'POST', body: JSON.stringify({ csv, productsCsv }) }, cookie);

    const cpv = await compPreview(compCsv, pendenteCsv);
    const cpvBody = await body<{ rows: { status: string; errors: string[] }[]; groups: { name: string; novo: boolean }[] }>(cpv);
    check('preview de complementos responde 200', cpv.status === 200, String(cpv.status));
    check('opção pendente (produtos.csv) é aceita no preview', cpvBody.rows?.[3]?.status === 'novo',
      JSON.stringify(cpvBody.rows?.[3]?.errors));
    check('preview lista 2 grupos', cpvBody.groups?.length === 2, JSON.stringify(cpvBody.groups));

    // Commitar complementos ANTES dos produtos pendentes → erro claro.
    const ccmPre = await compCommit(compCsv, pendenteCsv);
    const ccmPreBody = (await ccmPre.json()) as { error?: string };
    check('commit de complementos antes dos produtos é rejeitado (400)', ccmPre.status === 400, String(ccmPre.status));
    check('erro manda importar primeiro o arquivo de produtos', String(ccmPreBody.error).includes('arquivo de produtos'),
      String(ccmPreBody.error));

    // Commit dos pendentes, depois dos complementos.
    const pendCm = await commit(pendenteCsv);
    check('produtos pendentes commitados', (await body<{ criados: number }>(pendCm)).criados === 1);
    const ccm = await compCommit(compCsv);
    const ccmBody = await body<{ gruposCriados: number; opcoesGravadas: number }>(ccm);
    check('commit de complementos responde 200', ccm.status === 200, JSON.stringify(ccmBody));
    check('1 grupo NÃO criado (Bordas/Molhos já existiam do produtos.csv)', ccmBody.gruposCriados === 0, JSON.stringify(ccmBody));
    check('4 opções gravadas', ccmBody.opcoesGravadas === 4, JSON.stringify(ccmBody));

    const bordas = db.prepare("SELECT min_select, max_select FROM complement_groups WHERE name = 'Bordas'").get() as { min_select: number; max_select: number };
    check('min/max do grupo atualizados (1/2)', bordas.min_select === 1 && bordas.max_select === 2, JSON.stringify(bordas));
    const bordasItems = db.prepare(
      `SELECT p.sku, i.price_override_cents FROM complement_group_items i JOIN products p ON p.id = i.product_id
       WHERE i.group_id = (SELECT id FROM complement_groups WHERE name = 'Bordas') AND i.deleted_at IS NULL ORDER BY i.sort_order`,
    ).all() as { sku: string; price_override_cents: number | null }[];
    check('Bordas com as 2 opções e preço próprio na 2ª',
      JSON.stringify(bordasItems) === JSON.stringify([{ sku: 'CAF-001', price_override_cents: null }, { sku: 'FAR-01', price_override_cents: 250 }]),
      JSON.stringify(bordasItems));
    const molhosNovo = db.prepare(
      'SELECT COUNT(*) n FROM complement_group_items i JOIN products p ON p.id = i.product_id WHERE p.sku = ? AND i.deleted_at IS NULL',
    ).get('NOVO-PDT') as { n: number };
    check('opção NOVO-PDT (criada pelo produtos.csv) entrou no grupo Molhos', molhosNovo.n === 1);

    // Complementos: exportar → reimportar não duplica nem apaga.
    const cex = await api('/api/commercial/products/complements-export.csv', {}, cookie);
    const cexText = await cex.text();
    check('export de complementos responde CSV', cex.status === 200 && cex.headers.get('content-type')!.includes('text/csv'));
    check('export de complementos traz grupos e opções', cexText.includes('Bordas') && cexText.includes('CAF-001'));
    const totalItems = () => (db.prepare('SELECT COUNT(*) n FROM complement_group_items WHERE deleted_at IS NULL').get() as { n: number }).n;
    const antesItems = totalItems();
    const cexRt = await compCommit(cexText);
    check('complementos ida-e-volta responde 200', cexRt.status === 200, await cexRt.text());
    check('complementos ida-e-volta não duplica opções', totalItems() === antesItems, `antes=${antesItems} depois=${totalItems()}`);

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

    // ── ida e volta do catálogo COMPLETO: relações sobrevivem ──
    const ex2 = await api('/api/commercial/products/export.csv', {}, cookie);
    const ex2Text = await ex2.text();
    check('export completo traz kit com componentes', ex2Text.includes('CAF-001*2|FAR-01*1'), ex2Text.split('\r\n')[1]);
    check('export completo traz filha com pai e atributos', ex2Text.includes('CAM-T1-P') && ex2Text.includes('Tamanho=P'));
    const antes2 = countProducts();
    const rt2 = await commit(ex2Text);
    const rt2Body = await body<{ criados: number; atualizados: number }>(rt2);
    check('ida e volta (catálogo completo) responde 200', rt2.status === 200, JSON.stringify(rt2Body));
    check('ida e volta completo não cria produto', countProducts() === antes2, `antes=${antes2} depois=${countProducts()}`);
    check('ida e volta completo só atualiza', rt2Body.criados === 0, JSON.stringify(rt2Body));
    const kitPos = db.prepare(
      'SELECT COUNT(*) n FROM kit_items WHERE kit_product_id = ? AND deleted_at IS NULL',
    ).get(kit.id) as { n: number };
    check('relações do kit sobrevivem à ida e volta', kitPos.n === 2, String(kitPos.n));
    const filhaPos = db.prepare("SELECT parent_product_id, track_stock FROM products WHERE sku = 'CAM-T1-P'").get() as { parent_product_id: number | null; track_stock: number };
    check('filha continua com pai e track_stock=1 após ida e volta',
      filhaPos.parent_product_id === mestre.id && filhaPos.track_stock === 1, JSON.stringify(filhaPos));
  } finally {
    server.close();
    closeDb();
    console.log(failures ? `\n${failures} FALHA(S)` : '\nTodos os testes passaram.');
    process.exit(failures ? 1 : 0);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
