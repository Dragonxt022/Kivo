/**
 * Teste ponta a ponta do pagamento por Pix (arquivo temporário de verificação).
 *
 * Exercita o caminho REAL do programa do cliente:
 *   tela de Cobranças (app) → /api/billing/charges/:id/payment (app)
 *     → cloud → Mercado Pago (falso, em memória) → QR na tela
 *     → consulta de status → cobrança baixada + licença estendida
 *
 * O Kivo Cloud é o único que fala com o Mercado Pago; o app só fala com o cloud,
 * autenticado pela licença da empresa. `MP_API_BASE` (ver gateway.ts) é o que permite
 * apontar para o servidor falso sem internet e sem dinheiro real.
 *
 * Rodar de dentro de cloud/:  node _e2e-pix.js
 */
require('dotenv').config();
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const path = require('node:path');
const mysql = require('mysql2/promise');

const FAKE_PORT = 4201;
const CLOUD_PORT = 4100;
const APP_PORT = 3200;
const ROOT = path.resolve(__dirname, '..');

const COMPANY = crypto.randomUUID();
const LICENSE_KEY = crypto.randomBytes(24).toString('hex');
const CHARGE_DESCRIPTION = 'Assinatura Kivo — E2E Pix';
const AMOUNT_CENTS = 19990;
const EXTENDS_DAYS = 30;

let mpStatus = 'pending';
let falhas = 0;
const filhos = [];

function check(label, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ` — ${extra}` : ''}`);
  if (!ok) falhas++;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function esperar(url, tentativas = 40) {
  for (let i = 0; i < tentativas; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return true;
    } catch {
      /* ainda subindo */
    }
    await sleep(500);
  }
  return false;
}

/** Mercado Pago de mentira: cria pagamento Pix e devolve o status que o teste mandar. */
function subirFakeMp() {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'POST' && req.url === '/v1/payments') {
        const enviado = JSON.parse(body || '{}');
        res.end(JSON.stringify({
          id: 9001,
          status: 'pending',
          status_detail: 'pending_waiting_transfer',
          transaction_amount: enviado.transaction_amount,
          external_reference: enviado.external_reference,
          point_of_interaction: {
            transaction_data: {
              qr_code: 'FAKE-PIX-COPIA-E-COLA',
              qr_code_base64: 'aGVsbG8=',
              ticket_url: `http://127.0.0.1:${FAKE_PORT}/boleto/9001`,
            },
          },
        }));
        return;
      }
      if (req.method === 'GET' && req.url.startsWith('/v1/payments/9001')) {
        res.end(JSON.stringify({
          id: 9001,
          status: mpStatus,
          status_detail: mpStatus === 'approved' ? 'accredited' : 'pending_waiting_transfer',
          transaction_amount: AMOUNT_CENTS / 100,
          external_reference: `charge:e2e`,
        }));
        return;
      }
      res.statusCode = 404;
      res.end('{}');
    });
  });
  return new Promise((resolve) => server.listen(FAKE_PORT, () => resolve(server)));
}

function subirProcesso(nome, comando, args, cwd, env) {
  const p = spawn(comando, args, { cwd, env: { ...process.env, ...env }, stdio: 'inherit', shell: true });
  p.on('exit', (code) => {
    if (code !== 0 && code !== null) console.log(`[${nome}] saiu com código ${code}`);
  });
  filhos.push({ nome, p });
  return p;
}

