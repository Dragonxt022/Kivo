/**
 * Teste do pagamento da assinatura pelo Mercado Pago — Pix, boleto e cartão.
 *
 * Sobe um **Mercado Pago de mentira** dentro do próprio teste (servidor HTTP em processo) e
 * aponta o cloud para ele com `MP_API_BASE`. Assim o fluxo inteiro roda sem internet, sem
 * credencial real e sem dinheiro: criação do Pix, QR, boleto, link de cartão, página pública,
 * webhook com assinatura HMAC e a baixa que estende a licença.
 *
 * Pré-requisitos (mesmos da Fase 6a..6d):
 *   1. docker compose -f cloud/docker-compose.yml up -d
 *   2. npm run cloud:install && CLOUD_DB_PORT=3307 npm run cloud:migrate
 */
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import http from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';

/** `require` pelo caminho absoluto, para carregar o mysql2 que mora no node_modules do cloud. */
const requireCloud = createRequire(__filename);

const ROOT = process.cwd();
const TSX = require.resolve('tsx/cli');
const CLOUD_ENV = {
  CLOUD_DB_HOST: '127.0.0.1',
  CLOUD_DB_PORT: '3307',
  CLOUD_DB_USER: 'root',
  CLOUD_DB_PASSWORD: 'kivo',
  CLOUD_DB_NAME: 'kivo_cloud',
};
const CLOUD_PORT = 4660;
const STUB_PORT = 4661;
const CLOUD_URL = `http://localhost:${CLOUD_PORT}`;
const STUB_URL = `http://localhost:${STUB_PORT}`;
const SEGREDO_WEBHOOK = 'segredo-webhook-do-teste';
const ADMIN_USER = 'adminpay';
const ADMIN_PASS = 'senhaPagamento123';
/** Validade inicial da empresa — a baixa da cobrança de 30 dias tem de virar 31/01/2027. */
const VALIDADE_INICIAL = '2027-01-01';
const VALIDADE_ESPERADA = '2027-01-31';

let failures = 0;
function check(label: string, ok: boolean, extra = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures++;
}

// ───────────────────────── Mercado Pago de mentira ─────────────────────────

interface Stub {
  aprovar(): void;
  ultimoPagamento(): string | null;
  close(): Promise<void>;
}

function startStub(): Promise<Stub> {
  const pagamentos = new Map<string, { status: string; external_reference?: string; metodo?: string }>();
  let seq = 5000;
  let aprovado = false;
  let ultimo: string | null = null;

  const json = (res: http.ServerResponse, code: number, body: unknown) => {
    res.statusCode = code;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(body));
  };

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const url = new URL(req.url ?? '/', STUB_URL);
      const p = url.pathname;

      if (req.method === 'POST' && p === '/v1/payments') {
        const payload = JSON.parse(body || '{}') as { payment_method_id?: string; external_reference?: string; transaction_amount?: number };
        const id = String(++seq);
        ultimo = id;
        const status = aprovado ? 'approved' : 'pending';
        pagamentos.set(id, { status, external_reference: payload.external_reference, metodo: payload.payment_method_id });
        if (payload.payment_method_id === 'pix') {
          return json(res, 201, {
            id,
            status,
            status_detail: status === 'approved' ? 'accredited' : 'pending_waiting_transfer',
            external_reference: payload.external_reference,
            transaction_amount: payload.transaction_amount,
            point_of_interaction: {
              transaction_data: {
                qr_code: '00020126580014BR.GOV.BCB.PIX0136chave-de-mentira-do-teste',
                qr_code_base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/AGtE1wAAAAASUVORK5CYII=',
                ticket_url: `https://mp.test/pix/${id}`,
              },
            },
          });
        }
        return json(res, 201, {
          id,
          status,
          status_detail: 'pending_waiting_payment',
          external_reference: payload.external_reference,
          transaction_amount: payload.transaction_amount,
          transaction_details: { external_resource_url: `https://mp.test/boleto/${id}` },
        });
      }

      if (req.method === 'GET' && p.startsWith('/v1/payments/')) {
        const id = p.split('/').pop() ?? '';
        const pay = pagamentos.get(id);
        if (!pay) return json(res, 404, { message: 'payment not found' });
        return json(res, 200, {
          id,
          status: pay.status,
          status_detail: pay.status === 'approved' ? 'accredited' : 'pending_waiting_transfer',
          external_reference: pay.external_reference,
        });
      }

      if (req.method === 'POST' && p === '/checkout/preferences') {
        return json(res, 201, { id: 'pref-teste', init_point: 'https://mp.test/checkout/pref-teste' });
      }

      return json(res, 404, { message: `stub não conhece ${req.method} ${p}` });
    });
  });

  return new Promise((resolve) => {
    server.listen(STUB_PORT, () => resolve({
      aprovar() {
        aprovado = true;
        pagamentos.forEach((v) => { v.status = 'approved'; });
      },
      ultimoPagamento: () => ultimo,
      close: () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); }),
    }));
  });
}

