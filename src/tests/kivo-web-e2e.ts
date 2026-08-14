/**
 * Kivo Web de ponta a ponta: desktop ↔ nuvem ↔ celular, com MySQL de verdade.
 *
 * O `kivo-web.ts` cobre o miolo local (aplicar o comando, personificar, hashear o token). Aqui
 * o que se prova é o caminho inteiro, que nenhum teste unitário alcança:
 *
 *   1. o desktop concede o acesso e a nuvem aceita (só no plano Diamante);
 *   2. o link do QR autentica o celular e some da URL;
 *   3. o painel lê `sync_records` — inclusive o saldo de estoque refeito pelo ledger;
 *   4. o orçamento pedido no celular vira comando, o desktop aplica e o celular vê o número.
 *
 * Exige a nuvem no ar (mesmo pré-requisito de fase6a):
 *   docker compose -f cloud/docker-compose.yml up -d && CLOUD_DB_PORT=3307 npm run kivo cloud:migrate
 *   node scripts/kivo test:kivo-web-e2e
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';

let failures = 0;
function check(label: string, ok: boolean, extra = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures++;
}

const ROOT = process.cwd();
const TSX = require.resolve('tsx/cli');
const CLOUD_PORT = 4123;
const DESK_PORT = 3798;
const CLOUD = `http://127.0.0.1:${CLOUD_PORT}`;
const DESK = `http://127.0.0.1:${DESK_PORT}`;
const SCRATCH = path.resolve(ROOT, 'storage', 'temp', 'kivo-web-e2e');
// CLOUD_DB_NAME sai do ambiente quando informado: é assim que se roda este mesmo teste
// contra um banco com o collation da VPS (utf8mb4_general_ci), diferente do default do
// servidor MySQL — a divergência que derrubou a migration 0019 no primeiro deploy.
const CLOUD_ENV = {
  CLOUD_DB_HOST: '127.0.0.1', CLOUD_DB_PORT: '3307', CLOUD_DB_USER: 'root',
  CLOUD_DB_PASSWORD: 'kivo', CLOUD_DB_NAME: process.env.CLOUD_DB_NAME ?? 'kivo_cloud',
  CLOUD_PORT: String(CLOUD_PORT),
};

function spawnProc(nome: string, script: string, env: Record<string, string>): ChildProcess {
  const proc = spawn(process.execPath, [TSX, script], {
    cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout?.on('data', (d) => { if (process.env.DEBUG_E2E) process.stdout.write(`[${nome}] ${d}`); });
  proc.stderr?.on('data', (d) => process.stderr.write(`[${nome}:err] ${d}`));
  return proc;
}

function waitForHealth(url: string, timeoutMs = 30000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tryOnce = () => fetch(url).then((r) => (r.ok ? resolve() : retry())).catch(retry);
    const retry = () => {
      if (Date.now() - start > timeoutMs) { reject(new Error(`Timeout aguardando ${url}`)); return; }
      setTimeout(tryOnce, 400);
    };
    tryOnce();
  });
}

/** Espera uma condição virar verdadeira — o comando é aplicado de forma assíncrona. */
async function eventually<T>(fn: () => Promise<T | null>, timeoutMs = 25000): Promise<T | null> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) return null;
    await new Promise((r) => setTimeout(r, 500));
  }
}

