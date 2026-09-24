/**
 * KIVO IA — ponte do Kivo Web para o Ollama, medição de uso e créditos.
 *
 * Sobe um Ollama SIMULADO (HTTP local), provisiona uma empresa + admin e sobe o cloud
 * apontando `OLLAMA_URL` para o mock. Valida: autenticação, encaminhamento da resposta,
 * contagem de tokens, teto de créditos (402), e o painel /admin/ai.
 *
 * Pré-requisitos (mesmos da fase 6d): MySQL do cloud no ar (docker compose).
 *   node scripts/test-isolated.js src/tests/ai-cloud.ts
 */
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';

const ROOT = process.cwd();
const TSX = require.resolve('tsx/cli');
const SCRATCH = path.resolve(ROOT, 'storage', 'temp', 'ai-cloud');
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
    const tryOnce = () => fetch(url).then((r) => (r.ok ? resolve() : retry())).catch(retry);
    const retry = () => {
      if (Date.now() - start > timeoutMs) { reject(new Error(`Timeout ${url}`)); return; }
      setTimeout(tryOnce, 300);
    };
    tryOnce();
  });
}

function spawnProc(name: string, script: string, env: Record<string, string>): ChildProcess {
  const proc = spawn(process.execPath, [TSX, script], { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stderr.on('data', (d) => process.stderr.write(`[${name}:err] ${d}`));
  return proc;
}

/** Ollama simulado: /api/tags e /api/chat (com contagem de tokens). */
function startMockOllama(): Promise<{ server: http.Server; url: string }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url === '/api/tags') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ models: [{ name: 'mock-llama', size: 1000, details: { parameter_size: '3B' } }] }));
        return;
      }
      if (req.url === '/api/chat' && req.method === 'POST') {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
          const parsed = JSON.parse(body || '{}') as { model?: string };
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({
            model: parsed.model || 'mock-llama',
            message: { role: 'assistant', content: 'pong' },
            prompt_eval_count: 10,
            eval_count: 20,
          }));
        });
        return;
      }
      res.statusCode = 404;
      res.end('not found');
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