// ─────────────────────────────── Utilidades ───────────────────────────────

function spawnProc(name: string, script: string, env: Record<string, string>): ChildProcess {
  const proc = spawn(process.execPath, [TSX, script], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', (d) => { if (process.env.DEBUG_PAGAMENTO) process.stdout.write(`[${name}] ${d}`); });
  proc.stderr.on('data', (d) => process.stderr.write(`[${name}:err] ${d}`));
  return proc;
}

function waitForHealth(url: string, timeoutMs = 25000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tentar = () => {
      fetch(url).then((r) => (r.ok ? resolve() : retry())).catch(retry);
    };
    const retry = () => {
      if (Date.now() - start > timeoutMs) {
        reject(new Error(`Timeout aguardando ${url}`));
        return;
      }
      setTimeout(tentar, 300);
    };
    tentar();
  });
}

async function api(p: string, opts: RequestInit = {}, cookie?: string) {
  return fetch(`${CLOUD_URL}${p}`, {
    ...opts,
    redirect: 'manual',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}), ...(opts.headers ?? {}) },
  });
}

async function form(p: string, data: Record<string, string>, cookie?: string) {
  return fetch(`${CLOUD_URL}${p}`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}) },
    body: new URLSearchParams(data).toString(),
  });
}

interface ChargeRow {
  id: number;
  description: string;
  status: string;
  public_url: string | null;
  mp_status: string | null;
  mp_method: string | null;
  public_token: string | null;
}

/** A tabela de cobranças vem embutida no HTML como `rows: [...]` (Alpine). */
function chargesFromDetail(html: string): ChargeRow[] {
  const re = /rows:\s*(\[[\s\S]*?\](?=,))/g;
  for (const m of html.matchAll(re)) {
    try {
      const arr = JSON.parse(m[1]) as ChargeRow[];
      if (Array.isArray(arr) && arr.length && 'description' in arr[0] && 'due_date' in (arr[0] as object)) return arr;
    } catch {
      // outra tabela: segue para a próxima
    }
  }
  return [];
}

function validadeFromDetail(html: string): string | null {
  const m = html.match(/name="validUntil"[^>]*value="([^"]*)"/);
  return m ? m[1] : null;
}

interface DbConn {
  query(sql: string, params?: unknown[]): Promise<unknown>;
  end(): Promise<void>;
}

/**
 * Limpa o que o teste criou no banco COMPARTILHADO do docker (o mesmo que o cloud de
 * desenvolvimento usa). Sem isso sobra uma credencial falsa de teste salva — e ela aparece
 * na tela do painel como se o gateway estivesse configurado.
 */
