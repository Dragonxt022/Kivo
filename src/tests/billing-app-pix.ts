/**
 * Teste do pagamento por Pix **de dentro do programa** — o caminho que o lojista usa.
 *
 *   tela Cobranças (app) → /api/billing/charges/:id/payment (app, licença da empresa)
 *     → Kivo Cloud → Mercado Pago → QR na tela → "já pagou?" → cobrança baixada + licença
 *     estendida.
 *
 * Sobe três processos: um Mercado Pago de mentira (HTTP, dentro do teste), o Kivo Cloud
 * apontado para ele (`MP_API_BASE`) e uma instalação do app com banco descartável. Roda sem
 * internet, sem credencial real e sem dinheiro.
 *
 * Complementa `billing-gateway.ts` (que cobre o lado do cloud: boleto, cartão e webhook).
 * Pré-requisitos iguais aos da Fase 6: docker compose + cloud:migrate.
 */
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = process.cwd();
const TSX = require.resolve('tsx/cli');
const CLOUD_ENV = {
  CLOUD_DB_HOST: '127.0.0.1',
  CLOUD_DB_PORT: '3307',
  CLOUD_DB_USER: 'root',
  CLOUD_DB_PASSWORD: 'kivo',
  CLOUD_DB_NAME: 'kivo_cloud',
};

// Portas fora da faixa usada pelos outros testes (ver scripts/test-runner.js).
const MP_PORT = 4251;
const CLOUD_PORT = 4252;
const APP_PORT = 4253;
const MP_URL = `http://127.0.0.1:${MP_PORT}`;
const CLOUD_URL = `http://127.0.0.1:${CLOUD_PORT}`;
const APP_URL = `http://127.0.0.1:${APP_PORT}`;

const COMPANY = crypto.randomUUID();
const LICENSE_KEY = crypto.randomBytes(24).toString('hex');
const DESCRICAO = 'Assinatura Kivo — E2E Pix';
const VALOR_CENTAVOS = 19990;
const DIAS = 30;

let failures = 0;
function check(label: string, ok: boolean, extra = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures++;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function esperar(url: string, tentativas = 40): Promise<boolean> {
  for (let i = 0; i < tentativas; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return true;
    } catch {
      // ainda subindo
    }
    await sleep(500);
  }
  return false;
}

/**
 * O app embrulha toda resposta JSON em `{ success, data }` (o `theme-init.ejs` desembrulha
 * para o navegador). Aqui o teste fala HTTP direto, então desembrulha na mão.
 */
interface Envelope<T> { success: boolean; data: T; error?: string }

// ─────────────────────────── Mercado Pago de mentira ───────────────────────────

interface FakeMp {
  aprovar(): void;
  close(): Promise<void>;
}

function subirMercadoPagoFalso(): Promise<FakeMp> {
  let status = 'pending';
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'POST' && req.url === '/v1/payments') {
        const enviado = JSON.parse(body || '{}') as { transaction_amount?: number; external_reference?: string };
        res.end(JSON.stringify({
          id: 9001,
          status: 'pending',
          status_detail: 'pending_waiting_transfer',
          transaction_amount: enviado.transaction_amount,
          external_reference: enviado.external_reference,
          point_of_interaction: {
            transaction_data: {
              qr_code: 'PIX-COPIA-E-COLA-DO-TESTE',
              qr_code_base64: 'aGVsbG8=',
              ticket_url: `${MP_URL}/boleto/9001`,
            },
          },
        }));
        return;
      }
      if (req.method === 'GET' && req.url?.startsWith('/v1/payments/9001')) {
        res.end(JSON.stringify({
          id: 9001,
          status,
          status_detail: status === 'approved' ? 'accredited' : 'pending_waiting_transfer',
          transaction_amount: VALOR_CENTAVOS / 100,
        }));
        return;
      }
      res.statusCode = 404;
      res.end('{}');
    });
  });
  return new Promise((resolve) => server.listen(MP_PORT, () => resolve({
    aprovar() { status = 'approved'; },
    close: () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); }),
  })));
}

// ─────────────────────────────── Processos ───────────────────────────────

const filhos: ChildProcess[] = [];

