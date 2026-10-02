/**
 * Teste do contrato do cliente — o caminho comercial inteiro pelo painel.
 *
 * Sobe o Kivo Cloud (MySQL do docker-compose) e um Mercado Pago de mentira, e percorre:
 * cria a empresa → cria o contrato de 12 meses com PDF anexado → confere o bloco de parcelas
 * gerado (vencimentos, valores, numeração) → o cliente paga a primeira parcela por Pix →
 * a licença é estendida e o contrato passa a mostrar 1/12 → cancela o contrato (as parcelas
 * em aberto caem, a paga fica) → o contrato com parcela paga não pode ser apagado.
 *
 * Pré-requisitos iguais aos demais testes de nuvem: docker compose + cloud:migrate.
 */
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import http from 'node:http';
import path from 'node:path';

const ROOT = process.cwd();
const TSX = require.resolve('tsx/cli');
const requireCloud = createRequire(path.join(ROOT, 'src', 'tests', 'contracts.ts'));
const CLOUD_ENV = {
  CLOUD_DB_HOST: '127.0.0.1',
  CLOUD_DB_PORT: '3307',
  CLOUD_DB_USER: 'root',
  CLOUD_DB_PASSWORD: 'kivo',
  CLOUD_DB_NAME: 'kivo_cloud',
};

const MP_PORT = 4261;
const CLOUD_PORT = 4262;
const MP_URL = `http://127.0.0.1:${MP_PORT}`;
const CLOUD_URL = `http://127.0.0.1:${CLOUD_PORT}`;
const ADMIN_USER = 'admincontrato';
const ADMIN_PASS = 'senhaContrato123';

/** Primeiro vencimento em 31/01: a 2ª parcela TEM de cair em 28/02 (mês de 28 dias). */
const PRIMEIRO_VENCIMENTO = '2026-01-31';
const MESES = 12;
const VALOR_MENSAL = 19990;
const DIAS_POR_PARCELA = 30;
const PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Count 0/Kids[]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
  'latin1',
);

let failures = 0;
function check(label: string, ok: boolean, extra = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures++;
}

