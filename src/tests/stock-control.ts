/**
 * Chave geral do controle de quantidade (Configurações › Estoque).
 *
 * O que protege: desligar a chave tem de parar baixa/entrada de saldo e os alertas
 * SEM apagar o `track_stock` de cada produto. Religar devolve o comportamento anterior.
 *
 * KIVO_DB_PATH TEM que vir do ambiente — rode com
 *   node scripts/test-isolated.js src/tests/stock-control.ts
 */
import { migrateUp } from '../core/database/migrator';
import { runSeeds } from '../core/database/seeds';
import { getSqlite } from '../core/database/connection';
import { createServer } from '../core/server';
import { resetTestDb, activateTestLicense } from './resetTestDb';
import { unwrap } from './testUtils';

const PORT = Number(process.env.KIVO_PORT ?? 3879);
const base = `http://localhost:${PORT}`;

let failures = 0;

function check(label: string, ok: boolean, extra = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures++;
}

async function api(path: string, opts: RequestInit = {}, cookie?: string) {
  return fetch(`${base}${path}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}), ...(opts.headers ?? {}) },
  });
}

async function loginAs(u: string, p: string): Promise<string | null> {
  const r = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: u, password: p }) });
  if (!r.ok) return null;
  const m = (r.headers.get('set-cookie') ?? '').match(/kivo_session=([^;]+)/);
  return m ? `kivo_session=${m[1]}` : null;
}

async function setChave(cookie: string, value: '0' | '1') {
  return api(
    '/api/settings/estoque.controlar_quantidade',
    { method: 'PUT', body: JSON.stringify({ value }) },
    cookie,
  );
}

async function paginaProdutos(cookie: string): Promise<string> {
  const r = await api('/app/commercial/produtos', {}, cookie);
  return r.text();
}

async function main(): Promise<void> {
  resetTestDb();
  migrateUp();
  runSeeds();
  activateTestLicense();
  const { app } = await createServer();
  const server = app.listen(PORT);
  const db = getSqlite();

  try {
    const admin = await loginAs('admin', 'admin');
    check('login admin', !!admin);

    const seeded = db
      .prepare("SELECT value FROM settings WHERE key = 'estoque.controlar_quantidade'")
      .get() as { value: string } | undefined;
    check('chave geral nasce ligada', seeded?.value === '1', seeded?.value);

    // Padrões pedidos pelo dono, cobertos aqui para a próxima mudança de seed não
    // desfazer sem ninguém perceber.
    const lan = db.prepare("SELECT value FROM settings WHERE key = 'rede.acesso_local'").get() as
      | { value: string }
      | undefined;
    check('acesso pela rede local nasce ligado', lan?.value === '1', lan?.value);
    const sync = db.prepare("SELECT value FROM settings WHERE key = 'sync.intervalo_minutos'").get() as
      | { value: string }
      | undefined;
    check('sincronização nasce a cada 3 minutos', sync?.value === '3', sync?.value);

    const created = await api(
      '/api/commercial/products',
      { method: 'POST', body: JSON.stringify({ name: 'Produto teste estoque', priceCents: 1000, trackStock: true }) },
      admin!,
    );
    const product = await unwrap<{ id: number }>(created);
    check('produto criado controlando estoque', created.status === 201 && product.id > 0, String(created.status));

    const entrada = await api(
      '/api/commercial/stock/move',
      { method: 'POST', body: JSON.stringify({ productId: product.id, type: 'entrada', qty: 5 }) },
      admin!,
    );
    check('entrada com a chave ligada', entrada.status === 200, String(entrada.status));
    const saldo = (n: number) =>
      (db.prepare('SELECT stock_qty FROM products WHERE id = ?').get(n) as { stock_qty: number }).stock_qty;
    check('saldo entrou', saldo(product.id) === 5, String(saldo(product.id)));

    // ── Desliga a chave geral ─────────────────────────────────────────────
    check('desliga a chave', (await setChave(admin!, '0')).status === 200);

    const htmlOff = await paginaProdutos(admin!);
    check('página marca KIVO_ESTOQUE_ATIVO=false', /KIVO_ESTOQUE_ATIVO\s*=\s*false/.test(htmlOff));

    const blocked = await api(
      '/api/commercial/stock/move',
      { method: 'POST', body: JSON.stringify({ productId: product.id, type: 'entrada', qty: 1 }) },
      admin!,
    );
    const blockedBody = await blocked.text();
    check('ajuste manual recusado com a chave desligada', blocked.status === 400 && blockedBody.includes('desativado'), blockedBody.slice(0, 100));
    check('saldo não mudou com a chave desligada', saldo(product.id) === 5, String(saldo(product.id)));

    const overview = await unwrap<{ rows: unknown[] }>(await api('/api/overview/stock?filter=all', {}, admin!));
    check('relatório de estoque vazio com a chave desligada', Array.isArray(overview.rows) && overview.rows.length === 0, String(overview.rows?.length));

    const kept = db.prepare('SELECT track_stock FROM products WHERE id = ?').get(product.id) as { track_stock: number };
    check('cadastro do produto preserva track_stock', kept.track_stock === 1, String(kept.track_stock));

    // ── Religa a chave geral ──────────────────────────────────────────────
    check('religa a chave', (await setChave(admin!, '1')).status === 200);

    const htmlOn = await paginaProdutos(admin!);
    check('página marca KIVO_ESTOQUE_ATIVO=true', /KIVO_ESTOQUE_ATIVO\s*=\s*true/.test(htmlOn));

    const entrada2 = await api(
      '/api/commercial/stock/move',
      { method: 'POST', body: JSON.stringify({ productId: product.id, type: 'entrada', qty: 1 }) },
      admin!,
    );
    check('entrada volta a funcionar', entrada2.status === 200, String(entrada2.status));
    check('saldo voltou a movimentar', saldo(product.id) === 6, String(saldo(product.id)));
  } finally {
    server.close();
  }

  console.log(failures === 0 ? '\nChave geral de estoque: TODOS OS TESTES PASSARAM' : `\n${failures} FALHA(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
