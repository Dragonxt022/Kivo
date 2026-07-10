/**
 * Teste da Parte C (crédito de troca / vale-troca): concessão, uso como forma de
 * pagamento no PDV, saldo insuficiente bloqueia a venda, cancelamento estorna.
 * Fase 2: duas máquinas offline resgatando o mesmo saldo convergem para o MESMO
 * valor (mesmo que negativo) após sincronizar — risco aceito, documentado no plano.
 */
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { migrateUp } from '../core/database/migrator';
import { runSeeds } from '../core/database/seeds';
import { createServer } from '../core/server';
import { closeDb } from '../core/database/connection';

let failures = 0;
function check(label: string, ok: boolean, extra = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures++;
}

async function api(base: string, p: string, opts: RequestInit = {}, cookie?: string) {
  return fetch(`${base}${p}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}), ...(opts.headers ?? {}) },
  });
}

async function loginAs(base: string, u: string, p: string): Promise<string | null> {
  const r = await api(base, '/api/auth/login', { method: 'POST', body: JSON.stringify({ username: u, password: p }) });
  if (!r.ok) return null;
  const m = (r.headers.get('set-cookie') ?? '').match(/katsu_session=([^;]+)/);
  return m ? `katsu_session=${m[1]}` : null;
}

async function enablePaymentMethod(base: string, cookie: string, type: string): Promise<{ id: number }> {
  const methods = (await (await api(base, '/api/finance/payment-methods?all=1', {}, cookie)).json()) as { id: number; type: string; active: number }[];
  const m = methods.find((x) => x.type === type)!;
  await api(base, `/api/finance/payment-methods/${m.id}`, { method: 'PUT', body: JSON.stringify({ active: true }) }, cookie);
  return { id: m.id };
}

// ---------------------------------------------------------------------------
// Fase 1 — servidor único
// ---------------------------------------------------------------------------
async function phase1(): Promise<void> {
  const PORT = 3752;
  const base = `http://localhost:${PORT}`;
  migrateUp();
  runSeeds();
  const { app } = await createServer();
  const server = app.listen(PORT);

  try {
    const admin = await loginAs(base, 'admin', 'admin');
    check('login admin', admin !== null);

    const cust = (await (
      await api(base, '/api/commercial/customers', { method: 'POST', body: JSON.stringify({ name: 'Cliente Crédito' }) }, admin!)
    ).json()) as { id: number };

    const grant = await api(base, `/api/commercial/customers/${cust.id}/credit`, { method: 'POST', body: JSON.stringify({ amountCents: 5000, reason: 'devolução' }) }, admin!);
    check('crédito concedido (201)', grant.status === 201, String(grant.status));
    const balAfterGrant = (await (await api(base, `/api/commercial/customers/${cust.id}`, {}, admin!)).json()) as { store_credit_cents: number };
    check('saldo = 5000 após concessão', balAfterGrant.store_credit_cents === 5000, String(balAfterGrant.store_credit_cents));

    await api(base, '/api/users', { method: 'POST', body: JSON.stringify({ username: 'op7c', name: 'op7c', password: '123456', roleSlug: 'operador' }) }, admin!);
    const op = await loginAs(base, 'op7c', '123456');
    check('operador sem permissão não concede crédito (403)', (await api(base, `/api/commercial/customers/${cust.id}/credit`, { method: 'POST', body: JSON.stringify({ amountCents: 100 }) }, op!)).status === 403);

    const creditMethod = await enablePaymentMethod(base, admin!, 'credito_loja');
    const prod = (await (
      await api(base, '/api/commercial/products', { method: 'POST', body: JSON.stringify({ name: 'Produto Crédito', priceCents: 3000, initialStock: 10 }) }, admin!)
    ).json()) as { id: number };

    // Gasta parte do saldo numa venda
    const sale = await api(base, '/api/store/sales', {
      method: 'POST',
      body: JSON.stringify({ items: [{ productId: prod.id, qty: 1 }], customerId: cust.id, payments: [{ methodId: creditMethod.id, amountCents: 3000, customerId: cust.id }] }),
    }, admin!);
    check('venda com crédito de loja concluída', sale.status === 201, String(sale.status));
    const balAfterSale = (await (await api(base, `/api/commercial/customers/${cust.id}`, {}, admin!)).json()) as { store_credit_cents: number };
    check('saldo = 2000 após gastar 3000 de 5000', balAfterSale.store_credit_cents === 2000, String(balAfterSale.store_credit_cents));

    // Tenta gastar mais do que o saldo restante (2000) — venda inteira deve ser rejeitada
    const stockBefore = ((await (await api(base, `/api/commercial/products?q=Produto Crédito`, {}, admin!)).json()) as { stock_qty: number }[])[0].stock_qty;
    const over = await api(base, '/api/store/sales', {
      method: 'POST',
      body: JSON.stringify({ items: [{ productId: prod.id, qty: 1 }], customerId: cust.id, payments: [{ methodId: creditMethod.id, amountCents: 3000, customerId: cust.id }] }),
    }, admin!);
    check('venda com saldo insuficiente é rejeitada (400)', over.status === 400, String(over.status));
    const stockAfter = ((await (await api(base, `/api/commercial/products?q=Produto Crédito`, {}, admin!)).json()) as { stock_qty: number }[])[0].stock_qty;
    check('estoque não foi afetado pela venda rejeitada', stockAfter === stockBefore, `${stockBefore} -> ${stockAfter}`);
    const balUnchanged = (await (await api(base, `/api/commercial/customers/${cust.id}`, {}, admin!)).json()) as { store_credit_cents: number };
    check('saldo não foi afetado pela venda rejeitada', balUnchanged.store_credit_cents === 2000, String(balUnchanged.store_credit_cents));

    // Cancela a venda de 3000 — saldo volta a 5000
    const saleId = ((await sale.json()) as { id: number }).id;
    const cancel = await api(base, `/api/store/sales/${saleId}/cancel`, { method: 'POST' }, admin!);
    check('cancelamento ok', cancel.status === 200, String(cancel.status));
    const balAfterCancel = (await (await api(base, `/api/commercial/customers/${cust.id}`, {}, admin!)).json()) as { store_credit_cents: number };
    check('saldo restaurado para 5000 após cancelamento', balAfterCancel.store_credit_cents === 5000, String(balAfterCancel.store_credit_cents));
  } finally {
    server.close();
    closeDb();
  }
}

// ---------------------------------------------------------------------------
// Fase 2 — duas máquinas + cloud/ (convergência determinística, mesmo negativa)
// ---------------------------------------------------------------------------
const ROOT = process.cwd();
const TSX = require.resolve('tsx/cli');
const SCRATCH = path.resolve(ROOT, 'storage', 'temp', 'fase7c');
const CLOUD_ENV = { CLOUD_DB_HOST: '127.0.0.1', CLOUD_DB_PORT: '3307', CLOUD_DB_USER: 'root', CLOUD_DB_PASSWORD: 'katsu', CLOUD_DB_NAME: 'katsu_cloud' };

interface Machine { name: string; base: string; proc: ChildProcess; cookie?: string }
function spawnProc(name: string, script: string, env: Record<string, string>): ChildProcess {
  const proc = spawn(process.execPath, [TSX, script], { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stdout.on('data', (d) => { if (process.env.DEBUG_FASE7C) process.stdout.write(`[${name}] ${d}`); });
  proc.stderr.on('data', (d) => process.stderr.write(`[${name}:err] ${d}`));
  return proc;
}
function waitForHealth(url: string, timeoutMs = 20000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tryOnce = () => fetch(url).then((r) => (r.ok ? resolve() : retry())).catch(retry);
    const retry = () => { if (Date.now() - start > timeoutMs) { reject(new Error(`Timeout ${url}`)); return; } setTimeout(tryOnce, 300); };
    tryOnce();
  });
}
async function runSync(m: Machine): Promise<void> {
  const r = await api(m.base, '/api/sync/run', { method: 'POST' }, m.cookie);
  if (!r.ok) throw new Error(`sync falhou em ${m.name}: ${r.status} ${await r.text()}`);
}
async function syncBothTwice(a: Machine, b: Machine): Promise<void> { await runSync(a); await runSync(b); await runSync(a); await runSync(b); }

async function phase2(): Promise<void> {
  fs.mkdirSync(SCRATCH, { recursive: true });
  for (const f of fs.readdirSync(SCRATCH)) fs.rmSync(path.join(SCRATCH, f));

  const companyUuid = randomUUID();
  const licenseKey = randomUUID();
  const cloudPort = 4652;
  const cloudUrl = `http://localhost:${cloudPort}`;
  const portA = 3753;
  const portB = 3754;

  console.log('[setup] provisionando empresa de teste no cloud/...');
  execFileSync(process.execPath, [TSX, 'cloud/src/provision-company.ts', companyUuid, licenseKey], { cwd: ROOT, env: { ...process.env, ...CLOUD_ENV }, stdio: 'inherit' });

  const cloudProc = spawnProc('cloud', 'cloud/src/server.ts', { ...CLOUD_ENV, CLOUD_PORT: String(cloudPort) });
  await waitForHealth(`${cloudUrl}/api/health`);

  const a: Machine = { name: 'A', base: `http://localhost:${portA}`, proc: spawnProc('machineA', 'src/dev.ts', {
    KATSU_DB_PATH: path.join(SCRATCH, 'machineA.db'), KATSU_PORT: String(portA), KATSU_SYNC_SERVER_URL: cloudUrl, KATSU_MACHINE_ID: 'test-machine-a-7c',
  }) };
  const b: Machine = { name: 'B', base: `http://localhost:${portB}`, proc: spawnProc('machineB', 'src/dev.ts', {
    KATSU_DB_PATH: path.join(SCRATCH, 'machineB.db'), KATSU_PORT: String(portB), KATSU_SYNC_SERVER_URL: cloudUrl, KATSU_MACHINE_ID: 'test-machine-b-7c',
  }) };
  await Promise.all([waitForHealth(`${a.base}/api/health`), waitForHealth(`${b.base}/api/health`)]);

  try {
    a.cookie = (await loginAs(a.base, 'admin', 'admin')) ?? undefined;
    b.cookie = (await loginAs(b.base, 'admin', 'admin')) ?? undefined;
    check('login admin em A', !!a.cookie);
    check('login admin em B', !!b.cookie);
    for (const m of [a, b]) {
      const r = await api(m.base, '/api/license', { method: 'PUT', body: JSON.stringify({ companyUuid, licenseKey }) }, m.cookie);
      check(`licença configurada em ${m.name}`, r.ok);
    }

    const cust = (await (
      await api(a.base, '/api/commercial/customers', { method: 'POST', body: JSON.stringify({ name: 'Cliente Convergência' }) }, a.cookie)
    ).json()) as { id: number };
    await api(a.base, `/api/commercial/customers/${cust.id}/credit`, { method: 'POST', body: JSON.stringify({ amountCents: 1000, reason: 'inicial' }) }, a.cookie);

    await syncBothTwice(a, b);

    const custOnB = (await (await api(b.base, '/api/commercial/customers?q=Cliente Convergência', {}, b.cookie)).json()) as { id: number; store_credit_cents: number }[];
    check('cliente e saldo replicados em B (1000)', custOnB[0]?.store_credit_cents === 1000, JSON.stringify(custOnB[0]));

    // Ambas offline resgatam 700 do mesmo saldo de 1000 (cada uma vê localmente saldo suficiente) —
    // resgate acontece através de uma venda com pagamento "crédito de loja".
    const creditMethodA = (await enablePaymentMethod(a.base, a.cookie!, 'credito_loja'));
    const creditMethodB = (await enablePaymentMethod(b.base, b.cookie!, 'credito_loja'));
    const prodA = (await (
      await api(a.base, '/api/commercial/products', { method: 'POST', body: JSON.stringify({ name: 'Produto Convergência', priceCents: 700, initialStock: 10 }) }, a.cookie)
    ).json()) as { id: number };
    await syncBothTwice(a, b);
    const prodOnB = (await (await api(b.base, '/api/commercial/products?q=Produto Convergência', {}, b.cookie)).json()) as { id: number }[];

    const saleA = await api(a.base, '/api/store/sales', {
      method: 'POST', body: JSON.stringify({ items: [{ productId: prodA.id, qty: 1 }], customerId: cust.id, payments: [{ methodId: creditMethodA.id, amountCents: 700, customerId: cust.id }] }),
    }, a.cookie);
    check('resgate de 700 em A (offline) aceito', saleA.status === 201, String(saleA.status));
    const saleB = await api(b.base, '/api/store/sales', {
      method: 'POST', body: JSON.stringify({ items: [{ productId: prodOnB[0].id, qty: 1 }], customerId: custOnB[0].id, payments: [{ methodId: creditMethodB.id, amountCents: 700, customerId: custOnB[0].id }] }),
    }, b.cookie);
    check('resgate de 700 em B (offline, mesmo saldo) também aceito', saleB.status === 201, String(saleB.status));

    await syncBothTwice(a, b);

    const finalA = (await (await api(a.base, '/api/commercial/customers?q=Cliente Convergência', {}, a.cookie)).json()) as { store_credit_cents: number }[];
    const finalB = (await (await api(b.base, '/api/commercial/customers?q=Cliente Convergência', {}, b.cookie)).json()) as { store_credit_cents: number }[];
    check('saldo final convergiu para -400 em A (1000-700-700)', finalA[0]?.store_credit_cents === -400, String(finalA[0]?.store_credit_cents));
    check('saldo final convergiu para -400 em B (idêntico, não divergente)', finalB[0]?.store_credit_cents === -400, String(finalB[0]?.store_credit_cents));

    const recon = (await (await api(a.base, '/api/finance/reconciliation/negative-balances', {}, a.cookie)).json()) as { id: number; store_credit_cents: number }[];
    check('cliente aparece no relatório de reconciliação (saldo negativo)', recon.some((r) => r.store_credit_cents === -400));
  } finally {
    a.proc.kill();
    b.proc.kill();
    cloudProc.kill();
  }
}

async function main(): Promise<void> {
  console.log('--- Fase 7c, parte 1: servidor único ---');
  await phase1();

  if (process.env.SKIP_SYNC_PHASE === '1') {
    console.log('\n[info] SKIP_SYNC_PHASE=1 — pulando a Fase 2 (sync entre máquinas).');
  } else {
    console.log('\n--- Fase 7c, parte 2: duas máquinas + cloud/ ---');
    await phase2();
  }

  console.log(failures === 0 ? '\nFase 7c: TODOS OS TESTES PASSARAM' : `\n${failures} falha(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