async function loginAdmin(base: string, user: string, pass: string): Promise<string | null> {
  const r = await fetch(`${base}/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: user, password: pass }).toString(),
    redirect: 'manual',
  });
  const m = (r.headers.get('set-cookie') ?? '').match(/kivo_admin_session=([^;]+)/);
  return m ? `kivo_admin_session=${m[1]}` : null;
}

async function main(): Promise<void> {
  if (!process.env.KIVO_DB_PATH) throw new Error('KIVO_DB_PATH não definida — rode via scripts/test-isolated.js.');
  fs.mkdirSync(SCRATCH, { recursive: true });

  const mock = await startMockOllama();
  const cloudPort = 4661;
  const cloudUrl = `http://localhost:${cloudPort}`;
  const companyUuid = randomUUID();
  const licenseKey = randomUUID();

  console.log('[setup] provisionando empresa + admin + cloud com Ollama simulado...');
  execFileSync(process.execPath, [TSX, 'cloud/src/provision-company.ts', companyUuid, licenseKey], {
    cwd: ROOT, env: { ...process.env, ...CLOUD_ENV }, stdio: 'inherit',
  });
  execFileSync(process.execPath, [TSX, 'cloud/src/provision-admin.ts', 'adminai', 'senhaSegura123'], {
    cwd: ROOT, env: { ...process.env, ...CLOUD_ENV }, stdio: 'inherit',
  });

  const cloudProc = spawnProc('cloud', 'cloud/src/server.ts', {
    ...CLOUD_ENV, CLOUD_PORT: String(cloudPort), OLLAMA_URL: mock.url, OLLAMA_MODEL: 'mock-llama',
  });
  await waitForHealth(`${cloudUrl}/api/health`);

  const headers = { 'Content-Type': 'application/json', 'X-Kivo-Company': companyUuid, 'X-Kivo-License-Key': licenseKey };

  try {
    // Sem credenciais → 401.
    const noAuth = await fetch(`${cloudUrl}/api/ai/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: 'oi' }) });
    check('IA sem credenciais → 401', noAuth.status === 401, String(noAuth.status));

    // Com credenciais → encaminha e devolve a resposta + contagem de tokens.
    const chat = await fetch(`${cloudUrl}/api/ai/chat`, { method: 'POST', headers, body: JSON.stringify({ prompt: 'ping' }) });
    const chatBody = (await chat.json().catch(() => ({}))) as { content?: string; usage?: { totalTokens?: number } };
    check('IA com credenciais → 200', chat.status === 200, String(chat.status));
    check('IA devolve a resposta do modelo', chatBody.content === 'pong', JSON.stringify(chatBody));
    check('IA contabiliza os tokens', chatBody.usage?.totalTokens === 30, JSON.stringify(chatBody.usage));

    // Status: online, modelos e consumo somado.
    const status = await fetch(`${cloudUrl}/api/ai/status`, { headers });
    const statusBody = (await status.json()) as { online?: boolean; models?: { name: string }[]; credits?: { used: number } };
    check('IA status online + modelos', statusBody.online === true && (statusBody.models ?? []).some((m) => m.name === 'mock-llama'), JSON.stringify(statusBody.models));
    check('IA status soma o consumo (30)', statusBody.credits?.used === 30, JSON.stringify(statusBody.credits));

    // Painel /admin/ai renderiza.
    const admin = await loginAdmin(cloudUrl, 'adminai', 'senhaSegura123');
    check('admin logado', !!admin);
    const dash = await fetch(`${cloudUrl}/admin/ai`, { headers: { cookie: admin! } });
    const dashHtml = await dash.text();
    check('painel KIVO IA renderiza com gráficos', dash.status === 200 && dashHtml.includes('Tokens por dia') && dashHtml.includes('Uso por empresa'), String(dash.status));

    // Define o teto em 1 token: o suporte NÃO pode ser barrado por créditos (sempre disponível).
    const setLimit = await fetch(`${cloudUrl}/admin/ai/${companyUuid}/limit`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', cookie: admin! },
      body: new URLSearchParams({ limitTokens: '1' }).toString(), redirect: 'manual',
    });
    check('teto de créditos salvo', setLimit.status === 302, String(setLimit.status));
    const stillOk = await fetch(`${cloudUrl}/api/ai/chat`, { method: 'POST', headers, body: JSON.stringify({ prompt: 'de novo' }) });
    const stillBody = (await stillOk.json().catch(() => ({}))) as { content?: string };
    check('Suporte não é bloqueado por créditos → 200', stillOk.status === 200 && stillBody.content === 'pong', `${stillOk.status}`);

    // ─── Ferramenta paga: Insights de vendas ───
    const toolsRes = await fetch(`${cloudUrl}/api/ai/tools`, { headers });
    const toolsBody = (await toolsRes.json()) as { tools?: { id: string }[] };
    check('lista de ferramentas inclui sales_insights', (toolsBody.tools ?? []).some((t) => t.id === 'sales_insights'), JSON.stringify(toolsBody.tools?.map((t) => t.id)));

    const insightPayload = {
      from: '2026-09-01', to: '2026-09-23', salesCount: 3, totalCents: 15000, ticketCents: 5000,
      topProducts: [{ name: 'Pizza', qty: 2, totalCents: 9000 }],
      byPayment: [{ method: 'Pix', totalCents: 15000 }],
      daily: [{ day: '2026-09-01', totalCents: 15000 }],
      previous: { totalCents: 12000, salesCount: 2 },
    };
    const ins1 = await fetch(`${cloudUrl}/api/ai/tools/sales-insights`, { method: 'POST', headers, body: JSON.stringify(insightPayload) });
    const ins1Body = (await ins1.json().catch(() => ({}))) as { insight?: string; status?: { used: number; limit: number } };
    check('insights → 200 com análise', ins1.status === 200 && ins1Body.insight === 'pong', `${ins1.status} ${JSON.stringify(ins1Body)}`);
    check('insights consome 1 da cota', ins1Body.status?.used === 1, JSON.stringify(ins1Body.status));

    // Sem vendas no período: não cobra crédito.
    const insEmpty = await fetch(`${cloudUrl}/api/ai/tools/sales-insights`, { method: 'POST', headers, body: JSON.stringify({ ...insightPayload, salesCount: 0 }) });
    const insEmptyBody = (await insEmpty.json().catch(() => ({}))) as { status?: { used: number } };
    check('insights sem vendas não cobra crédito', insEmpty.status === 200 && insEmptyBody.status?.used === 1, JSON.stringify(insEmptyBody.status));

    // Limita a empresa a 1/dia → a próxima chamada estoura (402).
    await fetch(`${cloudUrl}/admin/ai/${companyUuid}/quota/sales_insights`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', cookie: admin! },
      body: new URLSearchParams({ dailyLimit: '1' }).toString(), redirect: 'manual',
    });
    const insOver = await fetch(`${cloudUrl}/api/ai/tools/sales-insights`, { method: 'POST', headers, body: JSON.stringify(insightPayload) });
    const insOverBody = (await insOver.json().catch(() => ({}))) as { code?: string };
    check('insights esgotado → 402 ai_quota_exhausted', insOver.status === 402 && insOverBody.code === 'ai_quota_exhausted', `${insOver.status} ${JSON.stringify(insOverBody)}`);

    // Painel mostra o uso por ferramenta por empresa.
    const dash2 = await fetch(`${cloudUrl}/admin/ai`, { headers: { cookie: admin! } });
    const dash2Html = await dash2.text();
    check('painel mostra uso por ferramenta', dash2.status === 200 && dash2Html.includes('Uso hoje (ferramentas)') && dash2Html.includes('Insights de vendas'), String(dash2.status));
  } finally {
    cloudProc.kill();
    mock.server.close();
  }

  console.log(failures === 0 ? '\nKIVO IA (cloud): TODOS OS TESTES PASSARAM' : `\n${failures} falha(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
