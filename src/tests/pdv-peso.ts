/**
 * Teste: peso vendido por kg tem a mesma precisão no visor e no total.
 *
 * Regressão real: a modal mostrava 0,235 kg (3 casas) mas o servidor usava
 * 0,2345 kg no total — alguns centavos de diferença entre o preço da balança
 * e o valor cobrado. O servidor agora normaliza kg/g/L/ml para 3 casas.
 *
 * Rode com banco descartável:
 *   node scripts/test-isolated.js src/tests/pdv-peso.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { migrateUp } from '../core/database/migrator';
import { runSeeds } from '../core/database/seeds';
import { createServer } from '../core/server';
import { getSqlite, closeDb } from '../core/database/connection';
import { activateTestLicense } from './resetTestDb';

const PORT = Number(process.env.KIVO_PORT ?? 3824);
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
    throw new Error('KIVO_DB_PATH não definida. Rode via `node scripts/test-isolated.js src/tests/pdv-peso.ts`.');
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

    const productId = Number(db.prepare(
      `INSERT INTO products (name, unit, price_cents, cost_cents, track_stock, min_stock, active, product_type, uuid)
       VALUES ('Sorvete 65/kg', 'kg', 6500, 0, 0, 0, 1, 'fisico', ?)`,
    ).run(randomUUID()).lastInsertRowid);

    const open = await api('/api/finance/cash/open', { method: 'POST', body: JSON.stringify({ openingCents: 10000 }) });
    check('caixa aberto', open.status === 201, String(open.status));

    const sale = await api('/api/store/sales', {
      method: 'POST',
      body: JSON.stringify({
        items: [{ productId, qty: 0.2345 }],
        paymentMethod: 'dinheiro',
      }),
    });
    const saleBody = (await sale.json()) as { success?: boolean; data?: { id?: number } };
    check('venda por peso conclui', sale.status === 201 && saleBody.success === true && Number(saleBody.data?.id) > 0,
      JSON.stringify(saleBody));
    const saleId = Number(saleBody.data?.id);
    if (!saleId) return;

    const row = db.prepare(
      'SELECT qty, unit_price_cents, total_cents FROM sale_items WHERE sale_id = ? LIMIT 1',
    ).get(saleId) as { qty: number; unit_price_cents: number; total_cents: number } | undefined;
    check('peso é normalizado para 3 casas', row?.qty === 0.235, `qty=${row?.qty}`);
    check('total usa o peso exibido (0,235 × R$ 65,00)', row?.total_cents === 1528, `total=${row?.total_cents}`);
    check('preço unitário continua R$ 65,00/kg', row?.unit_price_cents === 6500, `unit=${row?.unit_price_cents}`);
  } finally {
    server.close();
    closeDb();
  }

  console.log(failures === 0 ? '\nPDV peso: TODOS OS TESTES PASSARAM' : `\n${failures} falha(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