// ───────────────────────── Mercado Pago de mentira ─────────────────────────
function subirMercadoPagoFalso(): Promise<{ aprovar(): void; close(): Promise<void> }> {
  let status = 'pending';
  const server = http.createServer((req, res) => {
    // O gateway falso responde sempre o mesmo pagamento: o corpo da requisição é descartado.
    req.on('data', () => { /* descarta */ });
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'POST' && req.url === '/v1/payments') {
        res.end(JSON.stringify({
          id: 7001, status: 'pending', status_detail: 'pending_waiting_transfer',
          point_of_interaction: { transaction_data: { qr_code: 'PIX-DO-CONTRATO', qr_code_base64: 'aGVsbG8=' } },
        }));
        return;
      }
      if (req.method === 'GET' && req.url?.startsWith('/v1/payments/7001')) {
        res.end(JSON.stringify({ id: 7001, status, status_detail: status === 'approved' ? 'accredited' : 'pending_waiting_transfer' }));
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

async function esperar(url: string, tentativas = 40): Promise<boolean> {
  for (let i = 0; i < tentativas; i++) {
    try {
      if ((await fetch(url)).ok) return true;
    } catch {
      // ainda subindo
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
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

/** A tabela de parcelas do detalhe do contrato vem no HTML (renderizada no servidor). */
function linhasDoContrato(html: string): { parcela: string; vencimento: string; valor: string; status: string }[] {
  const out: { parcela: string; vencimento: string; valor: string; status: string }[] = [];
  const re = /<td class="contrato-num">(\d+)\/(\d+)<\/td>\s*<td>([\d/]+)<\/td>\s*<td class="text-right tabular">R\$ ([\d.,]+)<\/td>\s*<td><span class="badge (\w+)"/g;
  for (const m of html.matchAll(re)) {
    out.push({ parcela: `${m[1]}/${m[2]}`, vencimento: m[3], valor: m[4], status: m[5] });
  }
  return out;
}

async function main(): Promise<void> {
  const mp = await subirMercadoPagoFalso();
  console.log(`[setup] Mercado Pago de mentira em ${MP_URL}`);

  execFileSync(process.execPath, [TSX, 'cloud/src/provision-admin.ts', ADMIN_USER, ADMIN_PASS], {
    cwd: ROOT, env: { ...process.env, ...CLOUD_ENV }, stdio: 'pipe',
  });

  const cloudProc: ChildProcess = spawn(process.execPath, [TSX, 'cloud/src/server.ts'], {
    cwd: ROOT,
    env: { ...process.env, ...CLOUD_ENV, CLOUD_PORT: String(CLOUD_PORT), MP_API_BASE: MP_URL, CLOUD_PUBLIC_URL: CLOUD_URL },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  cloudProc.stdout?.on('data', (d) => { if (process.env.DEBUG_CONTRATO) process.stdout.write(`[cloud] ${d}`); });
  cloudProc.stderr?.on('data', (d) => process.stderr.write(`[cloud:err] ${d}`));

  const mysql = requireCloud(path.join(ROOT, 'cloud', 'node_modules', 'mysql2', 'promise')) as {
    createConnection(o: Record<string, unknown>): Promise<{
      query(sql: string, params?: unknown[]): Promise<[Record<string, unknown>[], unknown]>;
      end(): Promise<void>;
    }>;
  };
  const conn = await mysql.createConnection({
    host: CLOUD_ENV.CLOUD_DB_HOST, port: Number(CLOUD_ENV.CLOUD_DB_PORT),
    user: CLOUD_ENV.CLOUD_DB_USER, password: CLOUD_ENV.CLOUD_DB_PASSWORD, database: CLOUD_ENV.CLOUD_DB_NAME,
    // Igual ao pool do cloud: DATETIME/DATE como string "YYYY-MM-DD...", não como Date —
    // senão o teste compara "Sat Jan 31" com "2026-01-31".
    dateStrings: true,
  });

  let companyUuid: string | null = null;
  try {
    check('cloud no ar', await esperar(`${CLOUD_URL}/api/health`));

    const login = await form('/admin/login', { username: ADMIN_USER, password: ADMIN_PASS });
    const cookie = (login.headers.get('set-cookie') ?? '').match(/kivo_admin_session=([^;]+)/)?.[1];
    check('login no painel', login.status === 302 && !!cookie, String(login.status));
    const admin = `kivo_admin_session=${cookie}`;

    // Gateway ligado: a parcela do contrato precisa poder virar Pix.
    await form('/admin/payments', {
      enabled: '1', accessToken: 'TEST-contrato', webhookSecret: 'segredo-contrato', payerEmail: 'financeiro@kivo.test',
    }, admin);

    // ── Empresa ────────────────────────────────────────────────────────────
    const criada = await form('/admin/companies', {
      name: 'Clinica do Contrato', plan: 'diamante', modules: 'commercial,finance', validUntil: '2027-01-01',
    }, admin);
    companyUuid = (await criada.text()).match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/)?.[1] ?? null;
    check('empresa criada', !!companyUuid, String(companyUuid));

    // ── Contrato de 12 meses, com PDF, gerando o bloco ─────────────────────
    const contrato = await api('/admin/contracts', {
      method: 'POST',
      body: JSON.stringify({
        companyUuid, title: 'Assinatura Kivo — teste', months: MESES, monthlyAmount: '199,90',
        firstDueDate: PRIMEIRO_VENCIMENTO, extendsDays: DIAS_POR_PARCELA,
        payerEmail: 'cliente@contrato.test', signedOn: '2026-01-15', notes: 'combinado no teste',
        documentName: 'contrato-assinado.pdf', documentBase64: PDF.toString('base64'),
      }),
    }, admin);
    const destino = decodeURIComponent(contrato.headers.get('location') ?? '');
    check('contrato criado pelo painel', contrato.status === 302 && /ok=/.test(destino), `${contrato.status} ${destino.slice(0, 120)}`);
    const numero = destino.match(/KIVO-\d{4}-\d{4}/)?.[0] ?? '';
    check('número gerado no padrão KIVO-<ano>-<seq>', /^KIVO-\d{4}-\d{4}$/.test(numero), numero);

    const [contratos] = await conn.query('SELECT * FROM contracts WHERE company_uuid = ?', [companyUuid]);
    const linha = contratos[0] as Record<string, unknown>;
    check('contrato gravado com prazo e valor', Number(linha?.months) === MESES && Number(linha?.monthly_amount_cents) === VALOR_MENSAL,
      JSON.stringify({ months: linha?.months, valor: linha?.monthly_amount_cents }));
    check('PDF do contrato gravado', String(linha?.document_file ?? '').endsWith('.pdf') && Number(linha?.document_bytes) === PDF.length,
      `${linha?.document_name} (${linha?.document_bytes} bytes)`);

    const [parcelas] = await conn.query(
      'SELECT installment_number, due_date, amount_cents, extends_days, public_token, status FROM charges WHERE contract_id = ? ORDER BY installment_number',
      [linha.id],
    );
    check('bloco com 12 parcelas gerado', parcelas.length === MESES, `${parcelas.length} parcela(s)`);
    check('todas com valor mensal e dias de licença',
      parcelas.every((p) => Number(p.amount_cents) === VALOR_MENSAL && Number(p.extends_days) === DIAS_POR_PARCELA));
    check('numeração das parcelas de 1 a 12',
      parcelas.map((p) => Number(p.installment_number)).join(',') === Array.from({ length: MESES }, (_, i) => i + 1).join(','));
    const datas = parcelas.map((p) => String(p.due_date).slice(0, 10));
    check('1ª parcela no primeiro vencimento', datas[0] === PRIMEIRO_VENCIMENTO, datas[0]);
    check('31/01 vira 28/02 na parcela seguinte (dia 31 em mês curto)', datas[1] === '2026-02-28', datas[1]);
    check('última parcela 12 meses depois', datas[11] === '2026-12-31', datas[11]);
    check('cada parcela nasce com link público próprio', parcelas.every((p) => !!p.public_token));

    // ── Telas do painel ────────────────────────────────────────────────────
    const listaContratos = await (await api('/admin/contracts', {}, admin)).text();
    check('lista de contratos mostra o número e o progresso',
      listaContratos.includes(numero) && listaContratos.includes('0/12 pagas'));
    const detalhe = await (await api(`/admin/contracts/${linha.id}`, {}, admin)).text();
    const linhas = linhasDoContrato(detalhe);
    check('detalhe do contrato lista as 12 parcelas', linhas.length === MESES, `${linhas.length} linha(s)`);
    check('detalhe mostra a 1ª parcela em 31/01/2026', linhas[0]?.vencimento === '31/01/2026', String(linhas[0]?.vencimento));
    check('detalhe mostra a 2ª parcela em 28/02/2026', linhas[1]?.vencimento === '28/02/2026', String(linhas[1]?.vencimento));

    const pdf = await api(`/admin/contracts/${linha.id}/document`, {}, admin);
    const bytes = Buffer.from(await pdf.arrayBuffer());
    check('PDF do contrato pode ser baixado', pdf.status === 200 && bytes.subarray(0, 5).toString('latin1') === '%PDF-',
      `${pdf.status} ${bytes.length} bytes`);

    const paginaEmpresa = await (await api(`/admin/companies/${companyUuid}`, {}, admin)).text();
    check('aba Contratos da empresa mostra o contrato', paginaEmpresa.includes(numero) && paginaEmpresa.includes('Novo contrato'));

    // ── Pagar a primeira parcela (Pix) e conferir a licença ────────────────
    const primeira = parcelas[0] as Record<string, unknown>;
    const pix = await form(`/pagar/${primeira.public_token}/gateway`, { method: 'pix' });
    check('parcela vira Pix pela página pública', pix.status === 302, String(pix.status));
    mp.aprovar();
    const status = await (await fetch(`${CLOUD_URL}/pagar/${primeira.public_token}/status`)).json() as { status: string };
    check('pagamento da parcela confirmado', status.status === 'paga', JSON.stringify(status));

    const [empresa] = await conn.query('SELECT valid_until FROM companies WHERE company_uuid = ?', [companyUuid]);
    check('licença estendida em 30 dias pela parcela paga',
      String(empresa[0]?.valid_until ?? '').startsWith('2027-01-31'), String(empresa[0]?.valid_until));

    const depoisDePagar = await (await api(`/admin/contracts/${linha.id}`, {}, admin)).text();
    check('contrato passa a mostrar 1/12 pagas', depoisDePagar.includes('1/12 pagas'));
    check('parcela paga aparece como paga no bloco', linhasDoContrato(depoisDePagar)[0]?.status === 'paga');

    // ── Gerar de novo não duplica ──────────────────────────────────────────
    const denovo = await form(`/admin/contracts/${linha.id}/charges`, {}, admin);
    check('gerar parcelas de novo não duplica o bloco',
      decodeURIComponent(denovo.headers.get('location') ?? '').includes('completo'), decodeURIComponent(denovo.headers.get('location') ?? '').slice(0, 120));

    // ── Cancelar: cai o que está aberto, fica o que foi pago ───────────────
    const cancelou = await form(`/admin/contracts/${linha.id}/cancel`, {}, admin);
    check('cancelamento responde com aviso', cancelou.status === 302, String(cancelou.status));
    const [depoisDeCancelar] = await conn.query(
      "SELECT status, COUNT(*) AS t FROM charges WHERE contract_id = ? GROUP BY status ORDER BY status",
      [linha.id],
    );
    const porStatus = Object.fromEntries(depoisDeCancelar.map((r) => [String(r.status), Number(r.t)]));
    check('parcela paga continua paga', porStatus.paga === 1, JSON.stringify(porStatus));
    check('as outras 11 foram canceladas', porStatus.cancelada === MESES - 1, JSON.stringify(porStatus));
    const [contratoCancelado] = await conn.query('SELECT status FROM contracts WHERE id = ?', [linha.id]);
    check('contrato marcado como cancelado', contratoCancelado[0]?.status === 'cancelado');

    // ── Contrato com parcela paga não pode ser apagado ─────────────────────
    const apagar = await form(`/admin/contracts/${linha.id}/delete`, {}, admin);
    const avisoApagar = decodeURIComponent(apagar.headers.get('location') ?? '');
    check('apagar contrato com parcela paga é recusado', /error=/.test(avisoApagar), avisoApagar.slice(0, 140));
    const [aindaExiste] = await conn.query('SELECT COUNT(*) AS t FROM contracts WHERE id = ?', [linha.id]);
    check('contrato continua no banco', Number(aindaExiste[0]?.t) === 1);
  } finally {
    try {
      if (companyUuid) {
        for (const t of ['charges', 'contracts', 'company_devices', 'sync_records', 'cloud_backups', 'ai_usage', 'catalog_images', 'menu_items']) {
          await conn.query(`DELETE FROM ${t} WHERE company_uuid = ?`, [companyUuid]);
        }
        // Os PDFs ficam em storage/contracts: some junto com o contrato do teste.
        await conn.query('DELETE FROM companies WHERE company_uuid = ?', [companyUuid]);
      }
      await conn.query("DELETE FROM app_settings WHERE setting_key IN ('mp_enabled','mp_access_token','mp_webhook_secret','mp_payer_email')");
      await conn.end();
    } catch (e) {
      console.error('[limpeza] ' + (e as Error).message);
    }
    cloudProc.kill();
    await mp.close();
  }

  console.log(failures === 0 ? '\nContratos: TODOS OS TESTES PASSARAM' : `\n${failures} falha(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
