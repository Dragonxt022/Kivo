/**
 * Insights de vendas (KIVO IA) de ponta a ponta: desktop → nuvem → modelo.
 *
 * Sobe um Ollama SIMULADO, uma empresa e o cloud apontando para ele, e o desktop apontando para
 * o cloud. Depois insere vendas no banco do desktop e chama `POST /api/ai/sales-insights`.
 * Prova o caminho que nenhum teste unitário alcança:
 *
 *   1. o desktop lê as vendas locais e monta o resumo;
 *   2. manda o resumo para o cloud, que injeta no prompt e chama o provedor;
 *   3. devolve a análise, registra 1 uso da cota diária e o painel reflete;
 *   4. sem vendas não cobra; esgotada a cota, responde 402.
 *
 * Exige o MySQL do cloud no ar (docker compose):
 *   docker compose -f cloud/docker-compose.yml up -d && CLOUD_DB_PORT=3307 npm run kivo cloud:migrate
 *   node scripts/test-isolated.js src/tests/ai-sales-insights-e2e.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';

const ROOT = process.cwd();
const TSX = require.resolve('tsx/cli');
const CLOUD_PORT = 4129;
const DESK_PORT = 3802;
const CLOUD = `http://127.0.0.1:${CLOUD_PORT}`;
const DESK = `http://127.0.0.1:${DESK_PORT}`;
const SCRATCH = path.resolve(ROOT, 'storage', 'temp', 'ai-insights-e2e');
const CLOUD_ENV = {
  CLOUD_DB_HOST: '127.0.0.1', CLOUD_DB_PORT: '3307', CLOUD_DB_USER: 'root',
  CLOUD_DB_PASSWORD: 'kivo', CLOUD_DB_NAME: process.env.CLOUD_DB_NAME ?? 'kivo_cloud',
  CLOUD_PORT: String(CLOUD_PORT),
};

let failures = 0;
function check(label: string, ok: boolean, extra = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures++;
}

function spawnProc(name: string, script: string, env: Record<string, string>): ChildProcess {
  const proc = spawn(process.execPath, [TSX, script], { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stderr?.on('data', (d) => process.stderr.write(`[${name}:err] ${d}`));
  return proc;
}

function waitForHealth(url: string, timeoutMs = 30000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tryOnce = () => fetch(url).then((r) => (r.ok ? resolve() : retry())).catch(retry);
    const retry = () => { if (Date.now() - start > timeoutMs) { reject(new Error(`Timeout ${url}`)); return; } setTimeout(tryOnce, 400); };
    tryOnce();
  });
}

/** Ollama simulado que guarda o último corpo recebido em /api/chat. */
function startMockOllama(): Promise<{ server: http.Server; url: string; last: () => Record<string, unknown> }> {
  let last: Record<string, unknown> = {};
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
          last = JSON.parse(body || '{}') as Record<string, unknown>;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({
            model: (last.model as string) || 'mock-llama',
            message: { role: 'assistant', content: 'INSIGHT-MOCK: destaque o prato campeão e ajuste o horário de pico.' },
            prompt_eval_count: 40,
            eval_count: 25,
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
      resolve({ server, url: `http://127.0.0.1:${port}`, last: () => last });
    });
  });
}

const ymd = (d: Date): string => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

