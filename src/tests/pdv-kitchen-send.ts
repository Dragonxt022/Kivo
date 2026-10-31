/**
 * Teste: envio antecipado de itens de cozinha no PDV direto.
 *
 * O PDV pode mandar a produção antes de a venda existir. O ticket nasce com um
 * `source_id` negativo (rascunho) e, ao concluir a venda, é adotado pelo id real —
 * é isso que permite cancelar a venda depois sem deixar pedido órfão na cozinha.
 *
 * Rode com banco descartável:
 *   node scripts/test-isolated.js src/tests/pdv-kitchen-send.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { migrateUp } from '../core/database/migrator';
import { runSeeds } from '../core/database/seeds';
import { createServer } from '../core/server';
import { getSqlite, closeDb } from '../core/database/connection';
import { activateTestLicense } from './resetTestDb';

const PORT = Number(process.env.KIVO_PORT ?? 3823);
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
    throw new Error('KIVO_DB_PATH não definida. Rode via `node scripts/test-isolated.js src/tests/pdv-kitchen-send.ts`.');
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

    db.prepare("UPDATE capabilities SET enabled = 1 WHERE key = 'foodservice.cozinha'").run();

    const productId = Number(db.prepare(
      `INSERT INTO products (name, unit, price_cents, cost_cents, track_stock, min_stock, active, product_type, uuid)
       VALUES ('Hamburguer Cozinha', 'un', 1800, 0, 0, 0, 1, 'fisico', ?)`,
    ).run(randomUUID()).lastInsertRowid);

    const routing = await api('/api/foodservice/kitchen-routing', {
      method: 'POST',
      body: JSON.stringify({ productId, station: 'Cozinha', estimatedMinutes: 8 }),
    });
    check('produto roteado para a cozinha', routing.status === 201, String(routing.status));

    const open = await api('/api/finance/cash/open', {
      method: 'POST',
      body: JSON.stringify({ openingCents: 10000 }),
    });
    check('caixa aberto para a venda', open.status === 201, String(open.status));

    const draftId = 424242;
    const send = await api('/api/store/kitchen/send', {
      method: 'POST',
      body: JSON.stringify({
        draftId,
        items: [{ productId, name: 'Hamburguer Cozinha', qty: 1 }],
      }),
    });
    const sendBody = (await send.json()) as { success?: boolean; data?: { sent?: number } };
    check('envio antecipado cria ticket', send.ok && sendBody.success === true && sendBody.data?.sent === 1,
      JSON.stringify(sendBody));

    const draftTicket = db.prepare(
      'SELECT id, source_type, source_id, status FROM kitchen_tickets WHERE source_id = ? AND deleted_at IS NULL',
    ).get(-draftId) as { id: number; source_type: string; source_id: number; status: string } | undefined;
    check('ticket usa o rascunho negativo', !!draftTicket && draftTicket.source_type === 'sale' && draftTicket.source_id === -draftId && draftTicket.status === 'pendente',
      JSON.stringify(draftTicket));

    const sale = await api('/api/store/sales', {
      method: 'POST',
      body: JSON.stringify({
        items: [{ productId, qty: 1 }],
        paymentMethod: 'dinheiro',
        kitchenDraftId: draftId,
        skipKitchenNotify: true,
      }),
    });
    const saleBody = (await sale.json()) as { success?: boolean; data?: { id?: number } };
    check('venda conclui com o rascunho de cozinha', sale.status === 201 && saleBody.success === true && Number(saleBody.data?.id) > 0,
      JSON.stringify(saleBody));
    const saleId = Number(saleBody.data?.id);
    if (!saleId) return;

    const adopted = db.prepare(
      "SELECT COUNT(*) AS cnt FROM kitchen_tickets WHERE source_type = 'sale' AND source_id = ? AND deleted_at IS NULL",
    ).get(saleId) as { cnt: number };
    check('ticket é adotado pelo id real da venda', adopted.cnt === 1, `tickets=${adopted.cnt}`);

    const orphan = db.prepare(
      'SELECT COUNT(*) AS cnt FROM kitchen_tickets WHERE source_id = ? AND deleted_at IS NULL',
    ).get(-draftId) as { cnt: number };
    check('não sobra ticket apontando para o rascunho', orphan.cnt === 0, `tickets=${orphan.cnt}`);

    const cancel = await api(`/api/store/sales/${saleId}/cancel`, { method: 'POST' });
    check('cancelar a venda responde ok', cancel.ok, String(cancel.status));
    const canceledTicket = db.prepare('SELECT status FROM kitchen_tickets WHERE id = ?').get(draftTicket?.id) as { status: string } | undefined;
    check('cancelar a venda também cancela a produção', canceledTicket?.status === 'cancelado',
      JSON.stringify(canceledTicket));
  } finally {
    server.close();
    closeDb();
  }

  console.log(failures === 0 ? '\nPDV cozinha: TODOS OS TESTES PASSARAM' : `\n${failures} falha(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
