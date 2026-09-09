/**
 * Teste: atualizar quantidade e remover item de uma comanda aberta.
 *
 * Regressão real: `updateItemQty` lia o item com `findInComanda`, que não trazia
 * `product_id` — o preço era recalculado como `undefined` e a linha "zerava" (preço
 * unitário 0) ao mudar a quantidade. Este teste trava a ponta: mudar a qtd mantém o
 * preço do produto, e o item continua podendo ser removido (anulado).
 *
 * KIVO_DB_PATH TEM que vir do ambiente — este teste recria o banco que usar:
 *   node scripts/test-isolated.js src/tests/comanda-qty-price.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { migrateUp } from '../core/database/migrator';
import { runSeeds } from '../core/database/seeds';
import { createServer } from '../core/server';
import { getSqlite, closeDb } from '../core/database/connection';
import { activateTestLicense } from './resetTestDb';

const PORT = Number(process.env.KIVO_PORT ?? 3822);
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
    throw new Error('KIVO_DB_PATH não definida. Rode via `node scripts/test-isolated.js src/tests/comanda-qty-price.ts`.');
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

    db.prepare("UPDATE capabilities SET enabled = 1 WHERE key = 'comandas.mesas'").run();

    const productId = Number(db.prepare(
      `INSERT INTO products (name, unit, price_cents, cost_cents, track_stock, min_stock, active, product_type, uuid)
       VALUES ('Refrigerante Lata 350ml', 'un', 600, 0, 0, 0, 1, 'fisico', ?)`,
    ).run(randomUUID()).lastInsertRowid);

    const mesaR = await api('/api/comandas/tables', { method: 'POST', body: JSON.stringify({ label: 'Mesa 01' }) });
    const mesaBody = (await mesaR.json()) as { data?: { id: number }; id?: number };
    const mesaId = (mesaBody.data?.id ?? mesaBody.id) as number;
    const comandaR = await api('/api/comandas/comandas', { method: 'POST', body: JSON.stringify({ tableId: mesaId }) });
    const comandaBody = (await comandaR.json()) as { data?: { id: number }; id?: number };
    const comandaId = (comandaBody.data?.id ?? comandaBody.id) as number;

    const add = await api(`/api/comandas/comandas/${comandaId}/items`, {
      method: 'POST', body: JSON.stringify({ productId, qty: 1 }),
    });
    const addBody = (await add.json()) as { data?: { id: number }; id?: number };
    const itemId = (addBody.data?.id ?? addBody.id) as number;
    check('adiciona item na comanda', add.ok && itemId > 0, `id=${itemId}`);

    // ── Atualizar quantidade mantém o preço (regressão do "zera o valor") ──
    const upd = await api(`/api/comandas/comandas/${comandaId}/items/${itemId}/qty`, {
      method: 'PUT', body: JSON.stringify({ qty: 4 }),
    });
    const getComanda = async () => {
      const b = (await (await api(`/api/comandas/comandas/${comandaId}`)).json()) as {
        data?: { items: { id: number; qty: number; unit_price_cents: number }[] };
        items?: { id: number; qty: number; unit_price_cents: number }[];
      };
      return (b.data ?? b).items ?? [];
    };
    const itens = await getComanda();
    const item = itens.find((i) => i.id === itemId)!;
    check('atualizar quantidade responde ok', upd.ok, `status=${upd.status}`);
    check('quantidade foi atualizada', item.qty === 4, `qty=${item.qty}`);
    check('preço unitário NÃO zera ao atualizar quantidade', item.unit_price_cents === 600,
      `unit_price_cents=${item.unit_price_cents}`);

    // ── Remover (anular) item da comanda ──
    const del = await api(`/api/comandas/comandas/${comandaId}/items/${itemId}`, { method: 'DELETE' });
    const itemsApos = await getComanda();
    check('remover item responde ok', del.ok, `status=${del.status}`);
    check('item some da comanda após remoção', !itemsApos.some((i) => i.id === itemId),
      `${itemsApos.length} item(ns) restante(s)`);

    // Erro de EJS não aparece em teste de API — GET na tela pega o typo antes do garçom.
    const pagina = await api(`/app/comandas/mesas/${comandaId}`);
    const html = await pagina.text();
    check('a tela da comanda abre com o controle de quantidade',
      pagina.ok && html.includes('x-model.number="item.qty"') && html.includes('onQtyInput'),
      `status=${pagina.status}`);
  } finally {
    server.close();
    closeDb();
  }

  console.log(failures === 0 ? '\nComanda qtd/preço: TODOS OS TESTES PASSARAM' : `\n${failures} falha(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