async function limparBancoDoTeste(companyUuid: string | null): Promise<void> {
  try {
    // mysql2 mora no node_modules do cloud (o app não fala MySQL): carregado por caminho.
    const mysql = requireCloud(path.join(ROOT, 'cloud', 'node_modules', 'mysql2', 'promise')) as {
      createConnection(opts: Record<string, unknown>): Promise<DbConn>;
    };
    const conn = await mysql.createConnection({
      host: CLOUD_ENV.CLOUD_DB_HOST,
      port: Number(CLOUD_ENV.CLOUD_DB_PORT),
      user: CLOUD_ENV.CLOUD_DB_USER,
      password: CLOUD_ENV.CLOUD_DB_PASSWORD,
      database: CLOUD_ENV.CLOUD_DB_NAME,
    });
    if (companyUuid) {
      // Ordem das FKs: as tabelas filhas antes da empresa (o teste registra dispositivo ao
      // validar a licença no fim, e isso bloqueava a remoção).
      for (const tabela of ['charges', 'company_devices', 'sync_records', 'cloud_backups', 'ai_usage', 'catalog_images']) {
        await conn.query(`DELETE FROM ${tabela} WHERE company_uuid = ?`, [companyUuid]);
      }
      await conn.query('DELETE FROM companies WHERE company_uuid = ?', [companyUuid]);
    }
    await conn.query(
      "DELETE FROM app_settings WHERE setting_key IN ('mp_access_token','mp_webhook_secret','mp_enabled','mp_payer_email')",
    );
    await conn.end();
  } catch (e) {
    // Limpeza é melhor-esforço: não invalidar o resultado do teste por causa dela.
    console.error('[limpeza] não deu para limpar o banco do teste: ' + (e as Error).message);
  }
}

