/**
 * Teste da Parte D (clube de fidelidade): acúmulo automático por venda, resgate como
 * forma de pagamento (com validação exata do valor no servidor), cancelamento reverte
 * ganho e resgate. Fase 2: convergência determinística entre duas máquinas offline.
 */
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { migrateUp } from '../core/database/migrator';
import { runSeeds } from '../core/database/seeds';
import { createServer } from '../core/server';
import { closeDb } from '../core/database/connection';
import { unwrap } from './testUtils';

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
  const m = (r.headers.get('set-cookie') ?? '').match(/kivo_session=([^;]+)/);
  return m ? `kivo_session=${m[1]}` : null;
}

async function enablePaymentMethod(base: string, cookie: string, type: string): Promise<{ id: number }> {
  const methods = await unwrap<{ id: number; type: string }[]>(await api(base, '/api/finance/payment-methods?all=1', {}, cookie));
  const m = methods.find((x) => x.type === type)!;
  await api(base, `/api/finance/payment-methods/${m.id}`, { method: 'PUT', body: JSON.stringify({ active: true }) }, cookie);
  return { id: m.id };
}

async function setFidelidade(base: string, cookie: string, ativo: boolean, pontosPorReal = 1, pontosResgate = 100, valorResgateCents = 500): Promise<void> {
  const upsert = (key: string, value: string) => api(base, `/api/settings/${key}`, { method: 'PUT', body: JSON.stringify({ value }) }, cookie);
  await upsert('fidelidade.ativo', ativo ? '1' : '0');
  await upsert('fidelidade.pontos_por_real', String(pontosPorReal));
  await upsert('fidelidade.pontos_resgate', String(pontosResgate));
  await upsert('fidelidade.valor_resgate_cents', String(valorResgateCents));
}

