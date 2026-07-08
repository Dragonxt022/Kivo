/**
 * Teste da DoD da Fase 6b (licenciamento remoto + módulos habilitados por plano):
 * sem licença configurada, tudo carrega (modo dev, comportamento preservado); com uma
 * licença cujo plano não inclui `store`, o módulo passa a responder 403 (Fase 6f:
 * checado a cada requisição, efeito imediato — não precisa mais reiniciar, embora
 * reiniciar continue funcionando do mesmo jeito); se o plano voltar a incluir
 * `store`, o módulo volta a responder na hora também.
 *
 * Pré-requisitos (mesmos da Fase 6a):
 *   1. docker compose -f cloud/docker-compose.yml up -d
 *   2. npm run cloud:install && CLOUD_DB_PORT=3307 npm run cloud:migrate
 */
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';

const ROOT = process.cwd();
const TSX = require.resolve('tsx/cli');
const SCRATCH = path.resolve(ROOT, 'storage', 'temp', 'fase6b');
const CLOUD_ENV = {
  CLOUD_DB_HOST: '127.0.0.1',
  CLOUD_DB_PORT: '3307',
  CLOUD_DB_USER: 'root',
  CLOUD_DB_PASSWORD: 'katsu',
  CLOUD_DB_NAME: 'katsu_cloud',
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

function spawnProc(name: string, script: string, env: Record<string, string>): ChildProcess {
  const proc = spawn(process.execPath, [TSX, script], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', (d) => {
    if (process.env.DEBUG_FASE6B) process.stdout.write(`[${name}] ${d}`);
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
  const m = (r.headers.get('set-cookie') ?? '').match(/katsu_session=([^;]+)/);
  return m ? `katsu_session=${m[1]}` : null;
}

function provisionCompany(companyUuid: string, licenseKey: string, plan: string, modules: string[]): void {
  execFileSync(
    process.execPath,
    [TSX, 'cloud/src/provision-company.ts', companyUuid, licenseKey, 'Empresa Teste 6b', '--plan', plan, '--modules', modules.join(',')],
    { cwd: ROOT, env: { ...process.env, ...CLOUD_ENV }, stdio: 'inherit' },
  );
}

interface Machine {
  base: string;
  proc: ChildProcess;
  cookie?: string;
}

function killAndWait(proc: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    proc.once('exit', () => resolve());
    proc.kill();
  });
}

function startMachine(port: number, dbPath: string, cloudUrl: string): Machine {
  return {
    base: `http://localhost:${port}`,
    proc: spawnProc('machine', 'src/dev.ts', {
      KATSU_DB_PATH: dbPath,
      KATSU_PORT: String(port),
      KATSU_SYNC_SERVER_URL: cloudUrl,
      KATSU_MACHINE_ID: 'test-machine-6b',
    }),
  };
}

