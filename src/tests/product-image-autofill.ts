/**
 * Teste: preenchimento em lote de imagens de produtos sem foto (productImageAutofill).
 *
 * Cobre a promessa central da funcionalidade: produtos JÁ cadastrados sem imagem ganham
 * a foto automaticamente reaproveitando a de um produto igual (mesmo nome — o caso real
 * de catálogo duplicado/importado), e isso acontece SEM depender de assinatura/plano —
 * a camada local roda offline, antes de qualquer ida à nuvem.
 *
 * KIVO_DB_PATH TEM que vir do ambiente — este teste recria o banco que usar:
 *   node scripts/test-isolated.js src/tests/product-image-autofill.ts
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

const PORT = Number(process.env.KIVO_PORT ?? 3821);
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

function assertBancoDescartavel(): string {
  const alvo = process.env.KIVO_DB_PATH;
  if (!alvo) {
    throw new Error(
      'KIVO_DB_PATH não definida. Este teste APAGA o banco que usar — rode via ' +
      '`node scripts/test-isolated.js src/tests/product-image-autofill.ts`.',
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

    const insert = (name: string, o: { barcode?: string | null; sku?: string | null; imageUrl?: string | null; productType?: string } = {}): number =>
      Number(db.prepare(
        `INSERT INTO products (name, sku, barcode, unit, price_cents, cost_cents, track_stock, min_stock,
           active, product_type, image_url, uuid)
         VALUES (?, ?, ?, 'un', 1000, 500, 0, 0, 1, ?, ?, ?)`,
      ).run(
        name, o.sku ?? null, o.barcode ?? null, o.productType ?? 'fisico', o.imageUrl ?? null, randomUUID(),
      ).lastInsertRowid);

    // Produto "original" com foto.
    const original = insert('Refrigerante Cola 2L', { barcode: '7891000100100', imageUrl: '/uploads/products/original.jpg' });
    // Duplicata (importada duas vezes, sem código de barras) — deve herdar a foto pelo nome.
    const duplicado = insert('Refrigerante Cola 2L');
    // Produto sem foto e sem equivalente cadastrado — deve continuar sem foto.
    const semPar = insert('Bebida Rara Artesanal');

    const r = await api('/api/commercial/products/images/autofill', { method: 'POST' });
    check('endpoint de autofill responde', r.ok, `status=${r.status}`);
    const result = await unwrap<{
      scanned: number; filledLocal: number; filledCloud: number; stillMissing: number;
    }>(r);

    const image = (id: number): string | null =>
      (db.prepare('SELECT image_url FROM products WHERE id = ?').get(id) as { image_url: string | null }).image_url;

    check('reaproveita a foto do produto igual (mesmo nome), sem nuvem',
      image(duplicado) === '/uploads/products/original.jpg',
      image(duplicado) ?? '(sem imagem)');
    check('não inventa foto para produto sem equivalente', image(semPar) === null);
    check('o produto original não é alterado', image(original) === '/uploads/products/original.jpg');
    check('o resultado reporta o preenchimento local', result.filledLocal >= 1, `filledLocal=${result.filledLocal}`);
    check('rodada não sai com "0 preenchidos" por engano', result.scanned >= 2 && result.stillMissing >= 1,
      `scanned=${result.scanned} stillMissing=${result.stillMissing}`);

    // Idempotência: rodar de novo não mexe em nada.
    const r2 = await api('/api/commercial/products/images/autofill', { method: 'POST' });
    const result2 = await unwrap<{ filledLocal: number }>(r2);
    check('reexecutar não altera nada (idempotente)', result2.filledLocal === 0,
      `filledLocal=${result2.filledLocal}`);

    // Complementos: a mesma rotina, no escopo 'complementos', preenche os itens da aba
    // Complementos — e o escopo 'produtos' (padrão) NÃO mexe neles.
    const compOriginal = insert('Comp Teste Autofill Base', { productType: 'complemento', imageUrl: '/uploads/products/comp-orig.jpg' });
    const compDuplicado = insert('Comp Teste Autofill Base', { productType: 'complemento' });
    const compComum = insert('Comp Teste Autofill Participante', { productType: 'fisico' });

    const rCompDefault = await api('/api/commercial/products/images/autofill', { method: 'POST' });
    check('escopo padrão segue respondendo', rCompDefault.ok, `status=${rCompDefault.status}`);
    check('escopo produtos ignora complementos sem foto', image(compDuplicado) === null,
      image(compDuplicado) ?? '(sem imagem)');

    const rComp = await api('/api/commercial/products/images/autofill', {
      method: 'POST', body: JSON.stringify({ scope: 'complementos' }),
    });
    const resComp = await unwrap<{ filledLocal: number }>(rComp);
    check('endpoint aceita escopo complementos', rComp.ok, `status=${rComp.status}`);
    check('reaproveita a foto do complemento igual (mesmo nome)',
      image(compDuplicado) === '/uploads/products/comp-orig.jpg',
      image(compDuplicado) ?? '(sem imagem)');
    check('o complemento original não é alterado', image(compOriginal) === '/uploads/products/comp-orig.jpg');
    check('produto comum fora da aba complementos não entrou na rodada', image(compComum) === null);
    check('rodada de complementos reporta preenchimento', resComp.filledLocal >= 1, `filledLocal=${resComp.filledLocal}`);

    // Erro de EJS não aparece em teste de API — um GET na tela pega o typo antes do lojista.
    const pagina = await api('/app/commercial/produtos');
    const html = await pagina.text();
    check('a tela de produtos abre com o botão (ícone) de preencher imagens',
      pagina.ok && html.includes('fill-imgs-btn') && html.includes('fillMissingImages'),
      `status=${pagina.status}`);
  } finally {
    server.close();
    closeDb();
  }

  console.log(failures === 0 ? '\nAutofill de imagens: TODOS OS TESTES PASSARAM' : `\n${failures} falha(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
