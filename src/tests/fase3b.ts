/**
 * Teste de extensão da Fase 3 (commercial): unicidade/validação de código de barras +
 * cadastro rápido, e listas de preço (atacado/varejo/cliente) com faixa por quantidade.
 * Fase 1: um servidor só. Fase 2: duas máquinas + cloud/, convergência via sync.
 *
 * Pré-requisitos da Fase 2 (mesmos da Fase 6a/6b):
 *   1. docker compose -f cloud/docker-compose.yml up -d
 *   2. npm run cloud:install && CLOUD_DB_PORT=3307 npm run cloud:migrate
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

// ---------------------------------------------------------------------------
// Fase 1 — servidor único
// ---------------------------------------------------------------------------
async function phase1(): Promise<void> {
  const PORT = 3742;
  const base = `http://localhost:${PORT}`;
  migrateUp();
  runSeeds();
  const { app } = await createServer();
  const server = app.listen(PORT);
  const C = '/api/commercial';

  try {
    const admin = await loginAs(base, 'admin', 'admin');
    check('login admin', admin !== null);

    // ---- Barcode: unicidade + checksum ----
    const validEan = '4006381333931'; // GTIN de teste conhecido, checksum correto
    const p1 = await api(base, `${C}/products`, { method: 'POST', body: JSON.stringify({ name: 'Produto A', barcode: validEan }) }, admin!);
    check('produto criado com EAN-13 válido', p1.status === 201, String(p1.status));
    const p1Body = (await p1.json()) as { id: number };

    const dup = await api(base, `${C}/products`, { method: 'POST', body: JSON.stringify({ name: 'Produto A2', barcode: validEan }) }, admin!);
    check('barcode duplicado rejeitado (409)', dup.status === 409, String(dup.status));

    const badChecksum = await api(base, `${C}/products`, { method: 'POST', body: JSON.stringify({ name: 'Produto Ruim', barcode: '4006381333930' }) }, admin!);
    check('EAN-13 com checksum inválido rejeitado (400)', badChecksum.status === 400, String(badChecksum.status));

    const nonNumeric = await api(base, `${C}/products`, { method: 'POST', body: JSON.stringify({ name: 'Produto Fornecedor', barcode: 'ABC-123-XYZ' }) }, admin!);
    check('código não-EAN/UPC aceito sem checagem', nonNumeric.status === 201, String(nonNumeric.status));

    const lookupOk = await api(base, `${C}/products/by-barcode/${validEan}`, {}, admin!);
    check('by-barcode encontra produto existente', lookupOk.status === 200);
    const lookupMiss = await api(base, `${C}/products/by-barcode/0000000000000`, {}, admin!);
    check('by-barcode 404 quando não encontrado', lookupMiss.status === 404);

    const gen = await api(base, `${C}/products/${p1Body.id}/barcode/generate`, { method: 'POST' }, admin!);
    check('gerar código interno (barcode ausente rejeitado, produto já tem um)', gen.status === 409 || gen.status === 200);

    const p2 = await api(base, `${C}/products`, { method: 'POST', body: JSON.stringify({ name: 'Produto Sem Barcode' }) }, admin!);
    const p2Body = (await p2.json()) as { id: number };
    const gen2 = await api(base, `${C}/products/${p2Body.id}/barcode/generate`, { method: 'POST' }, admin!);
    check('gerar código interno ok', gen2.status === 200, String(gen2.status));
    const gen2Body = (await gen2.json()) as { barcode: string };
    check('código interno começa com prefixo 2 e tem 13 dígitos', /^2\d{12}$/.test(gen2Body.barcode), gen2Body.barcode);

    const dupProd = await api(base, `${C}/products/${p1Body.id}/duplicate`, { method: 'POST' }, admin!);
    const dupProdBody = (await dupProd.json()) as { barcode: string | null; sku: string | null };
    check('duplicar produto não copia barcode/sku', dupProdBody.barcode === null && dupProdBody.sku === null);

    // ---- Listas de preço ----
    const prodPreco = await (
      await api(base, `${C}/products`, { method: 'POST', body: JSON.stringify({ name: 'Parafuso 3/4', priceCents: 1200 }) }, admin!)
    ).json() as { id: number };

    const defList = await (
      await api(base, `${C}/price-lists`, { method: 'POST', body: JSON.stringify({ name: 'Quantidade', isDefault: true }) }, admin!)
    ).json() as { id: number };
    const atacado = await (
      await api(base, `${C}/price-lists`, { method: 'POST', body: JSON.stringify({ name: 'Atacado' }) }, admin!)
    ).json() as { id: number };

    const putDefItems = await api(base, `${C}/price-lists/${defList.id}/items`, {
      method: 'PUT',
      body: JSON.stringify({ items: [
        { productId: prodPreco.id, minQty: 1, unitPriceCents: 1000 },
        { productId: prodPreco.id, minQty: 10, unitPriceCents: 900 },
      ] }),
    }, admin!);
    check('itens da lista padrão salvos', putDefItems.status === 200, String(putDefItems.status));

    await api(base, `${C}/price-lists/${atacado.id}/items`, {
      method: 'PUT',
      body: JSON.stringify({ items: [{ productId: prodPreco.id, minQty: 1, unitPriceCents: 800 }] }),
    }, admin!);

    const cust = await (
      await api(base, `${C}/customers`, { method: 'POST', body: JSON.stringify({ name: 'Revenda XPTO', price_list_id: atacado.id }) }, admin!)
    ).json() as { id: number };

    const resolveNoCust5 = await (
      await api(base, `${C}/pricing/resolve`, { method: 'POST', body: JSON.stringify({ items: [{ productId: prodPreco.id, qty: 5 }] }) }, admin!)
    ).json() as { prices: { unitCents: number; source: string }[] };
    check('sem cliente, qty=5 usa faixa min_qty=1 (1000)', resolveNoCust5.prices[0].unitCents === 1000, JSON.stringify(resolveNoCust5.prices[0]));

    const resolveNoCust12 = await (
      await api(base, `${C}/pricing/resolve`, { method: 'POST', body: JSON.stringify({ items: [{ productId: prodPreco.id, qty: 12 }] }) }, admin!)
    ).json() as { prices: { unitCents: number; source: string }[] };
    check('sem cliente, qty=12 usa faixa min_qty=10 (900)', resolveNoCust12.prices[0].unitCents === 900, JSON.stringify(resolveNoCust12.prices[0]));

    const resolveCust3 = await (
      await api(base, `${C}/pricing/resolve`, { method: 'POST', body: JSON.stringify({ customerId: cust.id, items: [{ productId: prodPreco.id, qty: 3 }] }) }, admin!)
    ).json() as { prices: { unitCents: number; source: string }[] };
    check(
      'cliente com lista própria vence mesmo com qty baixa (800, source=customer_list)',
      resolveCust3.prices[0].unitCents === 800 && resolveCust3.prices[0].source === 'customer_list',
      JSON.stringify(resolveCust3.prices[0]),
    );

    // ---- Venda de fato usa o preço resolvido (abre caixa antes) ----
    await api(base, '/api/finance/cash/open', { method: 'POST', body: JSON.stringify({ openingCents: 10000 }) }, admin!);
    const sale = await (
      await api(base, '/api/store/sales', {
        method: 'POST',
        body: JSON.stringify({ items: [{ productId: prodPreco.id, qty: 3 }], paymentMethod: 'pix', customerId: cust.id }),
      }, admin!)
    ).json() as { totalCents: number };
    check('venda para cliente Atacado cobra 800/un (total 2400)', sale.totalCents === 2400, String(sale.totalCents));

    // ---- Exclusão de lista remove associação do cliente ----
    const delList = await api(base, `${C}/price-lists/${atacado.id}`, { method: 'DELETE' }, admin!);
    check('lista de preço excluída', delList.status === 200, String(delList.status));
    const custAfter = await (await api(base, `${C}/customers?q=Revenda`, {}, admin!)).json() as { price_list_id: number | null }[];
    check('cliente fica sem lista após exclusão', custAfter[0]?.price_list_id == null, JSON.stringify(custAfter[0]));

    // ---- Permissões ----
    await api(base, '/api/users', { method: 'POST', body: JSON.stringify({ username: 'op3b', name: 'op3b', password: '123456', roleSlug: 'operador' }) }, admin!);
    const op = await loginAs(base, 'op3b', '123456');
    check('operador sem permissão não gerencia listas (403)', (await api(base, `${C}/price-lists`, { method: 'POST', body: JSON.stringify({ name: 'X' }) }, op!)).status === 403);
    check('operador sem permissão não vê listas (403)', (await api(base, `${C}/price-lists`, {}, op!)).status === 403);
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
const SCRATCH = path.resolve(ROOT, 'storage', 'temp', 'fase3b');
const CLOUD_ENV = {
  CLOUD_DB_HOST: '127.0.0.1',
  CLOUD_DB_PORT: '3307',
  CLOUD_DB_USER: 'root',
  CLOUD_DB_PASSWORD: 'katsu',
  CLOUD_DB_NAME: 'katsu_cloud',
};

interface Machine { name: string; base: string; proc: ChildProcess; cookie?: string }

function spawnProc(name: string, script: string, env: Record<string, string>): ChildProcess {
  const proc = spawn(process.execPath, [TSX, script], { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stdout.on('data', (d) => { if (process.env.DEBUG_FASE3B) process.stdout.write(`[${name}] ${d}`); });
  proc.stderr.on('data', (d) => process.stderr.write(`[${name}:err] ${d}`));
  return proc;
}

function waitForHealth(url: string, timeoutMs = 20000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tryOnce = () => fetch(url).then((r) => (r.ok ? resolve() : retry())).catch(retry);
    const retry = () => {
      if (Date.now() - start > timeoutMs) { reject(new Error(`Timeout aguardando ${url}`)); return; }
      setTimeout(tryOnce, 300);
    };
    tryOnce();
  });
}

async function runSync(m: Machine): Promise<void> {
  const r = await api(m.base, '/api/sync/run', { method: 'POST' }, m.cookie);
  if (!r.ok) throw new Error(`sync/run falhou em ${m.name}: ${r.status} ${await r.text()}`);
}
async function syncBothTwice(a: Machine, b: Machine): Promise<void> {
  await runSync(a); await runSync(b); await runSync(a); await runSync(b);
}

async function findPriceList(m: Machine, name: string): Promise<{ id: number; name: string } | undefined> {
  const rows = (await (await api(m.base, '/api/commercial/price-lists', {}, m.cookie)).json()) as { id: number; name: string }[];
  return rows.find((r) => r.name === name);
}

async function phase2(): Promise<void> {
  fs.mkdirSync(SCRATCH, { recursive: true });
  for (const f of fs.readdirSync(SCRATCH)) fs.rmSync(path.join(SCRATCH, f));

  const companyUuid = randomUUID();
  const licenseKey = randomUUID();
  const cloudPort = 4642;
  const cloudUrl = `http://localhost:${cloudPort}`;
  const portA = 3743;
  const portB = 3744;

  console.log('[setup] provisionando empresa de teste no cloud/...');
  execFileSync(process.execPath, [TSX, 'cloud/src/provision-company.ts', companyUuid, licenseKey], { cwd: ROOT, env: { ...process.env, ...CLOUD_ENV }, stdio: 'inherit' });

  const cloudProc = spawnProc('cloud', 'cloud/src/server.ts', { ...CLOUD_ENV, CLOUD_PORT: String(cloudPort) });
  await waitForHealth(`${cloudUrl}/api/health`);

  const a: Machine = { name: 'A', base: `http://localhost:${portA}`, proc: spawnProc('machineA', 'src/dev.ts', {
    KATSU_DB_PATH: path.join(SCRATCH, 'machineA.db'), KATSU_PORT: String(portA), KATSU_SYNC_SERVER_URL: cloudUrl, KATSU_MACHINE_ID: 'test-machine-a-3b',
  }) };
  const b: Machine = { name: 'B', base: `http://localhost:${portB}`, proc: spawnProc('machineB', 'src/dev.ts', {
    KATSU_DB_PATH: path.join(SCRATCH, 'machineB.db'), KATSU_PORT: String(portB), KATSU_SYNC_SERVER_URL: cloudUrl, KATSU_MACHINE_ID: 'test-machine-b-3b',
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

    const prod = await (
      await api(a.base, '/api/commercial/products', { method: 'POST', body: JSON.stringify({ name: 'Tinta Especial', priceCents: 5000 }) }, a.cookie)
    ).json() as { id: number };
    const atacado = await (
      await api(a.base, '/api/commercial/price-lists', { method: 'POST', body: JSON.stringify({ name: 'Atacado Tinta' }) }, a.cookie)
    ).json() as { id: number };
    await api(a.base, `/api/commercial/price-lists/${atacado.id}/items`, {
      method: 'PUT', body: JSON.stringify({ items: [{ productId: prod.id, minQty: 1, unitPriceCents: 4000 }] }),
    }, a.cookie);
    const cust = await (
      await api(a.base, '/api/commercial/customers', { method: 'POST', body: JSON.stringify({ name: 'Cliente Atacado', price_list_id: atacado.id }) }, a.cookie)
    ).json() as { id: number };

    await syncBothTwice(a, b);

    const listOnB = await findPriceList(b, 'Atacado Tinta');
    check('lista de preço replicada em B', !!listOnB);
    const listDetailB = (await (await api(b.base, `/api/commercial/price-lists/${listOnB!.id}`, {}, b.cookie)).json()) as
      { items: { unit_price_cents: number }[] };
    check('item da lista replicado em B (4000)', listDetailB.items[0]?.unit_price_cents === 4000, JSON.stringify(listDetailB.items));

    const custOnB = (await (await api(b.base, '/api/commercial/customers?q=Cliente Atacado', {}, b.cookie)).json()) as { id: number; price_list_id: number }[];
    check('cliente replicado em B com price_list_id correto', custOnB[0]?.price_list_id === listOnB!.id);

    const prodOnB = (await (await api(b.base, '/api/commercial/products?q=Tinta Especial', {}, b.cookie)).json()) as { id: number }[];
    const resolveB = (await (
      await api(b.base, '/api/commercial/pricing/resolve', {
        method: 'POST', body: JSON.stringify({ customerId: custOnB[0].id, items: [{ productId: prodOnB[0].id, qty: 1 }] }),
      }, b.cookie)
    ).json()) as { prices: { unitCents: number }[] };
    check('preço resolvido em B é igual ao de A (4000)', resolveB.prices[0].unitCents === 4000, JSON.stringify(resolveB.prices[0]));

    // --- Edição concorrente dos ITENS da mesma lista, em A e B, antes de sincronizar ---
    await api(a.base, `/api/commercial/price-lists/${atacado.id}/items`, {
      method: 'PUT', body: JSON.stringify({ items: [{ productId: prod.id, minQty: 1, unitPriceCents: 4100 }] }),
    }, a.cookie);
    await new Promise((r) => setTimeout(r, 1100));
    await api(b.base, `/api/commercial/price-lists/${listOnB!.id}/items`, {
      method: 'PUT', body: JSON.stringify({ items: [{ productId: prodOnB[0].id, minQty: 1, unitPriceCents: 4200 }] }),
    }, b.cookie);

    await syncBothTwice(a, b);

    const finalA = (await (await api(a.base, `/api/commercial/price-lists/${atacado.id}`, {}, a.cookie)).json()) as { items: { unit_price_cents: number }[] };
    const finalB = (await (await api(b.base, `/api/commercial/price-lists/${listOnB!.id}`, {}, b.cookie)).json()) as { items: { unit_price_cents: number }[] };
    check('conflito de itens converge para a edição mais recente em A (4200)', finalA.items[0]?.unit_price_cents === 4200, JSON.stringify(finalA.items));
    check('conflito de itens converge para a edição mais recente em B (4200)', finalB.items[0]?.unit_price_cents === 4200, JSON.stringify(finalB.items));

    // --- Idempotência ---
    await syncBothTwice(a, b);
    const idemA = (await (await api(a.base, `/api/commercial/price-lists/${atacado.id}`, {}, a.cookie)).json()) as { items: unknown[] };
    check('idempotente: sem duplicar itens em A', idemA.items.length === 1, String(idemA.items.length));
  } finally {
    a.proc.kill();
    b.proc.kill();
    cloudProc.kill();
  }
}

async function main(): Promise<void> {
  console.log('--- Fase 3b, parte 1: servidor único ---');
  await phase1();

  if (process.env.SKIP_SYNC_PHASE === '1') {
    console.log('\n[info] SKIP_SYNC_PHASE=1 — pulando a Fase 2 (sync entre máquinas).');
  } else {
    console.log('\n--- Fase 3b, parte 2: duas máquinas + cloud/ ---');
    await phase2();
  }

  console.log(failures === 0 ? '\nFase 3b: TODOS OS TESTES PASSARAM' : `\n${failures} falha(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