function subir(nome: string, script: string, env: Record<string, string>, mostrar = false): ChildProcess {
  const p = spawn(process.execPath, [TSX, script], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  p.stdout?.on('data', (d) => { if (mostrar) process.stdout.write(`[${nome}] ${d}`); });
  p.stderr?.on('data', (d) => {
    const texto = String(d);
    if (!/DeprecationWarning|injected env/.test(texto)) process.stderr.write(`[${nome}:err] ${texto}`);
  });
  filhos.push(p);
  return p;
}

/**
 * No Windows, `child.kill()` mata só o processo direto e deixa o neto segurando as portas.
 * `taskkill /T` derruba a árvore inteira (mesma razão do comentário na Fase 6d).
 */
function encerrarFilhos(): void {
  for (const p of filhos) {
    try {
      if (process.platform === 'win32' && p.pid) {
        execFileSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { stdio: 'ignore' });
      } else {
        p.kill('SIGKILL');
      }
    } catch {
      // já morreu
    }
  }
}

// ─────────────────────────────── O teste ───────────────────────────────

async function main(): Promise<void> {
  const mp = await subirMercadoPagoFalso();
  console.log(`[setup] Mercado Pago de mentira em ${MP_URL}`);

  subir('cloud', 'cloud/src/server.ts', {
    ...CLOUD_ENV,
    MP_API_BASE: MP_URL,
    CLOUD_PORT: String(CLOUD_PORT),
    CLOUD_PUBLIC_URL: CLOUD_URL,
  });
  check('cloud no ar', await esperar(`${CLOUD_URL}/api/health`));

  // ── Empresa, cobrança e credencial do gateway no banco do cloud ────────────
  // mysql2 mora no node_modules do cloud (o app não fala MySQL).
  const requireCloud = createRequire(path.join(ROOT, 'src', 'tests', 'billing-app-pix.ts'));
  const mysql = requireCloud(path.join(ROOT, 'cloud', 'node_modules', 'mysql2', 'promise')) as {
    createConnection(o: Record<string, unknown>): Promise<{
      query(sql: string, params?: unknown[]): Promise<[Record<string, unknown>[], unknown]>;
      end(): Promise<void>;
    }>;
  };
  const conn = await mysql.createConnection({
    host: CLOUD_ENV.CLOUD_DB_HOST,
    port: Number(CLOUD_ENV.CLOUD_DB_PORT),
    user: CLOUD_ENV.CLOUD_DB_USER,
    password: CLOUD_ENV.CLOUD_DB_PASSWORD,
    database: CLOUD_ENV.CLOUD_DB_NAME,
  });
  const salvarSetting = (k: string, v: string) => conn.query(
    'INSERT INTO app_settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)',
    [k, v],
  );

  let appProc: ChildProcess | undefined;
  let dbPath: string | null = null;
  try {
    await conn.query(
      `INSERT INTO companies (company_uuid, license_key_hash, name, plan, modules, valid_until, max_devices)
       VALUES (?, ?, 'Clinica E2E Pix', 'diamante', NULL, '2027-09-30 00:00:00', 5)`,
      [COMPANY, crypto.createHash('sha256').update(LICENSE_KEY).digest('hex')],
    );
    const [ins] = await conn.query(
      `INSERT INTO charges (company_uuid, description, amount_cents, due_date, status, extends_days, payer_email)
       VALUES (?, ?, ?, CURDATE(), 'pendente', ?, 'cliente@e2e.test')`,
      [COMPANY, DESCRICAO, VALOR_CENTAVOS, DIAS],
    );
    const chargeId = Number((ins as unknown as { insertId: number }).insertId);
    await salvarSetting('mp_enabled', '1');
    await salvarSetting('mp_access_token', 'TEST-fake-token-e2e');
    await salvarSetting('mp_payer_email', 'padrao@e2e.test');
    check('empresa, cobrança e credencial criadas', chargeId > 0, `cobrança ${chargeId}`);

    // ── Instalação do cliente (mesma licença), apontando para este cloud ─────
    // Banco descartável preparado ANTES do boot: o gate de ativação barra o login até a
    // ativação existir no banco (mesmo padrão da Fase 6d).
    dbPath = path.join(os.tmpdir(), `kivo-billing-app-pix-${process.pid}.db`);
    for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) fs.rmSync(f, { force: true });    execFileSync(process.execPath, [TSX, 'scripts/prepare-machine-db.ts', dbPath], { cwd: ROOT, stdio: 'pipe' });

    appProc = subir('app', 'src/dev.ts', {
      KIVO_SYNC_SERVER_URL: CLOUD_URL,
      KIVO_PORT: String(APP_PORT),
      KIVO_DB_PATH: dbPath,
    });
    check('app do cliente no ar', await esperar(`${APP_URL}/api/health`, 60));

    const login = await fetch(`${APP_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin' }),
    });
    const cookie = (login.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
    check('login no app', login.status === 200 && !!cookie, `HTTP ${login.status}`);

    const appApi = async <T>(rota: string, init: RequestInit = {}): Promise<T> => {
      const r = await fetch(`${APP_URL}${rota}`, {
        ...init,
        headers: { 'Content-Type': 'application/json', cookie, ...(init.headers ?? {}) },
      });
      const corpo = (await r.json()) as Envelope<T>;
      return corpo.data;
    };

    // A licença do app precisa apontar para a empresa do cloud (senão não há cobrança).
    await appApi('/api/license', {
      method: 'PUT',
      body: JSON.stringify({ companyUuid: COMPANY, licenseKey: LICENSE_KEY }),
    });

    const lista = await appApi<{ id: number; public_url?: string | null }[]>('/api/billing/charges');
    check('cobrança aparece na tela de Cobranças do app',
      Array.isArray(lista) && lista.some((c) => c.id === chargeId), `${lista?.length ?? 0} cobrança(s)`);

    // ── 1. Gerar o Pix pelo app ──────────────────────────────────────────────
    const pix = await appApi<{ mp_qr_code?: string; mp_qr_code_base64?: string; public_url?: string | null }>(
      `/api/billing/charges/${chargeId}/payment`,
      { method: 'POST', body: JSON.stringify({ method: 'pix' }) },
    );
    check('o app devolve o copia e cola do Pix', pix.mp_qr_code === 'PIX-COPIA-E-COLA-DO-TESTE', String(pix.mp_qr_code));
    check('a imagem do QR chega ao app', pix.mp_qr_code_base64 === 'aGVsbG8=', String(pix.mp_qr_code_base64));
    check('o link público da cobrança é gerado', String(pix.public_url ?? '').includes('/pagar/'), String(pix.public_url));

    // ── 2. Ainda não pagou ───────────────────────────────────────────────────
    const antes = await appApi<{ status: string }>(`/api/billing/charges/${chargeId}/status`);
    check('antes de pagar: pendente', antes.status === 'pendente', JSON.stringify(antes));

    // ── 3. O cliente paga (o Mercado Pago passa a dizer "approved") ──────────
    mp.aprovar();
    const depois = await appApi<{ status: string; extended_days?: number; valid_until?: string }>(
      `/api/billing/charges/${chargeId}/status`,
    );
    check('depois de pagar: cobrança baixada', depois.status === 'paga', JSON.stringify(depois));
    check('a licença é estendida na mesma hora',
      Number(depois.extended_days) === DIAS && !!depois.valid_until,
      `+${depois.extended_days} dias → ${depois.valid_until}`);

    const [empresa] = await conn.query('SELECT valid_until FROM companies WHERE company_uuid = ?', [COMPANY]);
    check('a validade mudou no banco do cloud', !!empresa[0]?.valid_until, String(empresa[0]?.valid_until));

    const listaDepois = await appApi<{ id: number; status: string }[]>('/api/billing/charges');
    check('a tela do app passa a mostrar a cobrança como paga',
      listaDepois.find((c) => c.id === chargeId)?.status === 'paga');

    // ── 4. Cobrança paga recusa novo pagamento ───────────────────────────────
    const denovo = await fetch(`${APP_URL}/api/billing/charges/${chargeId}/payment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ method: 'pix' }),
    });
    const corpoDenovo = (await denovo.json()) as { error?: string };
    check('cobrança paga recusa gerar outro pagamento',
      denovo.status === 502 && /pendente/i.test(String(corpoDenovo.error ?? '')),
      `${denovo.status} ${corpoDenovo.error ?? ''}`);
  } finally {
    try {
      // Ordem das FKs: as tabelas filhas antes da empresa (o app cria sync/backup/dispositivo).
      for (const tabela of ['charges', 'company_devices', 'sync_records', 'cloud_backups', 'ai_usage', 'catalog_images', 'menu_items']) {
        await conn.query(`DELETE FROM ${tabela} WHERE company_uuid = ?`, [COMPANY]);
      }
      await conn.query('DELETE FROM companies WHERE company_uuid = ?', [COMPANY]);
      await conn.query("DELETE FROM app_settings WHERE setting_key IN ('mp_enabled','mp_access_token','mp_payer_email')");
      await conn.end();
    } catch (e) {
      console.error('[limpeza] ' + (e as Error).message);
    }
    appProc?.kill();
    encerrarFilhos();
    await mp.close();
    // O banco descartável do app não fica para trás.
    if (dbPath) for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) fs.rmSync(f, { force: true });
  }

  console.log(failures === 0 ? '\nPix pelo app (ponta a ponta): TODOS OS TESTES PASSARAM' : `\n${failures} falha(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  encerrarFilhos();
  process.exit(1);
});