async function main() {
  const fake = await subirFakeMp();
  console.log(`[e2e] Mercado Pago falso em http://127.0.0.1:${FAKE_PORT}`);

  subirProcesso('cloud', 'npx', ['tsx', '-r', 'dotenv/config', 'src/server.ts'], path.join(ROOT, 'cloud'), {
    MP_API_BASE: `http://127.0.0.1:${FAKE_PORT}`,
    CLOUD_PORT: String(CLOUD_PORT),
    CLOUD_PUBLIC_URL: `http://127.0.0.1:${CLOUD_PORT}`,
  });
  check('cloud no ar', await esperar(`http://127.0.0.1:${CLOUD_PORT}/`));

  // ── Empresa, cobrança e credencial do gateway no banco do cloud ────────────
  const conn = await mysql.createConnection({
    host: process.env.CLOUD_DB_HOST,
    port: Number(process.env.CLOUD_DB_PORT),
    user: process.env.CLOUD_DB_USER,
    password: process.env.CLOUD_DB_PASSWORD,
    database: process.env.CLOUD_DB_NAME,
  });
  const upsertSetting = (k, v) => conn.query(
    'INSERT INTO app_settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)',
    [k, v],
  );
  await conn.query(
    `INSERT INTO companies (company_uuid, license_key_hash, name, plan, modules, valid_until, max_devices)
     VALUES (?, ?, 'Clinica E2E Pix', 'diamante', NULL, '2027-09-30 00:00:00', 5)`,
    [COMPANY, crypto.createHash('sha256').update(LICENSE_KEY).digest('hex')],
  );
  const [ins] = await conn.query(
    `INSERT INTO charges (company_uuid, description, amount_cents, due_date, status, extends_days, payer_email)
     VALUES (?, ?, ?, CURDATE(), 'pendente', ?, 'cliente@e2e.test')`,
    [COMPANY, CHARGE_DESCRIPTION, AMOUNT_CENTS, EXTENDS_DAYS],
  );
  const chargeId = ins.insertId;
  await upsertSetting('mp_enabled', '1');
  await upsertSetting('mp_access_token', 'TEST-fake-token-e2e');
  await upsertSetting('mp_payer_email', 'padrao@e2e.test');
  check('empresa, cobrança e credencial criadas', chargeId > 0, `cobrança ${chargeId}`);

  // ── App do cliente (mesma licença), apontando para este cloud ─────────────
  subirProcesso('app', 'node', ['scripts/test-isolated.js', '_qa-app-pix.ts'], ROOT, {
    E2E_COMPANY: COMPANY,
    E2E_KEY: LICENSE_KEY,
    E2E_APP_PORT: String(APP_PORT),
    KIVO_SYNC_SERVER_URL: `http://127.0.0.1:${CLOUD_PORT}`,
  });
  const appOk = await esperar(`http://127.0.0.1:${APP_PORT}/api/health`, 60);
  check('app do cliente no ar', appOk);
  if (!appOk) throw new Error('app não subiu');

  const login = await fetch(`http://127.0.0.1:${APP_PORT}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin' }),
  });
  const cookie = (login.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  check('login no app', !!cookie && login.status === 200, `HTTP ${login.status}`);

  const appApi = (rota, init = {}) => fetch(`http://127.0.0.1:${APP_PORT}${rota}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', cookie, ...(init.headers ?? {}) },
  });

  const lista = await (await appApi('/api/billing/charges')).json();
  check('cobrança aparece na tela do app', Array.isArray(lista) && lista.some((c) => c.id === chargeId),
    `${lista.length} cobrança(s)`);

  // ── 1. Gera o Pix pelo app ────────────────────────────────────────────────
  const pix = await appApi(`/api/billing/charges/${chargeId}/payment`, { method: 'POST', body: JSON.stringify({ method: 'pix' }) });
  const pixBody = await pix.json();
  check('app devolve 200 ao gerar Pix', pix.status === 200, JSON.stringify(pixBody).slice(0, 160));
  check('QR do Pix chegou ao app', pixBody.mp_qr_code === 'FAKE-PIX-COPIA-E-COLA', String(pixBody.mp_qr_code));
  check('imagem do QR chegou ao app', pixBody.mp_qr_code_base64 === 'aGVsbG8=', String(pixBody.mp_qr_code_base64));
  check('link público gerado', String(pixBody.public_url ?? '').includes(`/pagar/`), String(pixBody.public_url));

  // ── 2. Ainda não pagou ────────────────────────────────────────────────────
  const st1 = await (await appApi(`/api/billing/charges/${chargeId}/status`)).json();
  check('antes de pagar, segue pendente', st1.status === 'pendente', JSON.stringify(st1).slice(0, 160));

  // ── 3. Cliente paga: o Mercado Pago passa a dizer "approved" ──────────────
  mpStatus = 'approved';
  const st2 = await (await appApi(`/api/billing/charges/${chargeId}/status`)).json();
  check('depois de pagar, cobrança baixada no app', st2.status === 'paga', JSON.stringify(st2).slice(0, 200));
  check('licença estendida na mesma hora', Number(st2.extended_days) === EXTENDS_DAYS && !!st2.valid_until,
    `+${st2.extended_days} dias → ${st2.valid_until}`);

  const [empresaDepois] = await conn.query('SELECT valid_until FROM companies WHERE company_uuid = ?', [COMPANY]);
  check('validade da empresa mudou no banco do cloud', !!empresaDepois[0].valid_until, String(empresaDepois[0].valid_until));

  const listaDepois = await (await appApi('/api/billing/charges')).json();
  check('tela do app mostra a cobrança como paga',
    listaDepois.find((c) => c.id === chargeId)?.status === 'paga');

  // ── 4. Gerar de novo uma cobrança já paga não faz sentido ─────────────────
  const denovo = await appApi(`/api/billing/charges/${chargeId}/payment`, { method: 'POST', body: JSON.stringify({ method: 'pix' }) });
  const denovoBody = await denovo.json();
  check('cobrança paga recusa novo pagamento', denovo.status === 502 && /pendente/i.test(String(denovoBody.error)),
    `${denovo.status} ${denovoBody.error ?? ''}`);

  // ── Limpeza: nada de lixo no banco local do cloud ─────────────────────────
  await conn.query('DELETE FROM charges WHERE company_uuid = ?', [COMPANY]);
  await conn.query('DELETE FROM company_devices WHERE company_uuid = ?', [COMPANY]);
  await conn.query('DELETE FROM companies WHERE company_uuid = ?', [COMPANY]);
  await conn.query("DELETE FROM app_settings WHERE setting_key IN ('mp_enabled','mp_access_token')");
  const [restou] = await conn.query('SELECT COUNT(*) AS t FROM companies WHERE company_uuid = ?', [COMPANY]);
  check('empresa de teste removida', restou[0].t === 0);
  await conn.end();

  fake.close();
  console.log(falhas === 0 ? '\nPix ponta a ponta: TUDO OK' : `\n${falhas} falha(s)`);
  return falhas === 0 ? 0 : 1;
}

main()
  .then((code) => {
    encerrarFilhos();
    setTimeout(() => process.exit(code), 800);
  })
  .catch((e) => {
    console.error('falhou: ' + e.message);
    encerrarFilhos();
    setTimeout(() => process.exit(1), 800);
  });

/**
 * No Windows, `child.kill()` mata o `cmd` intermediário e deixa o node neto vivo segurando
 * as portas e o stdout — o pipe nunca fecha e o teste parece "travado". `taskkill /T` mata a
 * árvore inteira.
 */
function encerrarFilhos() {
  for (const f of filhos) {
    try {
      if (process.platform === 'win32') {
        require('node:child_process').execSync(`taskkill /PID ${f.p.pid} /T /F`, { stdio: 'ignore' });
      } else {
        f.p.kill('SIGKILL');
      }
    } catch {
      /* já morreu */
    }
  }
}
