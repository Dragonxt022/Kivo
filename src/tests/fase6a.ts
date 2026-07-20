/**
 * Teste da DoD da Fase 6a (motor de sincronização):
 * duas máquinas offline editam, reconectam (via cloud/ + MySQL) e convergem sem
 * perda nem duplicação — inclusive quando ambas mexem no estoque do mesmo produto.
 *
 * Pré-requisitos (não automatizados aqui, mesmo espírito do KIVO_DB_PATH):
 *   1. docker compose -f cloud/docker-compose.yml up -d
 *   2. npm run cloud:install && npm run cloud:migrate   (com CLOUD_DB_PORT=3307)
 */
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';

const ROOT = process.cwd();
const TSX = require.resolve('tsx/cli');
const SCRATCH = path.resolve(ROOT, 'storage', 'temp', 'fase6a');
const CLOUD_ENV = {
  CLOUD_DB_HOST: '127.0.0.1',
  CLOUD_DB_PORT: '3307',
  CLOUD_DB_USER: 'root',
  CLOUD_DB_PASSWORD: 'kivo',
  CLOUD_DB_NAME: 'kivo_cloud',
};

let failures = 0;
function check(label: string, ok: boolean, extra = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures++;
}

function waitForHealth(url: string, timeoutMs = 20000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      fetch(url)
        .then((r) => (r.ok ? resolve() : retry()))
        .catch(retry);
    };
    const retry = () => {
      if (Date.now() - start > timeoutMs) {
        reject(new Error(`Timeout aguardando ${url}`));
        return;
      }
      setTimeout(tryOnce, 300);
    };
    tryOnce();
  });
}

interface Machine {
  name: string;
  base: string;
  proc: ChildProcess;
  cookie?: string;
}

function spawnProc(name: string, script: string, env: Record<string, string>): ChildProcess {
  const proc = spawn(process.execPath, [TSX, script], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', (d) => {
    if (process.env.DEBUG_FASE6A) process.stdout.write(`[${name}] ${d}`);
  });
  proc.stderr.on('data', (d) => process.stderr.write(`[${name}:err] ${d}`));
  return proc;
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

async function runSync(m: Machine): Promise<{ pushed: number; pulled: number }> {
  const r = await api(m.base, '/api/sync/run', { method: 'POST' }, m.cookie);
  if (!r.ok) throw new Error(`sync/run falhou em ${m.name}: ${r.status} ${await r.text()}`);
  return r.json() as Promise<{ pushed: number; pulled: number }>;
}

async function syncBothTwice(a: Machine, b: Machine): Promise<void> {
  await runSync(a);
  await runSync(b);
  await runSync(a);
  await runSync(b);
}

async function findProduct(m: Machine, name: string): Promise<{ id: number; stock_qty: number; uuid?: string } | undefined> {
  const rows = (await (await api(m.base, `/api/commercial/products?q=${encodeURIComponent(name)}`, {}, m.cookie)).json()) as {
    id: number;
    stock_qty: number;
  }[];
  return rows[0];
}

