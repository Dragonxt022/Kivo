/**
 * Teste: o PDV lê e vende TODOS os tipos de produto do catálogo.
 *
 * Nasceu de um bug real: uma loja importou o catálogo inteiro como produto com
 * variações (sofá em tamanhos/níveis de sujeira) e o "Consultar produtos" do PDV
 * respondia "Nenhum produto encontrado" com 32 produtos cadastrados. A listagem sem
 * busca usava listTopLevel(), que só devolve produto SEM pai — ou seja, descartava
 * exatamente as variantes filhas, as únicas vendáveis daquele catálogo.
 *
 * Por isso o teste cobre as duas metades do PDV para cada tipo:
 *   LEITURA — a listagem do modal (scope=sellable), a busca por nome, por SKU e a
 *             bipagem do código de barras;
 *   VENDA   — fechar a venda e conferir o que ela fez no estoque (kit explode em
 *             componentes, produzido consome a ficha técnica, serviço não mexe).
 *
 * KIVO_DB_PATH TEM que vir do ambiente — este teste recria o banco que usar:
 *   node scripts/kivo test:pdv-tipos    ← use o comando
 *   npx tsx src/tests/pdv-tipos-produto.ts   ← NÃO: apagaria o banco de dev
 * (`import` é hoisted; setar a env var dentro do arquivo roda tarde demais, depois de
 * connection.ts já ter fixado o caminho. A trava abaixo é a rede de segurança.)
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

const PORT = Number(process.env.KIVO_PORT ?? 3812);
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

interface ApiProduct {
  id: number; name: string; sku: string | null; price_cents: number;
  product_type: string; track_stock: number; stock_qty: number;
}

function assertBancoDescartavel(): string {
  const alvo = process.env.KIVO_DB_PATH;
  if (!alvo) {
    throw new Error(
      'KIVO_DB_PATH não definida. Este teste APAGA o banco que usar — rode via ' +
      '`node scripts/kivo test:pdv-tipos`, que aponta para um arquivo temporário.',
    );
  }
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

    // Kits, produção, variantes e complementos são gated por capability. Ligadas aqui
    // porque o cenário do teste é a loja que USA esses tipos.
    db.prepare("UPDATE capabilities SET enabled = 1 WHERE key IN ('commercial.kits','commercial.producao','commercial.variantes','commercial.complementos')").run();

    // ── Catálogo: um produto de cada tipo ─────────────────────────────────────────
    // Direto no SQL de propósito: as rotas de cada tipo têm regras próprias (gerar
    // grade, montar ficha técnica) e o alvo aqui é o PDV, não o cadastro.
    const mk = (
      name: string, type: string,
      o: { price?: number; cost?: number; track?: number; sku?: string; barcode?: string; parent?: number; unit?: string } = {},
    ): number => Number(db.prepare(
      `INSERT INTO products (name, sku, barcode, unit, price_cents, cost_cents, track_stock, min_stock,
         active, product_type, parent_product_id, category_id, uuid)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, 1, ?, ?, NULL, ?)`,
    ).run(
      name, o.sku ?? null, o.barcode ?? null, o.unit ?? 'un',
      o.price ?? 1000, o.cost ?? 400, o.track ?? 1, type, o.parent ?? null, randomUUID(),
    ).lastInsertRowid);

    const fisico = mk('Caneca Branca', 'fisico', { price: 2500, sku: 'CAN-001', barcode: '7891000315507' });
    const fracionado = mk('Queijo Minas', 'fracionado', { price: 5000, sku: 'QJO-001', unit: 'kg' });
    const servico = mk('Instalação Elétrica', 'servico', { price: 15000, sku: 'SRV-001', track: 0 });
    const digital = mk('E-book Receitas', 'digital', { price: 3000, sku: 'DIG-001', track: 0 });
    const assinatura = mk('Plano Mensal', 'assinatura', { price: 9900, sku: 'ASS-001', track: 0 });
    const comp1 = mk('Pão Francês', 'fisico', { price: 100, cost: 50, sku: 'PAO-001' });
    const comp2 = mk('Café 500g', 'fisico', { price: 1890, cost: 1250, sku: 'CAF-001' });
    const kit = mk('Café da Manhã', 'kit', { price: 2500, track: 0, sku: 'KIT-001' });
    const combo = mk('Combo Lanche', 'combo', { price: 3000, track: 0, sku: 'CBO-001' });
    const farinha = mk('Farinha (insumo)', 'fisico', { price: 0, cost: 600, sku: 'FAR-001' });
    const produzido = mk('Bolo Caseiro', 'produzido', { price: 4000, track: 0, sku: 'BOL-001' });
    const bordas = mk('Borda Catupiry', 'complemento', { price: 800, track: 0, sku: 'CPL-001' });
    // Grade: o mestre não se vende; as filhas sim, com preço e código próprios.
    const mestre = mk('Sofá Retrátil', 'variante', { price: 0, track: 0, sku: 'SOF-000', barcode: '7891000053508' });
    const varLeve = mk('Sofá Retrátil - Leve', 'variante', { price: 16000, sku: 'SOF-L', parent: mestre });
    const varPesada = mk('Sofá Retrátil - Pesada', 'variante', { price: 27000, sku: 'SOF-P', parent: mestre, barcode: '7891910000197' });

    const link = (table: string, a: string, b: string, parent: number, child: number, qty: number): void => {
      db.prepare(`INSERT INTO ${table} (${a}, ${b}, qty, sort_order, uuid) VALUES (?, ?, ?, 0, ?)`)
        .run(parent, child, qty, randomUUID());
    };
    link('kit_items', 'kit_product_id', 'component_product_id', kit, comp2, 1);
    link('kit_items', 'kit_product_id', 'component_product_id', kit, comp1, 2);
    link('kit_items', 'kit_product_id', 'component_product_id', combo, comp1, 1);
    link('product_recipe_items', 'produced_product_id', 'input_product_id', produzido, farinha, 0.5);

    const estoqueInicial = async (id: number, qty: number): Promise<void> => {
      await api('/api/commercial/stock/move', {
        method: 'POST', body: JSON.stringify({ productId: id, type: 'entrada', qty, reason: 'estoque inicial' }),
      });
    };
    for (const id of [fisico, comp1, comp2, farinha, varLeve, varPesada]) await estoqueInicial(id, 100);
    await estoqueInicial(fracionado, 10);

    // ── LEITURA 1: a listagem do "Consultar produtos" (modal do PDV) ───────────────
    const sellable = await unwrap<ApiProduct[]>(await api('/api/commercial/products?scope=sellable'));
    const idsSellable = new Set(sellable.map((p) => p.id));
    const esperados: [string, number][] = [
      ['físico', fisico], ['fracionado', fracionado], ['serviço', servico], ['digital', digital],
      ['assinatura', assinatura], ['kit', kit], ['combo', combo], ['produzido', produzido],
      ['complemento', bordas], ['variante filha', varLeve],
    ];
    for (const [label, id] of esperados) {
      check(`consultar produtos lista ${label}`, idsSellable.has(id));
    }
    check('consultar produtos NÃO lista o produto com variações (só as variações)', !idsSellable.has(mestre));

    // A regressão que originou este teste: catálogo 100% em grade aparecia vazio.
    const soGrade = sellable.filter((p) => p.product_type === 'variante');
    check('catálogo em grade aparece na listagem (bug do "Nenhum produto encontrado")',
      soGrade.length === 2, `${soGrade.length} variantes visíveis`);

    // ── LEITURA 2: busca por nome, SKU e código de barras ─────────────────────────
    const busca = async (q: string): Promise<ApiProduct[]> =>
      unwrap<ApiProduct[]>(await api('/api/commercial/products?q=' + encodeURIComponent(q)));

    const porNome = await busca('Sofá Retrátil');
    check('busca por nome traz as 2 variações', porNome.length === 2, `${porNome.length} resultado(s)`);
    check('busca por nome não traz o produto com variações', !porNome.some((p) => p.id === mestre));
    check('busca por SKU acha a variação', (await busca('SOF-P'))[0]?.id === varPesada);
    check('bipar o código de barras acha a variação', (await busca('7891910000197'))[0]?.id === varPesada);
    check('bipar o código de barras acha o produto físico', (await busca('7891000315507'))[0]?.id === fisico);
    check('bipar o código de barras do produto com variações não vende nada',
      (await busca('7891000053508')).length === 0);
    check('busca acha kit', (await busca('Café da Manhã'))[0]?.id === kit);
    check('busca acha serviço', (await busca('Instalação'))[0]?.id === servico);
    check('busca acha complemento', (await busca('Borda'))[0]?.id === bordas);

    // ── VENDA: um a um, conferindo o efeito no estoque ────────────────────────────
    check('abre o caixa', (await api('/api/finance/cash/open', { method: 'POST', body: JSON.stringify({ openingCents: 0 }) })).status === 201);

    const saldo = (id: number): number =>
      (db.prepare('SELECT stock_qty FROM products WHERE id = ?').get(id) as { stock_qty: number }).stock_qty;
    const vender = async (items: { productId: number; qty: number }[]): Promise<Response> =>
      api('/api/store/sales', { method: 'POST', body: JSON.stringify({ items, paymentMethod: 'pix' }) });
    const itensDaVenda = (saleId: number): { product_id: number; qty: number; total_cents: number }[] =>
      db.prepare('SELECT product_id, qty, total_cents FROM sale_items WHERE sale_id = ? ORDER BY id').all(saleId) as
        { product_id: number; qty: number; total_cents: number }[];

    // Físico: baixa 1:1.
    const r1 = await vender([{ productId: fisico, qty: 2 }]);
    const v1 = await unwrap<{ id: number; totalCents: number }>(r1);
    check('vende produto físico', r1.status === 201 && v1.totalCents === 5000, `total=${v1?.totalCents}`);
    check('físico baixa o estoque', saldo(fisico) === 98, `saldo=${saldo(fisico)}`);

    // Fracionado: quantidade decimal atravessa inteira até o saldo.
    const r2 = await vender([{ productId: fracionado, qty: 0.35 }]);
    const v2 = await unwrap<{ id: number; totalCents: number }>(r2);
    check('vende fracionado com quantidade decimal', r2.status === 201 && v2.totalCents === 1750, `total=${v2?.totalCents}`);
    check('fracionado baixa o estoque em decimal', saldo(fracionado) === 9.65, `saldo=${saldo(fracionado)}`);

    // Serviço / digital / assinatura: vendem sem mexer em estoque.
    for (const [label, id, total] of [['serviço', servico, 15000], ['digital', digital, 3000], ['assinatura', assinatura, 9900]] as [string, number, number][]) {
      const r = await vender([{ productId: id, qty: 1 }]);
      const v = await unwrap<{ id: number; totalCents: number }>(r);
      check(`vende ${label}`, r.status === 201 && v.totalCents === total, `total=${v?.totalCents}`);
      const movs = db.prepare('SELECT COUNT(*) c FROM stock_movements WHERE product_id = ?').get(id) as { c: number };
      check(`${label} não gera movimentação de estoque`, movs.c === 0);
    }

    // Kit: uma linha de preço + os componentes a zero, cada um baixando estoque.
    const antesCaf = saldo(comp2), antesPao = saldo(comp1);
    const r3 = await vender([{ productId: kit, qty: 2 }]);
    const v3 = await unwrap<{ id: number; totalCents: number }>(r3);
    check('vende kit', r3.status === 201 && v3.totalCents === 5000, `total=${v3?.totalCents}`);
    const itensKit = itensDaVenda(v3.id);
    check('kit grava a linha do kit + os componentes', itensKit.length === 3, `${itensKit.length} linhas`);
    check('componentes do kit entram a preço zero (o preço é o do kit)',
      itensKit.filter((i) => i.product_id !== kit).every((i) => i.total_cents === 0));
    check('kit baixa o estoque dos componentes (café 2, pão 4)',
      saldo(comp2) === antesCaf - 2 && saldo(comp1) === antesPao - 4,
      `café=${saldo(comp2)} pão=${saldo(comp1)}`);

    // Combo: mesma mecânica do kit.
    const antesPaoCombo = saldo(comp1);
    const r4 = await vender([{ productId: combo, qty: 1 }]);
    const v4 = await unwrap<{ id: number; totalCents: number }>(r4);
    check('vende combo', r4.status === 201 && v4.totalCents === 3000, `total=${v4?.totalCents}`);
    check('combo baixa o estoque do componente', saldo(comp1) === antesPaoCombo - 1);

    // Produzido: não tem estoque próprio, consome a ficha técnica.
    const antesFarinha = saldo(farinha);
    const r5 = await vender([{ productId: produzido, qty: 3 }]);
    const v5 = await unwrap<{ id: number; totalCents: number }>(r5);
    check('vende produzido', r5.status === 201 && v5.totalCents === 12000, `total=${v5?.totalCents}`);
    check('produzido consome a ficha técnica (0,5 × 3 = 1,5 de farinha)',
      saldo(farinha) === antesFarinha - 1.5, `farinha=${saldo(farinha)}`);
    check('produzido grava o custo vindo da ficha técnica',
      (db.prepare('SELECT cost_cents FROM sale_items WHERE sale_id = ? AND product_id = ?').get(v5.id, produzido) as { cost_cents: number }).cost_cents === 300);

    // Variação: vende a filha, com o preço dela — não o do mestre.
    const r6 = await vender([{ productId: varPesada, qty: 1 }]);
    const v6 = await unwrap<{ id: number; totalCents: number }>(r6);
    check('vende a variação pelo preço dela', r6.status === 201 && v6.totalCents === 27000, `total=${v6?.totalCents}`);
    check('variação baixa o próprio estoque', saldo(varPesada) === 99, `saldo=${saldo(varPesada)}`);

    // Complemento: linha própria, agrupada ao item pai por line_group_uuid.
    const grupo = randomUUID();
    const r7 = await api('/api/store/sales', {
      method: 'POST',
      body: JSON.stringify({
        items: [
          { productId: fisico, qty: 1, lineGroupUuid: grupo },
          { productId: bordas, qty: 1, lineGroupUuid: grupo },
        ],
        paymentMethod: 'pix',
      }),
    });
    const v7 = await unwrap<{ id: number; totalCents: number }>(r7);
    check('vende produto com complemento', r7.status === 201 && v7.totalCents === 3300, `total=${v7?.totalCents}`);
    check('complemento fica agrupado ao item pai',
      (db.prepare('SELECT COUNT(*) c FROM sale_items WHERE sale_id = ? AND line_group_uuid = ?').get(v7.id, grupo) as { c: number }).c === 2);

    // O mestre é barrado no fechamento, não só escondido na tela.
    const r8 = await vender([{ productId: mestre, qty: 1 }]);
    check('vender o produto com variações é recusado (400)', r8.status === 400, `status=${r8.status}`);
    const erro8 = (await r8.json()) as { error?: string };
    check('a recusa explica o que fazer', /escolha a varia/i.test(erro8.error ?? ''), erro8.error ?? '(sem mensagem)');

    // Fecha o ciclo: cancelar devolve o que cada tipo baixou.
    const antesCancel = { caf: saldo(comp2), pao: saldo(comp1) };
    const cancel = await api(`/api/store/sales/${v3.id}/cancel`, { method: 'POST' });
    check('cancela a venda do kit', cancel.ok, `status=${cancel.status}`);
    check('cancelamento devolve o estoque dos componentes',
      saldo(comp2) === antesCancel.caf + 2 && saldo(comp1) === antesCancel.pao + 4,
      `café=${saldo(comp2)} pão=${saldo(comp1)}`);
  } finally {
    server.close();
    closeDb();
  }

  console.log(failures === 0 ? '\nPDV × tipos de produto: TODOS OS TESTES PASSARAM' : `\n${failures} falha(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