// ---------------------------------------------------------------------------
// Fase 1 — servidor único
// ---------------------------------------------------------------------------
async function phase1(): Promise<void> {
  const PORT = 3755;
  const base = `http://localhost:${PORT}`;
  migrateUp();
  runSeeds();
  const { app } = await createServer();
  const server = app.listen(PORT);

  try {
    const admin = await loginAs(base, 'admin', 'admin');
    check('login admin', admin !== null);
    await setFidelidade(base, admin!, true); // 1 ponto por real, 100 pts = R$5,00 (5 centavos/ponto)

    const cust = await unwrap<{ id: number }>(
      await api(base, '/api/commercial/customers', { method: 'POST', body: JSON.stringify({ name: 'Cliente Fidelidade' }) }, admin!));
    const prod = await unwrap<{ id: number }>(
      await api(base, '/api/commercial/products', { method: 'POST', body: JSON.stringify({ name: 'Produto Fidelidade', priceCents: 5000, initialStock: 10 }) }, admin!));

    // Venda de R$50 com fidelidade ativa e 1 ponto/real → ganha 50 pontos
    const sale1 = await api(base, '/api/store/sales', {
      method: 'POST', body: JSON.stringify({ items: [{ productId: prod.id, qty: 1 }], customerId: cust.id, paymentMethod: 'pix' }),
    }, admin!);
    check('venda 1 concluída', sale1.status === 201, String(sale1.status));
    const balAfterSale1 = await unwrap<{ loyalty_points: number }>(await api(base, `/api/commercial/customers/${cust.id}`, {}, admin!));
    check('ganhou 50 pontos (R$50 x 1 ponto/real)', balAfterSale1.loyalty_points === 50, String(balAfterSale1.loyalty_points));

    // Mais uma venda de R$50 -> 100 pontos acumulados, suficiente pra resgatar
    await api(base, '/api/store/sales', { method: 'POST', body: JSON.stringify({ items: [{ productId: prod.id, qty: 1 }], customerId: cust.id, paymentMethod: 'pix' }) }, admin!);
    const balBefore = await unwrap<{ loyalty_points: number }>(await api(base, `/api/commercial/customers/${cust.id}`, {}, admin!));
    check('100 pontos acumulados', balBefore.loyalty_points === 100, String(balBefore.loyalty_points));

    const fidelidadeMethod = await enablePaymentMethod(base, admin!, 'fidelidade');

    // Divergência de valor (pointsUsed não bate com amountCents) é rejeitada
    const mismatch = await api(base, '/api/store/sales', {
      method: 'POST',
      body: JSON.stringify({ items: [{ productId: prod.id, qty: 1 }], customerId: cust.id, payments: [
        { methodId: fidelidadeMethod.id, amountCents: 999, pointsUsed: 100, customerId: cust.id },
      ] }),
    }, admin!);
    check('resgate com valor divergente é rejeitado (400)', mismatch.status === 400, String(mismatch.status));

    // Resgate correto: 100 pontos = 500 centavos; venda de 5000 fica 4500 pix + 500 fidelidade
    const sale2 = await api(base, '/api/store/sales', {
      method: 'POST',
      body: JSON.stringify({ items: [{ productId: prod.id, qty: 1 }], customerId: cust.id, payments: [
        { methodId: fidelidadeMethod.id, amountCents: 500, pointsUsed: 100, customerId: cust.id },
        { methodId: (await unwrap<{ id: number; type: string }[]>(await api(base, '/api/finance/payment-methods', {}, admin!))).find((m: { type: string }) => m.type === 'pix')!.id, amountCents: 4500 },
      ] }),
    }, admin!);
    check('venda com resgate de pontos concluída', sale2.status === 201, String(sale2.status));
    const sale2Body = await unwrap<{ id: number }>(sale2);
    const balAfterRedeem = await unwrap<{ loyalty_points: number }>(await api(base, `/api/commercial/customers/${cust.id}`, {}, admin!));
    // 100 (acumulado) - 100 (resgatado) + pontos ganhos na venda2 (4500 pix + 500 fidelidade, base exclui fidelidade -> 4500/100*1 = 45)
    // 100 (acumulado) - 100 (resgatados) + 45 (ganho da parte paga em pix, sem contar a parte paga com pontos) = 45
    check('saldo após resgatar 100 e ganhar 45 na mesma venda = 45', balAfterRedeem.loyalty_points === 45, String(balAfterRedeem.loyalty_points));

    // Cancela a venda 2 — deve reverter tanto o resgate (+100) quanto o ganho daquela venda (-45)
    const cancel = await api(base, `/api/store/sales/${sale2Body.id}/cancel`, { method: 'POST' }, admin!);
    check('cancelamento ok', cancel.status === 200, String(cancel.status));
    const balAfterCancel = await unwrap<{ loyalty_points: number }>(await api(base, `/api/commercial/customers/${cust.id}`, {}, admin!));
    check('saldo volta a 100 após cancelar (resgate estornado, ganho revertido)', balAfterCancel.loyalty_points === 100, String(balAfterCancel.loyalty_points));
  } finally {
    server.close();
    closeDb();
  }
}

// ---------------------------------------------------------------------------
// Fase 2 — duas máquinas + cloud/
// ---------------------------------------------------------------------------
const ROOT = process.cwd();
const TSX = require.resolve('tsx/cli');
const SCRATCH = path.resolve(ROOT, 'storage', 'temp', 'fase7d');
const CLOUD_ENV = { CLOUD_DB_HOST: '127.0.0.1', CLOUD_DB_PORT: '3307', CLOUD_DB_USER: 'root', CLOUD_DB_PASSWORD: 'kivo', CLOUD_DB_NAME: 'kivo_cloud' };