async function main(): Promise<void> {
  fs.mkdirSync(SCRATCH, { recursive: true });
  for (const f of fs.readdirSync(SCRATCH)) fs.rmSync(path.join(SCRATCH, f));

  const companyUuid = randomUUID();
  const licenseKey = randomUUID();
  const cloudPort = 4630;
  const cloudUrl = `http://localhost:${cloudPort}`;
  const machinePort = 3621;
  const dbPath = path.join(SCRATCH, 'machine.db');

  console.log('[setup] provisionando empresa (plano básico: commercial + finance, sem store)...');
  provisionCompany(companyUuid, licenseKey, 'basico', ['commercial', 'finance']);

  const cloudProc = spawnProc('cloud', 'cloud/src/server.ts', { ...CLOUD_ENV, CLOUD_PORT: String(cloudPort) });
  await waitForHealth(`${cloudUrl}/api/health`);

  let m = startMachine(machinePort, dbPath, cloudUrl);
  await waitForHealth(`${m.base}/api/health`);

  try {
    m.cookie = (await loginAs(m.base, 'admin', 'admin')) ?? undefined;
    check('login admin', !!m.cookie);

    // --- Sem licença configurada: modo dev, tudo carrega (comportamento preservado) ---
    const storeBefore = await api(m.base, '/api/store/reports/daily', {}, m.cookie);
    check('sem licença: store carregado (modo dev)', storeBefore.status !== 404, String(storeBefore.status));

    // --- Configura a licença e sincroniza (refreshLicenseFromCloud roda dentro do sync) ---
    const putLicense = await api(m.base, '/api/license', { method: 'PUT', body: JSON.stringify({ companyUuid, licenseKey }) }, m.cookie);
    check('licença configurada', putLicense.ok);
    const syncRes = await api(m.base, '/api/sync/run', { method: 'POST' }, m.cookie);
    check('sync/run (dispara refresh de licença)', syncRes.ok);

    const licenseInfo = (await (await api(m.base, '/api/license', {}, m.cookie)).json()) as { modules: string[] | null };
    check('cache local reflete módulos do plano', JSON.stringify(licenseInfo.modules) === JSON.stringify(['commercial', 'finance']), JSON.stringify(licenseInfo.modules));

    // --- Fase 6f: efeito imediato, SEM reiniciar — o sync/run acima já deve bastar ---
    const storeImmediate = await api(m.base, '/api/store/reports/daily', {}, m.cookie);
    check('sem reiniciar: store já fica fora do plano (403) logo após o sync', storeImmediate.status === 403, String(storeImmediate.status));

    // --- Reinicia: confirma que também se mantém correto depois de reiniciar ---
    await killAndWait(m.proc);
    m = startMachine(machinePort, dbPath, cloudUrl);
    await waitForHealth(`${m.base}/api/health`);
    m.cookie = (await loginAs(m.base, 'admin', 'admin')) ?? undefined;
    check('login admin após restart', !!m.cookie);

    const storeAfter = await api(m.base, '/api/store/reports/daily', {}, m.cookie);
    check('após restart: store fora do plano → 403', storeAfter.status === 403, String(storeAfter.status));
    const commercialAfter = await api(m.base, '/api/commercial/products', {}, m.cookie);
    check('após restart: commercial segue funcionando', commercialAfter.ok, String(commercialAfter.status));
    const financeAfter = await api(m.base, '/api/finance/cash/current', {}, m.cookie);
    check('após restart: finance segue funcionando', financeAfter.ok, String(financeAfter.status));

    // --- Upgrade de plano: passa a incluir store também ---
    provisionCompany(companyUuid, licenseKey, 'completo', ['commercial', 'finance', 'store']);
    const syncRes2 = await api(m.base, '/api/sync/run', { method: 'POST' }, m.cookie);
    check('sync/run após upgrade de plano', syncRes2.ok);

    // --- Fase 6f: de novo, sem reiniciar — o upgrade já deve liberar store na hora ---
    const storeImmediateUpgrade = await api(m.base, '/api/store/reports/daily', {}, m.cookie);
    check('sem reiniciar: store já volta a carregar logo após o upgrade', storeImmediateUpgrade.status !== 403, String(storeImmediateUpgrade.status));

    await killAndWait(m.proc);
    m = startMachine(machinePort, dbPath, cloudUrl);
    await waitForHealth(`${m.base}/api/health`);
    m.cookie = (await loginAs(m.base, 'admin', 'admin')) ?? undefined;

    const storeUpgraded = await api(m.base, '/api/store/reports/daily', {}, m.cookie);
    check('após upgrade + restart: store volta a carregar', storeUpgraded.status !== 404, String(storeUpgraded.status));

    // --- Empresa provisionada SEM --modules (nunca configurado) deve ser fail-open,
    // não "nenhum módulo liberado" (regressão do bug: cloud devolvia [] em vez de null) ---
    const companyUuid2 = randomUUID();
    const licenseKey2 = randomUUID();
    execFileSync(process.execPath, [TSX, 'cloud/src/provision-company.ts', companyUuid2, licenseKey2, 'Empresa Sem Restrição'], {
      cwd: ROOT,
      env: { ...process.env, ...CLOUD_ENV },
      stdio: 'inherit',
    });
    await api(m.base, '/api/license', { method: 'PUT', body: JSON.stringify({ companyUuid: companyUuid2, licenseKey: licenseKey2 }) }, m.cookie);
    await api(m.base, '/api/sync/run', { method: 'POST' }, m.cookie);

    await killAndWait(m.proc);
    m = startMachine(machinePort, dbPath, cloudUrl);
    await waitForHealth(`${m.base}/api/health`);
    m.cookie = (await loginAs(m.base, 'admin', 'admin')) ?? undefined;

    const storeNoRestriction = await api(m.base, '/api/store/reports/daily', {}, m.cookie);
    check('empresa sem --modules configurado: fail-open (store carrega)', storeNoRestriction.status !== 404, String(storeNoRestriction.status));
  } finally {
    m.proc.kill();
    cloudProc.kill();
  }

  console.log(failures === 0 ? '\nFase 6b: TODOS OS TESTES PASSARAM' : `\n${failures} falha(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
