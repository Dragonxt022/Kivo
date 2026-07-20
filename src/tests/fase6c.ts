/**
 * Teste da DoD da Fase 6c (backup em nuvem):
 * backup local sem licença não sobe para a nuvem (comportamento preservado); com
 * licença configurada, o backup manual sobe automaticamente; uma instalação NOVA
 * (nunca viu essa empresa) consegue listar, baixar e restaurar o backup de outra
 * máquina — recuperação completa, incluindo tabelas que o sync da 6a nunca tocaria
 * (login com o mesmo usuário/senha da máquina de origem funciona após restaurar).
 *
 * Pré-requisitos (mesmos da Fase 6a/6b):
 *   1. docker compose -f cloud/docker-compose.yml up -d
 *   2. npm run cloud:install && CLOUD_DB_PORT=3307 npm run cloud:migrate
 */
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';

const ROOT = process.cwd();
const TSX = require.resolve('tsx/cli');
const SCRATCH = path.resolve(ROOT, 'storage', 'temp', 'fase6c');
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

function spawnProc(name: string, script: string, env: Record<string, string>): ChildProcess {
  const proc = spawn(process.execPath, [TSX, script], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', (d) => {
    if (process.env.DEBUG_FASE6C) process.stdout.write(`[${name}] ${d}`);
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

function provisionCompany(companyUuid: string, licenseKey: string): void {
  execFileSync(process.execPath, [TSX, 'cloud/src/provision-company.ts', companyUuid, licenseKey, 'Empresa Teste 6c'], {
    cwd: ROOT,
    env: { ...process.env, ...CLOUD_ENV },
    stdio: 'inherit',
  });
}

interface Machine {
  base: string;
  proc: ChildProcess;
  cookie?: string;
}

function startMachine(port: number, dbPath: string, cloudUrl: string, machineId: string): Machine {
  return {
    base: `http://localhost:${port}`,
    proc: spawnProc(`machine-${machineId}`, 'src/dev.ts', {
      KIVO_DB_PATH: dbPath,
      KIVO_PORT: String(port),
      KIVO_SYNC_SERVER_URL: cloudUrl,
      KIVO_MACHINE_ID: machineId,
    }),
  };
}

async function main(): Promise<void> {
  fs.mkdirSync(SCRATCH, { recursive: true });
  for (const f of fs.readdirSync(SCRATCH)) fs.rmSync(path.join(SCRATCH, f));

  const companyUuid = randomUUID();
  const licenseKey = randomUUID();
  const cloudPort = 4640;
  const cloudUrl = `http://localhost:${cloudPort}`;

  console.log('[setup] provisionando empresa de teste...');
  provisionCompany(companyUuid, licenseKey);

  const cloudProc = spawnProc('cloud', 'cloud/src/server.ts', { ...CLOUD_ENV, CLOUD_PORT: String(cloudPort) });
  await waitForHealth(`${cloudUrl}/api/health`);

  const m1 = startMachine(3631, path.join(SCRATCH, 'machine1.db'), cloudUrl, 'test-machine-6c-1');
  await waitForHealth(`${m1.base}/api/health`);

  const m2 = startMachine(3632, path.join(SCRATCH, 'machine2.db'), cloudUrl, 'test-machine-6c-2');
  await waitForHealth(`${m2.base}/api/health`);

  try {
    m1.cookie = (await loginAs(m1.base, 'admin', 'admin')) ?? undefined;
    check('login admin em m1', !!m1.cookie);

    // --- Sem licença: backup local roda, mas não sobe para a nuvem ---
    const backup1 = await (await api(m1.base, '/api/backup', { method: 'POST' }, m1.cookie)).json() as { id: number };
    const listBefore = (await (await api(m1.base, '/api/backup', {}, m1.cookie)).json()) as { id: number; uploaded_at: string | null }[];
    const row1 = listBefore.find((b) => b.id === backup1.id);
    check('sem licença: backup local não sobe para a nuvem', row1?.uploaded_at == null);

    const cloudListNoLicense = await api(m1.base, '/api/backup/cloud', {}, m1.cookie);
    check('sem licença: listar backups da nuvem falha (502)', cloudListNoLicense.status === 502, String(cloudListNoLicense.status));

    // --- Configura a licença, cria um dado marcador, roda backup de novo ---
    const putLicense = await api(m1.base, '/api/license', { method: 'PUT', body: JSON.stringify({ companyUuid, licenseKey }) }, m1.cookie);
    check('licença configurada em m1', putLicense.ok);

    const marker = await (
      await api(m1.base, '/api/commercial/products', { method: 'POST', body: JSON.stringify({ name: 'Produto Recuperado', priceCents: 1234 }) }, m1.cookie)
    ).json() as { id: number };
    check('produto marcador criado em m1', !!marker.id);

    const backup2 = await (await api(m1.base, '/api/backup', { method: 'POST' }, m1.cookie)).json() as { id: number };
    const listAfter = (await (await api(m1.base, '/api/backup', {}, m1.cookie)).json()) as { id: number; uploaded_at: string | null }[];
    const row2 = listAfter.find((b) => b.id === backup2.id);
    check('com licença: backup manual sobe para a nuvem automaticamente', row2?.uploaded_at != null, String(row2?.uploaded_at));

    const cloudList = (await (await api(m1.base, '/api/backup/cloud', {}, m1.cookie)).json()) as { uuid: string }[];
    check('backup aparece na listagem da nuvem', cloudList.length >= 1);
    const cloudUuid = cloudList[0].uuid;

    // --- Instalação NOVA (m2): nunca viu essa empresa, recupera do zero ---
    m2.cookie = (await loginAs(m2.base, 'admin', 'admin')) ?? undefined;
    check('login admin em m2 (antes da restauração)', !!m2.cookie);
    await api(m2.base, '/api/license', { method: 'PUT', body: JSON.stringify({ companyUuid, licenseKey }) }, m2.cookie);

    const cloudListFromM2 = (await (await api(m2.base, '/api/backup/cloud', {}, m2.cookie)).json()) as { uuid: string }[];
    check('m2 enxerga o backup de m1 na nuvem', cloudListFromM2.some((b) => b.uuid === cloudUuid));

    const downloaded = await (
      await api(m2.base, `/api/backup/cloud/${cloudUuid}/download`, { method: 'POST' }, m2.cookie)
    ).json() as { id: number };
    check('download do backup da nuvem em m2', !!downloaded.id);

    const restoreRes = await api(m2.base, `/api/backup/${downloaded.id}/restore`, { method: 'POST' }, m2.cookie);
    check('restauração em m2', restoreRes.ok, String(restoreRes.status));

    // restaurar sobrescreve a tabela sessions com o snapshot de m1 — o cookie antigo de
    // m2 não existe mais; login de novo prova que o usuário/senha de m1 vieram junto.
    const m2CookieAfter = await loginAs(m2.base, 'admin', 'admin');
    check('login com credenciais de m1 funciona em m2 após restaurar', !!m2CookieAfter);

    const productsOnM2 = (await (await api(m2.base, '/api/commercial/products?q=Produto Recuperado', {}, m2CookieAfter!)).json()) as { name: string }[];
    check('produto marcador de m1 existe em m2 após restauração', productsOnM2.length === 1, JSON.stringify(productsOnM2));

    // --- Corrompe o arquivo na nuvem: download deve recusar por checksum inválido ---
    const storagePath = path.resolve(ROOT, 'cloud', 'storage', 'backups', companyUuid, `${cloudUuid}.gz`);
    const original = fs.readFileSync(storagePath);
    const corrupted = Buffer.from(original);
    corrupted[0] = corrupted[0] ^ 0xff;
    fs.writeFileSync(storagePath, corrupted);

    const corruptedDownload = await api(m2.base, `/api/backup/cloud/${cloudUuid}/download`, { method: 'POST' }, m2CookieAfter!);
    check('download recusa backup corrompido (checksum inválido)', corruptedDownload.status === 502, String(corruptedDownload.status));
  } finally {
    m1.proc.kill();
    m2.proc.kill();
    cloudProc.kill();
  }

  console.log(failures === 0 ? '\nFase 6c: TODOS OS TESTES PASSARAM' : `\n${failures} falha(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