interface Machine { name: string; base: string; proc: ChildProcess; cookie?: string }
function spawnProc(name: string, script: string, env: Record<string, string>): ChildProcess {
  const proc = spawn(process.execPath, [TSX, script], { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stdout.on('data', (d) => { if (process.env.DEBUG_FASE7D) process.stdout.write(`[${name}] ${d}`); });
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
  const cloudPort = 4655;
  const cloudUrl = `http://localhost:${cloudPort}`;
  const portA = 3756;
  const portB = 3757;

  console.log('[setup] provisionando empresa de teste no cloud/...');
  execFileSync(process.execPath, [TSX, 'cloud/src/provision-company.ts', companyUuid, licenseKey], { cwd: ROOT, env: { ...process.env, ...CLOUD_ENV }, stdio: 'inherit' });

  const cloudProc = spawnProc('cloud', 'cloud/src/server.ts', { ...CLOUD_ENV, CLOUD_PORT: String(cloudPort) });
  await waitForHealth(`${cloudUrl}/api/health`);

  const a: Machine = { name: 'A', base: `http://localhost:${portA}`, proc: spawnProc('machineA', 'src/dev.ts', {
    KIVO_DB_PATH: path.join(SCRATCH, 'machineA.db'), KIVO_PORT: String(portA), KIVO_SYNC_SERVER_URL: cloudUrl, KIVO_MACHINE_ID: 'test-machine-a-7d',
  }) };
  const b: Machine = { name: 'B', base: `http://localhost:${portB}`, proc: spawnProc('machineB', 'src/dev.ts', {
    KIVO_DB_PATH: path.join(SCRATCH, 'machineB.db'), KIVO_PORT: String(portB), KIVO_SYNC_SERVER_URL: cloudUrl, KIVO_MACHINE_ID: 'test-machine-b-7d',
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
      await setFidelidade(m.base, m.cookie!, true);
    }

    const cust = await unwrap<{ id: number }>(
      await api(a.base, '/api/commercial/customers', { method: 'POST', body: JSON.stringify({ name: 'Cliente Pontos Convergência' }) }, a.cookie));
    const prod = await unwrap<{ id: number }>(
      await api(a.base, '/api/commercial/products', { method: 'POST', body: JSON.stringify({ name: 'Produto Pontos', priceCents: 10000, initialStock: 20 }) }, a.cookie));

    await syncBothTwice(a, b);
    const custOnB = await unwrap<{ id: number }[]>(await api(b.base, '/api/commercial/customers?q=Cliente Pontos Convergência', {}, b.cookie));
    const prodOnB = await unwrap<{ id: number }[]>(await api(b.base, '/api/commercial/products?q=Produto Pontos', {}, b.cookie));

    // A vende R$100 (ganha 100 pontos) offline; B ainda não sabe
    await api(a.base, '/api/store/sales', { method: 'POST', body: JSON.stringify({ items: [{ productId: prod.id, qty: 1 }], customerId: cust.id, paymentMethod: 'pix' }) }, a.cookie);
    // B, sem saber do ganho de A, tenta resgatar 100 pontos (saldo local = 0) — deve falhar localmente em B
    const fidMethodB = await enablePaymentMethod(b.base, b.cookie!, 'fidelidade');
    const redeemBeforeSync = await api(b.base, '/api/store/sales', {
      method: 'POST',
      body: JSON.stringify({ items: [{ productId: prodOnB[0].id, qty: 1 }], customerId: custOnB[0].id, payments: [{ methodId: fidMethodB.id, amountCents: 500, pointsUsed: 100, customerId: custOnB[0].id }] }),
    }, b.cookie);
    check('B rejeita resgate sem saldo local conhecido (ainda não sincronizou o ganho de A)', redeemBeforeSync.status === 400, String(redeemBeforeSync.status));

    await syncBothTwice(a, b);

    const finalA = await unwrap<{ loyalty_points: number }[]>(await api(a.base, '/api/commercial/customers?q=Cliente Pontos Convergência', {}, a.cookie));
    const finalB = await unwrap<{ loyalty_points: number }[]>(await api(b.base, '/api/commercial/customers?q=Cliente Pontos Convergência', {}, b.cookie));
    check('saldo de pontos convergiu para 100 em A', finalA[0]?.loyalty_points === 100, String(finalA[0]?.loyalty_points));
    check('saldo de pontos convergiu para 100 em B (idêntico)', finalB[0]?.loyalty_points === 100, String(finalB[0]?.loyalty_points));
  } finally {
    a.proc.kill();
    b.proc.kill();
    cloudProc.kill();
  }
}

async function main(): Promise<void> {
  console.log('--- Fase 7d, parte 1: servidor único ---');
  await phase1();

  if (process.env.SKIP_SYNC_PHASE === '1') {
    console.log('\n[info] SKIP_SYNC_PHASE=1 — pulando a Fase 2 (sync entre máquinas).');
  } else {
    console.log('\n--- Fase 7d, parte 2: duas máquinas + cloud/ ---');
    await phase2();
  }

  console.log(failures === 0 ? '\nFase 7d: TODOS OS TESTES PASSARAM' : `\n${failures} falha(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
