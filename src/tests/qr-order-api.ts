/**
 * Teste HTTP do QR de mesa: o desktop publica o menu + registra o token no Cloud e a
 * tela reusa o mesmo QR até o lojista rotacionar/desativar. O Cloud é mockado — o teste
 * roda sem VPS/MySQL.
 *
 *   node scripts/test-isolated.js src/tests/qr-order-api.ts
 */
import path from 'node:path';
import { migrateUp } from '../core/database/migrator';
import { runSeeds } from '../core/database/seeds';
import { getSqlite, closeDb } from '../core/database/connection';
import { setLicense } from '../core/license/service';
import { createServer } from '../core/server';
import { hasService } from '../core/services/registry';
import { unwrap } from './testUtils';

const PORT = Number(process.env.KIVO_PORT ?? 3827);
const base = `http://localhost:${PORT}`;
let failures = 0;
function check(label: string, ok: boolean, extra = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures++;
}

function assertDiscardable(): void {
  const alvo = process.env.KIVO_DB_PATH;
  if (!alvo) throw new Error('KIVO_DB_PATH não definida. Rode via scripts/test-isolated.js.');
  if (path.resolve(alvo) === path.resolve(process.cwd(), 'database', 'kivo.db')) {
    throw new Error('Recusado: KIVO_DB_PATH aponta para o banco de dev.');
  }
}

let cookie = '';
async function api(p: string, opts: RequestInit = {}): Promise<Response> {
  return fetch(`${base}${p}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}), ...(opts.headers ?? {}) },
  });
}

async function main(): Promise<void> {
  assertDiscardable();
  migrateUp();
  runSeeds();
  setLicense('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'chave-qr-api', 'diamante', '2099-12-31 23:59:59');

  const db = getSqlite();
  db.prepare(
    `INSERT INTO capabilities (key, description, module, enabled, beta, uuid)
     VALUES ('comandas.pedido_qr', 'teste', 'comandas', 1, 0, 'cap-qr-api')
     ON CONFLICT(key) DO UPDATE SET enabled = 1`,
  ).run();

  process.env.KIVO_SYNC_SERVER_URL = 'https://kivo.exemplo.test';
  let publishBody: unknown = null;
  const originalFetch = global.fetch;
  (global as unknown as { fetch: typeof fetch }).fetch = (async (url: string, init?: RequestInit) => {
    const alvo = String(url);
    // Chamadas do próprio teste ao servidor local passam reto; só o Cloud é mockado.
    if (alvo.startsWith(base)) return originalFetch(url, init);
    if (alvo.includes('/api/menu/publish')) {
      publishBody = JSON.parse(String(init?.body ?? '{}'));
      return { ok: true, status: 200, json: async () => ({ ok: true }) } as Response;
    }
    if (alvo.includes('/api/menu/table-tokens')) {
      return { ok: true, status: 201, json: async () => ({ ok: true }) } as Response;
    }
    if (alvo.includes('/api/commands/pending')) {
      return { ok: true, status: 200, json: async () => ({ commands: [] }) } as Response;
    }
    // Event channel/outras chamadas do boot: devolve vazio em vez de bater na VPS.
    return { ok: true, status: 200, json: async () => ({}) } as Response;
  }) as typeof fetch;

  const { app } = await createServer();
  // O loader insere as capabilities do módulo (nascem desligadas). Num teste não há
  // ninguém clicando em Recursos, então liga o que o fluxo usa.
  db.prepare(
    "UPDATE capabilities SET enabled = 1 WHERE key IN ('comandas.mesas', 'comandas.pedido_qr')",
  ).run();
  const server = app.listen(PORT);
  try {
    check('serviço comandas.qr registrado pelo módulo', hasService('comandas.qr'));
    const login = await api('/api/auth/login', {
      method: 'POST', body: JSON.stringify({ username: 'admin', password: 'admin' }),
    });
    const m = (login.headers.get('set-cookie') ?? '').match(/kivo_session=([^;]+)/);
    cookie = m ? `kivo_session=${m[1]}` : '';
    check('login admin', cookie !== '');
    if (!cookie) return;

    const table = await unwrap<{ id: number }>(await api('/api/comandas/tables', {
      method: 'POST', body: JSON.stringify({ label: 'Mesa QR' }),
    }));
    check('mesa criada', table.id > 0);

    const generated = await api(`/api/comandas/tables/${table.id}/qr`, {
      method: 'POST', body: JSON.stringify({ rotate: false }),
    });
    const qr = await unwrap<{ url: string; qr: string }>(generated);
    check('gera QR', generated.status === 201, `status=${generated.status}`);
    check('link aponta para a página pública', /^https:\/\/kivo\.exemplo\.test\/pedido\/[a-f0-9]{64}$/.test(qr.url), qr.url);
    check('imagem do QR é PNG data URL', qr.qr.startsWith('data:image/png;base64,'));

    const row = db.prepare('SELECT qr_token FROM store_tables WHERE id = ?').get(table.id) as { qr_token: string };
    check('token fica salvo para reexibir', /^[a-f0-9]{64}$/.test(row.qr_token));
    check('menu publicado antes de gerar o QR', publishBody !== null);

    const cached = await unwrap<{ url: string }>(await api(`/api/comandas/tables/${table.id}/qr`));
    check('abrir de novo reusa o mesmo QR', cached.url === qr.url);

    const rotated = await unwrap<{ url: string }>(await api(`/api/comandas/tables/${table.id}/qr`, {
      method: 'POST', body: JSON.stringify({ rotate: true }),
    }));
    check('rotação troca o token', rotated.url !== qr.url);

    const revoked = await api(`/api/comandas/tables/${table.id}/qr`, { method: 'DELETE' });
    check('desativa o QR', revoked.ok);
    const after = db.prepare('SELECT qr_token FROM store_tables WHERE id = ?').get(table.id) as { qr_token: string | null };
    check('token local é limpo', after.qr_token === null);
  } finally {
    server.close();
    global.fetch = originalFetch;
  }

  console.log(failures === 0 ? '\nQR da mesa (HTTP): TODOS OS TESTES PASSARAM' : `\n${failures} falha(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => {
    closeDb();
  });
