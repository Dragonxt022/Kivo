/**
 * Teste da DoD da Fase 6d (painel administrativo, MVP):
 * login protegido, CRUD de empresa pelo painel (substitui a CLI), edição de
 * plano/módulos refletida na API que o cliente consome, visibilidade real de
 * sincronizações e backups (gerados por uma instalação cliente de verdade), e
 * ciclo de vida de cobrança manual (criar → marcar paga).
 *
 * Pré-requisitos (mesmos da Fase 6a/6b/6c):
 *   1. docker compose -f cloud/docker-compose.yml up -d
 *   2. npm run cloud:install && CLOUD_DB_PORT=3307 npm run cloud:migrate
 */
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';

const ROOT = process.cwd();
const TSX = require.resolve('tsx/cli');
const SCRATCH = path.resolve(ROOT, 'storage', 'temp', 'fase6d');
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
    if (process.env.DEBUG_FASE6D) process.stdout.write(`[${name}] ${d}`);
  });
  proc.stderr.on('data', (d) => process.stderr.write(`[${name}:err] ${d}`));
  return proc;
}

async function api(base: string, p: string, opts: RequestInit = {}, cookie?: string) {
  return fetch(`${base}${p}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}), ...(opts.headers ?? {}) },
    redirect: 'manual',
  });
}

async function form(base: string, p: string, data: Record<string, string>, cookie?: string) {
  return fetch(`${base}${p}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}) },
    body: new URLSearchParams(data).toString(),
    redirect: 'manual',
  });
}

async function loginAsKivo(base: string, u: string, p: string): Promise<string | null> {
  const r = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: u, password: p }),
  });
  if (!r.ok) return null;
  const m = (r.headers.get('set-cookie') ?? '').match(/kivo_session=([^;]+)/);
  return m ? `kivo_session=${m[1]}` : null;
}

function extractAdminCookie(res: Response): string | null {
  const m = (res.headers.get('set-cookie') ?? '').match(/kivo_admin_session=([^;]+)/);
  return m ? `kivo_admin_session=${m[1]}` : null;
}