async function main(): Promise<void> {
  fs.rmSync(SCRATCH, { recursive: true, force: true });
  fs.mkdirSync(SCRATCH, { recursive: true });
  const dbPath = path.join(SCRATCH, 'loja.db');

  const companyUuid = randomUUID();
  const licenseKey = randomUUID();

  let cloudProc: ChildProcess | null = null;
  let deskProc: ChildProcess | null = null;
  try {
    // ── Nuvem: empresa Diamante ──────────────────────────────────────────────
    execFileSync(process.execPath, [TSX, 'cloud/src/provision-company.ts', companyUuid, licenseKey,
      'Loja E2E', '--plan', 'diamante', '--valid-until', '2099-12-31'], { cwd: ROOT, env: { ...process.env, ...CLOUD_ENV }, stdio: 'pipe' });
    cloudProc = spawnProc('cloud', 'cloud/src/server.ts', CLOUD_ENV);
    await waitForHealth(`${CLOUD}/api/health`);
    check('nuvem no ar', true);

    // ── Desktop: banco próprio, apontando para a nuvem local ──────────────────
    const deskEnv = {
      KIVO_DB_PATH: dbPath, KIVO_PORT: String(DESK_PORT),
      KIVO_SYNC_SERVER_URL: CLOUD, KIVO_MACHINE_ID: 'e2e-machine',
    };
    deskProc = spawnProc('desktop', 'src/dev.ts', deskEnv);
    await waitForHealth(`${DESK}/api/health`);

    // Ativa informando SÓ a chave: o UUID é descoberto pela nuvem (POST /api/license/resolve).
    // De quebra, este passo é a prova de ponta a ponta da ativação simplificada.
    const ativa = await fetch(`${DESK}/api/activation/activate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ licenseKey }),
    });
    check('ativa com a chave apenas — nuvem resolve o UUID da empresa', ativa.ok,
      ativa.ok ? '' : await ativa.text());

    const login = await fetch(`${DESK}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin' }),
    });
    const cookie = (login.headers.get('set-cookie') ?? '').match(/kivo_session=[^;]+/)?.[0] ?? '';
    check('login no desktop', !!cookie);

    const dk = (p: string, init: RequestInit = {}) =>
      fetch(`${DESK}${p}`, { ...init, headers: { 'Content-Type': 'application/json', cookie, ...(init.headers ?? {}) } });

    // Catálogo: 12 de entrada e 2 de saída deixam saldo 10 — o painel tem de chegar nesse
    // número somando o ledger, porque `products.stock_qty` não viaja no sync.
    const prod = (await (await dk('/api/commercial/products', {
      method: 'POST',
      body: JSON.stringify({ name: 'Mesa de Centro', priceCents: 15000, initialStock: 12 }),
    })).json()) as { data?: { id: number }; id?: number };
    const prodId = (prod.data ?? prod).id!;
    await dk('/api/commercial/stock/move', {
      method: 'POST', body: JSON.stringify({ productId: prodId, type: 'saida', qty: 2, reason: 'e2e' }),
    });

    // Sincroniza o catálogo para a nuvem: é dele que o painel do celular vive.
    const sync = await dk('/api/sync/run', { method: 'POST' });
    check('sync manual enviou o catálogo', sync.ok, String(sync.status));

    // ── Concessão do acesso ───────────────────────────────────────────────────
    const users = (await (await dk('/api/users')).json()) as { data?: { username: string; id: number }[] } | { username: string; id: number }[];
    const lista = Array.isArray(users) ? users : (users.data ?? []);
    const adminId = lista.find((u) => u.username === 'admin')!.id;
    const grantRes = await dk(`/api/remote/users/${adminId}/grant`, { method: 'POST' });
    const grant = (await grantRes.json()) as { data?: { url: string; qr: string } } & { url?: string; qr?: string };
    const grantData = (grant.data ?? grant) as { url: string; qr: string };
    check('desktop concede acesso pelo celular', grantRes.status === 201, JSON.stringify(grantData).slice(0, 120));
    check('devolve QR pronto para exibir', String(grantData.qr ?? '').startsWith('data:image/png'));
    const token = String(grantData.url ?? '').split('/m/acesso/')[1] ?? '';
    check('link tem o formato /m/acesso/<token>', token.length === 64, grantData.url);

    // ── Celular: pareia pelo link ─────────────────────────────────────────────
    const pair = await fetch(`${CLOUD}/m/acesso/${token}`, { redirect: 'manual' });
    check('link do QR redireciona (tirando o token da URL)', pair.status === 302 && pair.headers.get('location') === '/m',
      `${pair.status} ${pair.headers.get('location')}`);
    const mCookie = (pair.headers.get('set-cookie') ?? '').match(/kivo_m=[^;]+/)?.[0] ?? '';
    check('sessão do celular criada em cookie httpOnly',
      !!mCookie && (pair.headers.get('set-cookie') ?? '').includes('HttpOnly'));

    const cel = (p: string, init: RequestInit = {}) =>
      fetch(`${CLOUD}${p}`, { ...init, headers: { 'Content-Type': 'application/json', cookie: mCookie, ...(init.headers ?? {}) } });

    const inicio = await cel('/m');
    const htmlInicio = await inicio.text();
    check('painel abre autenticado', inicio.status === 200 && htmlInicio.includes('Vendas de hoje'));
    check('painel mostra a empresa', htmlInicio.includes('Loja E2E'));

    const semCookie = await fetch(`${CLOUD}/m`, { redirect: 'manual' });
    check('sem sessão, painel manda para a tela de entrada',
      semCookie.status === 302 && semCookie.headers.get('location') === '/m/entrar');

    // ── Estoque: saldo refeito pelo ledger (products.stock_qty não viaja) ─────
    const estoque = await (await cel('/m/estoque')).text();
    check('estoque lista o produto sincronizado', estoque.includes('Mesa de Centro'));
    // 12 entradas − 2 saídas: prova que o replay do ledger roda, e não um SUM cru.
    check('saldo refeito pelo ledger bate com o desktop', /\b10\b/.test(estoque), 'esperado 10');

    // ── Orçamento pelo celular ────────────────────────────────────────────────
    // O uuid sai da PRÓPRIA tela de novo orçamento, que é de onde o celular o tira de verdade
    // (`sync_records`). Pegá-lo da API do desktop não serviria: `GET /products` nem devolve
    // `uuid` — e é justamente por o `id` ser local a cada máquina que o comando viaja por uuid.
    const telaNovo = await (await cel('/m/orcamentos/novo')).text();
    check('tela de novo orçamento abre com o catálogo', telaNovo.includes('Mesa de Centro'));
    const listaProdutos = JSON.parse(
      /var PRODUTOS = (\[.*?\]);/s.exec(telaNovo)?.[1] ?? '[]',
    ) as { uuid: string; name: string }[];
    const uuidProduto = listaProdutos.find((p) => p.name === 'Mesa de Centro')?.uuid ?? '';
    check('produto do catálogo chega ao celular com uuid', uuidProduto.length > 30, uuidProduto);
    const enfileira = await cel('/api/mobile/commands', {
      method: 'POST',
      body: JSON.stringify({
        kind: 'store.quote.create',
        payload: { items: [{ productUuid: uuidProduto, qty: 3 }], customerName: 'Cliente do Celular', notes: 'via e2e' },
      }),
    });
    const cmd = (await enfileira.json()) as { id: number; desktopOnline: boolean; error?: string };
    check('celular enfileira o orçamento', enfileira.status === 202, JSON.stringify(cmd).slice(0, 120));
    check('nuvem informa se o desktop está escutando (SSE)', typeof cmd.desktopOnline === 'boolean',
      `desktopOnline=${cmd.desktopOnline}`);

    const aplicado = await eventually(async () => {
      const st = (await (await cel(`/api/mobile/commands/${cmd.id}`)).json()) as
        { status: string; result: { quoteId?: number; error?: string } };
      return st.status === 'pendente' ? null : st;
    }, 45000);
    check('desktop aplicou o comando sem ninguém clicar em nada', aplicado?.status === 'aplicado',
      aplicado ? JSON.stringify(aplicado.result) : 'timeout');

    if (aplicado?.status === 'aplicado') {
      const quoteId = aplicado.result.quoteId!;
      const quote = (await (await dk(`/api/store/quotes/${quoteId}`)).json()) as
        { data?: Record<string, unknown> } & Record<string, unknown>;
      const q = (quote.data ?? quote) as { id: number; total_cents: number; customer_name: string | null };
      check('orçamento existe no desktop', !!q && q.id === quoteId);
      // 3 × R$150,00 resolvido no desktop — o celular mandou só produto e quantidade.
      check('preço foi resolvido pelo desktop, não pelo celular', q.total_cents === 45000, String(q.total_cents));
      check('nome livre do cliente preservado', q.customer_name === 'Cliente do Celular', String(q.customer_name));
    }

    // ── Revogação derruba o celular na requisição seguinte ────────────────────
    const rev = await dk(`/api/remote/users/${adminId}/grant`, { method: 'DELETE' });
    check('desktop revoga o acesso', rev.ok);
    const depois = await fetch(`${CLOUD}/m`, { headers: { cookie: mCookie }, redirect: 'manual' });
    check('celular cai para o login imediatamente após revogar',
      depois.status === 302 && depois.headers.get('location') === '/m/entrar', String(depois.status));
  } finally {
    deskProc?.kill();
    cloudProc?.kill();
  }

  console.log(failures === 0 ? '\nKivo Web (e2e): TODOS OS TESTES PASSARAM' : `\n${failures} falha(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