async function main(): Promise<void> {
  fs.rmSync(SCRATCH, { recursive: true, force: true });
  fs.mkdirSync(SCRATCH, { recursive: true });
  const dbPath = path.join(SCRATCH, 'loja.db');

  const mock = await startMockOllama();
  const companyUuid = randomUUID();
  const licenseKey = randomUUID();

  let cloudProc: ChildProcess | null = null;
  let deskProc: ChildProcess | null = null;
  try {
    execFileSync(process.execPath, [TSX, 'cloud/src/provision-company.ts', companyUuid, licenseKey,
      'Loja IA', '--plan', 'diamante', '--valid-until', '2099-12-31'], { cwd: ROOT, env: { ...process.env, ...CLOUD_ENV }, stdio: 'pipe' });

    cloudProc = spawnProc('cloud', 'cloud/src/server.ts', { ...CLOUD_ENV, OLLAMA_URL: mock.url, OLLAMA_MODEL: 'mock-llama' });
    await waitForHealth(`${CLOUD}/api/health`);

    deskProc = spawnProc('desktop', 'src/dev.ts', {
      KIVO_DB_PATH: dbPath, KIVO_PORT: String(DESK_PORT),
      KIVO_SYNC_SERVER_URL: CLOUD, KIVO_MACHINE_ID: 'ai-insights-e2e',
    });
    await waitForHealth(`${DESK}/api/health`);

    const ativa = await fetch(`${DESK}/api/activation/activate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ licenseKey }),
    });
    check('ativa o desktop na nuvem', ativa.ok, ativa.ok ? '' : await ativa.text());

    const login = await fetch(`${DESK}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'admin' }),
    });
    const cookie = (login.headers.get('set-cookie') ?? '').match(/kivo_session=[^;]+/)?.[0] ?? '';
    check('login no desktop', !!cookie);

    const dk = (p: string, init: RequestInit = {}) =>
      fetch(`${DESK}${p}`, { ...init, headers: { 'Content-Type': 'application/json', cookie, ...(init.headers ?? {}) } });

    // ── Vendas no banco do desktop (conexão própria, WAL permite) ──
    const BetterSqlite = require('better-sqlite3');
    const db = new BetterSqlite(dbPath);
    const productId = Number(db.prepare(
      `INSERT INTO products (name, unit, price_cents, cost_cents, track_stock, stock_qty, min_stock, active, uuid)
       VALUES ('Pizza Calabresa', 'un', 5000, 1500, 0, 0, 0, 1, ?)`,
    ).run(randomUUID()).lastInsertRowid);
    const saleId = Number(db.prepare(
      `INSERT INTO sales (status, subtotal_cents, discount_cents, surcharge_cents, total_cents, payment_method, paid_cents, change_cents, user_id, uuid, created_at)
       VALUES ('concluida', 10000, 0, 0, 10000, 'dinheiro', 10000, 0, NULL, ?, datetime('now'))`,
    ).run(randomUUID()).lastInsertRowid);
    db.prepare(
      `INSERT INTO sale_items (sale_id, product_id, product_name, qty, unit_price_cents, total_cents, cost_cents)
       VALUES (?, ?, 'Pizza Calabresa', 2, 5000, 10000, 3000)`,
    ).run(saleId, productId);
    db.close();

    const today = ymd(new Date());
    const from = ymd(new Date(Date.now() - 30 * 86400000));
    // O servidor local embrulha as respostas em { success, data }.
    const unwrap = <T,>(b: unknown): T => ((b as { data?: unknown })?.data ?? b) as T;

    // ── 1ª análise: gera e cobra 1 uso ──
    const r1 = await dk('/api/ai/sales-insights', { method: 'POST', body: JSON.stringify({ from, to: today }) });
    const raw1 = await r1.json().catch(() => ({}));
    const b1 = unwrap<{ insight?: string; status?: { used: number; limit: number } }>(raw1);
    check('insights → 200', r1.status === 200 && (raw1 as { success?: boolean }).success === true, `${r1.status} ${JSON.stringify(raw1).slice(0, 200)}`);
    check('devolve a análise do modelo', b1.insight === 'INSIGHT-MOCK: destaque o prato campeão e ajuste o horário de pico.', JSON.stringify(b1.insight));
    check('cobra 1 uso da cota do dia', b1.status?.used === 1, JSON.stringify(b1.status));

    // O prompt enviado ao modelo tem de conter o resumo montado localmente.
    const sentPrompt = String((mock.last().messages as { content?: string }[] | undefined)?.[0]?.content ?? '');
    check('prompt inclui o período', sentPrompt.includes(from) && sentPrompt.includes(today));
    check('prompt inclui o resumo local', sentPrompt.includes('Produtos mais vendidos') && sentPrompt.includes('Pizza Calabresa') && sentPrompt.includes('Ticket médio'));

    // ── Sem vendas: não cobra ──
    const rEmpty = await dk('/api/ai/sales-insights', { method: 'POST', body: JSON.stringify({ from: '2020-01-01', to: '2020-01-31' }) });
    const bEmpty = unwrap<{ status?: { used: number } }>(await rEmpty.json().catch(() => ({})));
    check('sem vendas não cobra crédito', rEmpty.status === 200 && bEmpty.status?.used === 1, JSON.stringify(bEmpty.status));

    // ── Esgota a cota (override 1/dia) e espera 402 ──
    const cloudRequire = createRequire(path.join(ROOT, 'cloud', 'package.json'));
    const mysql = cloudRequire('mysql2/promise') as typeof import('mysql2/promise');
    const pool = mysql.createPool({ host: '127.0.0.1', port: 3307, user: 'root', password: 'kivo', database: process.env.CLOUD_DB_NAME ?? 'kivo_cloud' });
    await pool.query(
      `INSERT INTO company_ai_quotas (company_uuid, feature, daily_limit, used, period_day) VALUES (?, 'sales_insights', 1, 1, ?)
       ON DUPLICATE KEY UPDATE daily_limit = 1, used = 1, period_day = VALUES(period_day)`,
      [companyUuid, today],
    );
    const rOver = await dk('/api/ai/sales-insights', { method: 'POST', body: JSON.stringify({ from, to: today }) });
    const bOver = (await rOver.json().catch(() => ({}))) as { success?: boolean; error?: string };
    check('cota esgotada → 402 com aviso', rOver.status === 402 && bOver.success === false && /acabaram hoje/.test(bOver.error ?? ''), `${rOver.status} ${JSON.stringify(bOver)}`);
    await pool.end();
  } finally {
    deskProc?.kill();
    cloudProc?.kill();
    mock.server.close();
  }

  console.log(failures === 0 ? '\nInsights de vendas (E2E): TODOS OS TESTES PASSARAM' : `\n${failures} falha(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