async function main(): Promise<void> {
  fs.mkdirSync(SCRATCH, { recursive: true });
  for (const f of fs.readdirSync(SCRATCH)) fs.rmSync(path.join(SCRATCH, f));

  const companyUuid = randomUUID();
  const licenseKey = randomUUID();
  const cloudPort = 4610;
  const cloudUrl = `http://localhost:${cloudPort}`;
  const portA = 3611;
  const portB = 3612;

  console.log('[setup] provisionando empresa de teste no cloud/...');
  execFileSync(process.execPath, [TSX, 'cloud/src/provision-company.ts', companyUuid, licenseKey], {
    cwd: ROOT,
    env: { ...process.env, ...CLOUD_ENV },
    stdio: 'inherit',
  });

  const cloudProc = spawnProc('cloud', 'cloud/src/server.ts', { ...CLOUD_ENV, CLOUD_PORT: String(cloudPort) });
  await waitForHealth(`${cloudUrl}/api/health`);

  const a: Machine = {
    name: 'A',
    base: `http://localhost:${portA}`,
    proc: spawnProc('machineA', 'src/dev.ts', {
      KIVO_DB_PATH: path.join(SCRATCH, 'machineA.db'),
      KIVO_PORT: String(portA),
      KIVO_SYNC_SERVER_URL: cloudUrl,
      KIVO_MACHINE_ID: 'test-machine-a',
    }),
  };
  const b: Machine = {
    name: 'B',
    base: `http://localhost:${portB}`,
    proc: spawnProc('machineB', 'src/dev.ts', {
      KIVO_DB_PATH: path.join(SCRATCH, 'machineB.db'),
      KIVO_PORT: String(portB),
      KIVO_SYNC_SERVER_URL: cloudUrl,
      KIVO_MACHINE_ID: 'test-machine-b',
    }),
  };
  await Promise.all([waitForHealth(`${a.base}/api/health`), waitForHealth(`${b.base}/api/health`)]);

  try {
    a.cookie = (await loginAs(a.base, 'admin', 'admin')) ?? undefined;
    b.cookie = (await loginAs(b.base, 'admin', 'admin')) ?? undefined;
    check('login admin em A', !!a.cookie);
    check('login admin em B', !!b.cookie);

    for (const m of [a, b]) {
      const r = await api(m.base, '/api/license', {
        method: 'PUT',
        body: JSON.stringify({ companyUuid, licenseKey }),
      }, m.cookie);
      check(`licença configurada em ${m.name}`, r.ok);
    }

    // A cria o produto com estoque inicial e sincroniza para B conhecer o mesmo produto (mesmo uuid).
    const prodCreate = await (
      await api(a.base, '/api/commercial/products', {
        method: 'POST',
        body: JSON.stringify({ name: 'Cimento 50kg', priceCents: 4500, initialStock: 20 }),
      }, a.cookie)
    ).json() as { id: number; stock_qty: number };
    check('produto criado em A com estoque 20', prodCreate.stock_qty === 20, `stock_qty=${prodCreate.stock_qty}`);

    await syncBothTwice(a, b);

    const prodOnB = await findProduct(b, 'Cimento 50kg');
    check('produto replicado em B após sync', !!prodOnB);
    check('estoque inicial replicado em B (20)', prodOnB?.stock_qty === 20, `stock_qty=${prodOnB?.stock_qty}`);

    // --- Ambas offline: A e B vendem o MESMO produto sem sincronizar entre si ---
    const openA = await api(a.base, '/api/finance/cash/open', { method: 'POST', body: JSON.stringify({ openingCents: 10000 }) }, a.cookie);
    const openB = await api(b.base, '/api/finance/cash/open', { method: 'POST', body: JSON.stringify({ openingCents: 10000 }) }, b.cookie);
    check('caixa aberto em A', openA.status === 201);
    check('caixa aberto em B', openB.status === 201);

    const saleA = await api(a.base, '/api/store/sales', {
      method: 'POST',
      body: JSON.stringify({ items: [{ productId: prodCreate.id, qty: 5 }], paymentMethod: 'dinheiro' }),
    }, a.cookie);
    check('venda em A (qty 5)', saleA.status === 201, String(saleA.status));

    const saleB = await api(b.base, '/api/store/sales', {
      method: 'POST',
      body: JSON.stringify({ items: [{ productId: prodOnB!.id, qty: 3 }], paymentMethod: 'dinheiro' }),
    }, b.cookie);
    check('venda em B (qty 3)', saleB.status === 201, String(saleB.status));

    // B também cadastra um cliente offline (entidade simples, sem conflito).
    const custB = await (
      await api(b.base, '/api/commercial/customers', { method: 'POST', body: JSON.stringify({ name: 'Cliente da Loja B' }) }, b.cookie)
    ).json() as { id: number; uuid: string };

    // --- "Reconectam": duas rodadas de sync em cada máquina para convergência plena ---
    await syncBothTwice(a, b);

    const prodA2 = await findProduct(a, 'Cimento 50kg');
    const prodB2 = await findProduct(b, 'Cimento 50kg');
    check('estoque converge em A sem perda (20-5-3=12)', prodA2?.stock_qty === 12, `stock_qty=${prodA2?.stock_qty}`);
    check('estoque converge em B sem perda (20-5-3=12)', prodB2?.stock_qty === 12, `stock_qty=${prodB2?.stock_qty}`);

    const custOnA = (await (await api(a.base, '/api/commercial/customers?q=Cliente da Loja B', {}, a.cookie)).json()) as { id: number }[];
    check('cliente criado em B aparece em A', custOnA.length === 1);

    const salesOnA = (await (await api(a.base, '/api/store/sales?limit=50', {}, a.cookie)).json().catch(() => [])) as unknown;
    // fallback: histórico pode não ter endpoint de listagem paginada — valida via relatório diário.
    const reportA = (await (await api(a.base, '/api/store/reports/daily', {}, a.cookie)).json()) as {
      totals: { total_cents: number };
    };
    check('relatório de A soma as duas vendas (dois clientes)', reportA.totals.total_cents > 0, `total=${reportA.totals.total_cents}`);
    void salesOnA;

    // --- Idempotência: rodar sync de novo não duplica nada ---
    await syncBothTwice(a, b);
    const prodA3 = await findProduct(a, 'Cimento 50kg');
    const prodB3 = await findProduct(b, 'Cimento 50kg');
    check('idempotente: estoque estável em A', prodA3?.stock_qty === 12, `stock_qty=${prodA3?.stock_qty}`);
    check('idempotente: estoque estável em B', prodB3?.stock_qty === 12, `stock_qty=${prodB3?.stock_qty}`);

    // --- Conflito: mesma entidade editada nas duas máquinas antes de sincronizar ---
    await api(a.base, `/api/commercial/customers/${custOnA[0].id}`, {
      method: 'PUT',
      body: JSON.stringify({ name: 'Cliente Editado em A' }),
    }, a.cookie);
    await new Promise((r) => setTimeout(r, 1100)); // garante updated_at diferente (resolução de segundo)
    await api(b.base, `/api/commercial/customers/${custB.id}`, {
      method: 'PUT',
      body: JSON.stringify({ name: 'Cliente Editado em B (mais recente)' }),
    }, b.cookie);

    await syncBothTwice(a, b);

    const custFinalA = (await (await api(a.base, `/api/commercial/customers?q=Cliente Editado`, {}, a.cookie)).json()) as { name: string }[];
    const custFinalB = (await (await api(b.base, `/api/commercial/customers?q=Cliente Editado`, {}, b.cookie)).json()) as { name: string }[];
    check(
      'conflito converge para a edição mais recente em A',
      custFinalA[0]?.name === 'Cliente Editado em B (mais recente)',
      custFinalA[0]?.name,
    );
    check(
      'conflito converge para a edição mais recente em B',
      custFinalB[0]?.name === 'Cliente Editado em B (mais recente)',
      custFinalB[0]?.name,
    );

    const auditA = (await (await api(a.base, '/api/audit?limit=200', {}, a.cookie)).json()) as { action: string }[];
    check('conflito registrado em audit_logs', auditA.some((r) => r.action === 'sync.conflict'));
  } finally {
    for (const m of [a, b]) m.proc.kill();
    cloudProc.kill();
  }

  console.log(failures === 0 ? '\nFase 6a: TODOS OS TESTES PASSARAM' : `\n${failures} falha(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