async function main(): Promise<void> {
  console.log('[setup] subindo o Mercado Pago de mentira e o cloud...');
  const stub = await startStub();

  execFileSync(process.execPath, [TSX, 'cloud/src/provision-admin.ts', ADMIN_USER, ADMIN_PASS], {
    cwd: ROOT,
    env: { ...process.env, ...CLOUD_ENV },
    stdio: 'pipe',
  });

  const cloudProc = spawnProc('cloud', 'cloud/src/server.ts', {
    ...CLOUD_ENV,
    CLOUD_PORT: String(CLOUD_PORT),
    MP_API_BASE: STUB_URL,
    CLOUD_PUBLIC_URL: CLOUD_URL,
  });
  let companyUuid: string | null = null;

  try {
    await waitForHealth(`${CLOUD_URL}/api/health`);

    const login = await form('/admin/login', { username: ADMIN_USER, password: ADMIN_PASS });
    const cookie = (login.headers.get('set-cookie') ?? '').match(/kivo_admin_session=([^;]+)/)?.[1];
    check('login no painel', login.status === 302 && !!cookie, String(login.status));
    const admin = `kivo_admin_session=${cookie}`;

    // ── Credenciais ────────────────────────────────────────────────────────
    const salvar = await form('/admin/payments', {
      enabled: '1',
      accessToken: 'TEST-00000000-0000-0000-0000-000000000000',
      webhookSecret: SEGREDO_WEBHOOK,
      payerEmail: 'financeiro@kivo.test',
    }, admin);
    check('salvar credenciais do gateway', salvar.status === 302, String(salvar.status));

    const paginaPagamentos = await (await api('/admin/payments', {}, admin)).text();
    check('painel mostra o gateway ligado', paginaPagamentos.includes('Pagamento online ligado'));
    check('painel mostra o tutorial', paginaPagamentos.includes('Como conseguir a chave') && paginaPagamentos.includes('Suas integrações'));
    check('painel mostra a URL do webhook para colar no Mercado Pago',
      paginaPagamentos.includes(`${CLOUD_URL}/api/webhooks/mercadopago`));

    // ── Empresa e cobrança ─────────────────────────────────────────────────
    const criada = await form('/admin/companies', {
      name: 'Clinica do Pagamento', plan: 'diamante', modules: 'commercial,finance', validUntil: VALIDADE_INICIAL,
    }, admin);
    const corpo = await criada.text();
    const uuid = corpo.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/)?.[1];
    const chave = corpo.match(/<code>([0-9a-f]{16,})<\/code>/)?.[1];
    check('empresa criada pelo painel', !!uuid && !!chave);
    companyUuid = uuid!;

    await form(`/admin/companies/${companyUuid}/charges`, {
      description: 'Mensalidade Kivo — teste de pagamento',
      amount: '129,90',
      dueDate: '2026-12-10',
      instructions: 'Pagamento pelo link',
      payerEmail: 'cliente@kivo.test',
      extendsDays: '30',
    }, admin);

    let detalhe = await (await api(`/admin/companies/${companyUuid}`, {}, admin)).text();
    const cobrancas = chargesFromDetail(detalhe);
    const cobranca = cobrancas.find((c) => c.description.includes('Mensalidade Kivo'));
    check('cobrança criada e listada no painel', !!cobranca, JSON.stringify(cobrancas.map((c) => c.description)));
    check('validade inicial gravada', validadeFromDetail(detalhe) === VALIDADE_INICIAL, String(validadeFromDetail(detalhe)));

    // ── Página pública ─────────────────────────────────────────────────────
    const token = cobranca!.public_token!;
    const publica = await fetch(`${CLOUD_URL}/pagar/${token}`);
    const htmlPublico = await publica.text();
    check('página pública responde 200', publica.status === 200, String(publica.status));
    check('página pública mostra descrição e valor', htmlPublico.includes('Mensalidade Kivo') && htmlPublico.includes('129,90'));
    check('página pública oferece Pix, boleto e cartão',
      htmlPublico.includes('value="pix"') && htmlPublico.includes('value="boleto"') && htmlPublico.includes('value="card"'));

    const gerouPix = await form(`/pagar/${token}/gateway`, { method: 'pix' });
    check('gerar Pix redireciona de volta', gerouPix.status === 302, String(gerouPix.status));
    const comPix = await (await fetch(`${CLOUD_URL}/pagar/${token}`)).text();
    check('QR do Pix aparece na página', comPix.includes('data:image/png;base64,'));
    check('Pix copia e cola aparece na página', comPix.includes('00020126580014BR.GOV.BCB.PIX'));

    const statusAntes = await (await fetch(`${CLOUD_URL}/pagar/${token}/status`)).json() as { status: string };
    check('status antes de pagar: pendente', statusAntes.status === 'pendente', JSON.stringify(statusAntes));

    // ── Confirmação (o Mercado Pago de mentira aprova) ─────────────────────
    stub.aprovar();
    const statusDepois = await (await fetch(`${CLOUD_URL}/pagar/${token}/status`)).json() as { status: string };
    check('status depois de pagar: paga', statusDepois.status === 'paga', JSON.stringify(statusDepois));

    const confirmada = await (await fetch(`${CLOUD_URL}/pagar/${token}`)).text();
    check('página pública confirma o pagamento', confirmada.includes('Pagamento confirmado'));

    detalhe = await (await api(`/admin/companies/${companyUuid}`, {}, admin)).text();
    const cobrancaPaga = chargesFromDetail(detalhe).find((c) => c.id === cobranca!.id);
    check('painel mostra a cobrança paga', cobrancaPaga?.status === 'paga', JSON.stringify(cobrancaPaga));
    check('painel mostra o status do gateway', cobrancaPaga?.mp_status === 'approved', String(cobrancaPaga?.mp_status));
    check('licença estendida pelos dias da cobrança',
      validadeFromDetail(detalhe) === VALIDADE_ESPERADA,
      `${validadeFromDetail(detalhe)} (esperado ${VALIDADE_ESPERADA})`);

    // ── Boleto e cartão numa segunda cobrança ──────────────────────────────
    await form(`/admin/companies/${companyUuid}/charges`, {
      description: 'Segunda via — boleto e cartão', amount: '50,00', dueDate: '2026-12-20',
    }, admin);
    detalhe = await (await api(`/admin/companies/${companyUuid}`, {}, admin)).text();
    const segunda = chargesFromDetail(detalhe).find((c) => c.description.includes('Segunda via'))!;
    const token2 = segunda.public_token!;

    const gerouBoleto = await form(`/pagar/${token2}/gateway`, { method: 'boleto' });
    check('gerar boleto redireciona de volta', gerouBoleto.status === 302, String(gerouBoleto.status));
    const comBoleto = await (await fetch(`${CLOUD_URL}/pagar/${token2}`)).text();
    check('link do boleto aparece na página', comBoleto.includes('mp.test/boleto/'));

    const gerouCartao = await form(`/pagar/${token2}/gateway`, { method: 'card' });
    check('cartão manda para o Checkout Pro', gerouCartao.status === 302
      && (gerouCartao.headers.get('location') ?? '').includes('mp.test/checkout'),
      gerouCartao.headers.get('location') ?? '');

    // ── Webhook ────────────────────────────────────────────────────────────
    const assinatura = (ts: string, requestId: string, dataId: string) => {
      const manifest = `id:${dataId};request-id:${requestId};ts:${ts};`;
      return `ts=${ts},v1=${crypto.createHmac('sha256', SEGREDO_WEBHOOK).update(manifest).digest('hex')}`;
    };
    const enviarWebhook = (header: string, requestId: string, dataId: string) =>
      fetch(`${CLOUD_URL}/api/webhooks/mercadopago?data.id=${dataId}&type=payment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-request-id': requestId, 'x-signature': header },
        body: JSON.stringify({ id: 1, type: 'payment', action: 'payment.updated', data: { id: dataId } }),
      });

    const pagamentoStub = stub.ultimoPagamento();
    check('o stub registrou o pagamento criado', !!pagamentoStub, String(pagamentoStub));

    const ruim = await enviarWebhook('ts=1704908010,v1=deadbeef', 'req-ruim', pagamentoStub!);
    check('webhook com assinatura inválida → 401', ruim.status === 401, String(ruim.status));

    // Terceira cobrança: o webhook é quem confirma (nada de polling).
    await form(`/admin/companies/${companyUuid}/charges`, {
      description: 'Terceira via — só webhook', amount: '77,00', dueDate: '2026-12-25',
    }, admin);
    detalhe = await (await api(`/admin/companies/${companyUuid}`, {}, admin)).text();
    const terceira = chargesFromDetail(detalhe).find((c) => c.description.includes('Terceira via'))!;
    await form(`/pagar/${terceira.public_token}/gateway`, { method: 'pix' });
    const pagamentoTerceira = stub.ultimoPagamento()!;

    const ts = '1704908010';
    const requestId = 'req-valido';
    const bom = await enviarWebhook(assinatura(ts, requestId, pagamentoTerceira), requestId, pagamentoTerceira);
    check('webhook com assinatura válida → 200', bom.status === 200, String(bom.status));

    detalhe = await (await api(`/admin/companies/${companyUuid}`, {}, admin)).text();
    const pagaPorWebhook = chargesFromDetail(detalhe).find((c) => c.id === terceira.id);
    check('webhook aprovado baixou a cobrança', pagaPorWebhook?.status === 'paga', JSON.stringify(pagaPorWebhook?.status));

    // Repetir a notificação (o Mercado Pago reenvia) não pode pagar nem estender de novo.
    const validadeAntes = validadeFromDetail(detalhe);
    await enviarWebhook(assinatura(ts, requestId, pagamentoTerceira), requestId, pagamentoTerceira);
    const validadeDepois = validadeFromDetail(await (await api(`/admin/companies/${companyUuid}`, {}, admin)).text());
    check('webhook repetido é idempotente (licença não estica de novo)',
      validadeAntes === validadeDepois, `${validadeAntes} → ${validadeDepois}`);

    // A empresa também vê tudo pelo app (rota autenticada pela licença).
    const validacao = await fetch(`${CLOUD_URL}/api/license/validate`, {
      headers: { 'X-Kivo-Company': companyUuid, 'X-Kivo-License-Key': chave!, 'X-Kivo-Machine-Id': 'teste-pagamento' },
    });
    const corpoValidacao = (await validacao.json()) as { validUntil?: string };
    check('o app enxerga a licença pela mesma empresa do pagamento',
      validacao.status === 200 && String(corpoValidacao.validUntil ?? '').startsWith(VALIDADE_ESPERADA.slice(0, 7)),
      `${validacao.status} ${JSON.stringify(corpoValidacao).slice(0, 120)}`);
  } finally {
    cloudProc.kill();
    await stub.close();
    await limparBancoDoTeste(companyUuid);
  }

  console.log(failures === 0 ? '\nPagamento (Mercado Pago): TODOS OS TESTES PASSARAM' : `\n${failures} falha(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