async function main(): Promise<void> {
  fs.mkdirSync(SCRATCH, { recursive: true });
  for (const f of fs.readdirSync(SCRATCH)) fs.rmSync(path.join(SCRATCH, f));

  const cloudPort = 4650;
  const cloudUrl = `http://localhost:${cloudPort}`;

  console.log('[setup] provisionando admin do painel...');
  execFileSync(process.execPath, [TSX, 'cloud/src/provision-admin.ts', 'admin6d', 'senhaSegura123'], {
    cwd: ROOT,
    env: { ...process.env, ...CLOUD_ENV },
    stdio: 'inherit',
  });

  const cloudProc = spawnProc('cloud', 'cloud/src/server.ts', { ...CLOUD_ENV, CLOUD_PORT: String(cloudPort) });
  await waitForHealth(`${cloudUrl}/api/health`);

  let machineProc: ChildProcess | undefined;
  try {
    // --- Autenticação do painel ---
    const badLogin = await form(cloudUrl, '/admin/login', { username: 'admin6d', password: 'errada' });
    check('login com senha errada falha (401)', badLogin.status === 401, String(badLogin.status));

    const noCookie = await api(cloudUrl, '/admin');
    check('acesso ao painel sem cookie redireciona ao login', noCookie.status === 302 && (noCookie.headers.get('location') ?? '').includes('/admin/login'));

    const goodLogin = await form(cloudUrl, '/admin/login', { username: 'admin6d', password: 'senhaSegura123' });
    const adminCookie = extractAdminCookie(goodLogin);
    check('login correto retorna cookie de sessão', goodLogin.status === 302 && !!adminCookie);

    // --- CRUD de empresa pelo painel ---
    const createRes = await form(
      cloudUrl,
      '/admin/companies',
      { name: 'Loja Teste 6d', plan: 'basico', modules: 'commercial,finance,store' },
      adminCookie!,
    );
    const createBody = await createRes.text();
    const uuidMatch = createBody.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/);
    const keyMatch = createBody.match(/<code>([0-9a-f]+)<\/code>/);
    check('empresa criada pelo painel revela uuid e chave', !!uuidMatch && !!keyMatch);
    const companyUuid = uuidMatch![1];
    const licenseKey = keyMatch![1];

    const dashboardBody = await (await api(cloudUrl, '/admin', {}, adminCookie!)).text();
    check('empresa aparece no dashboard', dashboardBody.includes('Loja Teste 6d'));

    // --- Instalação cliente de verdade: gera atividade real de sync/backup ---
    machineProc = spawnProc('machine', 'src/dev.ts', {
      KIVO_DB_PATH: path.join(SCRATCH, 'machine.db'),
      KIVO_PORT: '3641',
      KIVO_SYNC_SERVER_URL: cloudUrl,
      KIVO_MACHINE_ID: 'test-machine-6d',
    });
    const machineBase = 'http://localhost:3641';
    await waitForHealth(`${machineBase}/api/health`);
    const kivoCookie = await loginAsKivo(machineBase, 'admin', 'admin');
    check('login na instalação cliente', !!kivoCookie);

    await fetch(`${machineBase}/api/license`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', cookie: kivoCookie! },
      body: JSON.stringify({ companyUuid, licenseKey }),
    });
    await fetch(`${machineBase}/api/commercial/products`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: kivoCookie! },
      body: JSON.stringify({ name: 'Produto 6d', priceCents: 500 }),
    });
    const syncRes = await fetch(`${machineBase}/api/sync/run`, { method: 'POST', headers: { cookie: kivoCookie! } });
    check('sync gera atividade real', syncRes.ok);
    const backupRes = await fetch(`${machineBase}/api/backup`, { method: 'POST', headers: { cookie: kivoCookie! } });
    check('backup manual sobe para a nuvem (licença já configurada)', backupRes.ok);

    const detailAfterActivity = await (await api(cloudUrl, `/admin/companies/${companyUuid}`, {}, adminCookie!)).text();
    check('painel mostra sincronização real (não "nunca")', !detailAfterActivity.includes('nunca'));
    check('painel mostra o backup real (não "Nenhum backup ainda")', !detailAfterActivity.includes('Nenhum backup ainda'));

    // --- Editar plano/módulos pelo painel e conferir que a API que o cliente
    // consome (a mesma usada por refreshLicenseFromCloud) reflete a mudança ---
    await form(cloudUrl, `/admin/companies/${companyUuid}`, { name: 'Loja Teste 6d', plan: 'reduzido', modules: 'commercial' }, adminCookie!);
    const validateRes = await fetch(`${cloudUrl}/api/license/validate`, {
      headers: { 'X-Kivo-Company': companyUuid, 'X-Kivo-License-Key': licenseKey },
    });
    const validateBody = (await validateRes.json()) as { plan: string; modules: string[] };
    check('painel e API batem no mesmo dado após edição', validateBody.plan === 'reduzido' && JSON.stringify(validateBody.modules) === JSON.stringify(['commercial']), JSON.stringify(validateBody));

    // --- Cobrança manual: criar, marcar paga ---
    await form(cloudUrl, `/admin/companies/${companyUuid}/charges`, { description: 'Mensalidade', amount: '99.90', dueDate: '2026-08-10' }, adminCookie!);
    const detailWithCharge = await (await api(cloudUrl, `/admin/companies/${companyUuid}`, {}, adminCookie!)).text();
    check('cobrança criada aparece como pendente', detailWithCharge.includes('Mensalidade') && detailWithCharge.includes('pendente'));

    const idMatch = detailWithCharge.match(/charges\/(\d+)\/pay/);
    check('id da cobrança encontrado no HTML', !!idMatch);
    const chargeRowBefore = detailWithCharge.match(/<tr>\s*<td>Mensalidade<\/td>[\s\S]*?<\/tr>/);
    check('antes de pagar: sem data de pagamento na linha da cobrança', !!chargeRowBefore && chargeRowBefore[0].includes('>—<'));

    await form(cloudUrl, `/admin/companies/${companyUuid}/charges/${idMatch![1]}/pay`, {}, adminCookie!);
    const detailAfterPay = await (await api(cloudUrl, `/admin/companies/${companyUuid}`, {}, adminCookie!)).text();
    check('cobrança marcada como paga', detailAfterPay.includes('class="paga"'));
    const chargeRowAfter = detailAfterPay.match(/<tr>\s*<td>Mensalidade<\/td>[\s\S]*?<\/tr>/);
    check(
      'data de pagamento preenchida após marcar como paga',
      !!chargeRowAfter && /\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/.test(chargeRowAfter[0]),
    );
  } finally {
    machineProc?.kill();
    cloudProc.kill();
  }

  console.log(failures === 0 ? '\nFase 6d: TODOS OS TESTES PASSARAM' : `\n${failures} falha(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
