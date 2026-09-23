/**
 * Documentação técnica (/admin/documentacao) — acessível só com `dev.docs.view`.
 *
 *   node scripts/test-isolated.js src/tests/devdocs.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { migrateUp } from '../core/database/migrator';
import { runSeeds } from '../core/database/seeds';
import { createServer } from '../core/server';
import { getSqlite, closeDb } from '../core/database/connection';
import { activateTestLicense } from './resetTestDb';

const PORT = Number(process.env.KIVO_PORT ?? 3866);
const base = `http://localhost:${PORT}`;
let failures = 0;
function check(label: string, ok: boolean, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures++;
}

async function api(p: string, opts: RequestInit = {}, cookie = ''): Promise<Response> {
  return fetch(`${base}${p}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}), ...(opts.headers ?? {}) },
  });
}

async function login(u: string, p: string): Promise<string> {
  const r = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: u, password: p }) });
  const m = (r.headers.get('set-cookie') ?? '').match(/kivo_session=([^;]+)/);
  return m ? `kivo_session=${m[1]}` : '';
}

function assertBancoDescartavel(): string {
  const alvo = process.env.KIVO_DB_PATH;
  if (!alvo) throw new Error('KIVO_DB_PATH não definida — rode via scripts/test-isolated.js.');
  if (path.resolve(alvo) === path.resolve(process.cwd(), 'database', 'kivo.db')) {
    throw new Error('Recusado: KIVO_DB_PATH aponta para o banco de dev.');
  }
  return alvo;
}

async function main(): Promise<void> {
  const tmp = assertBancoDescartavel();
  fs.mkdirSync(path.dirname(tmp), { recursive: true });
  fs.rmSync(tmp, { force: true });
  migrateUp();
  runSeeds();
  activateTestLicense();
  const { app } = await createServer();
  const server = app.listen(PORT);
  const db = getSqlite();

  try {
    const admin = await login('admin', 'admin');
    check('login admin', admin !== '');

    // Permissão existe e o Administrador a recebe.
    const perm = db.prepare("SELECT key FROM permissions WHERE key = 'dev.docs.view'").get() as { key: string } | undefined;
    check('permissão dev.docs.view registrada', !!perm);
    const adminHas = db.prepare(
      `SELECT 1 FROM role_permissions rp JOIN roles r ON r.id = rp.role_id
        WHERE r.slug = 'administrador' AND rp.permission_key = 'dev.docs.view'`,
    ).get();
    check('administrador tem dev.docs.view', !!adminHas);

    // Página inicial (sem doc) abre o índice e lista o menu.
    const page = await api('/admin/documentacao', {}, admin);
    const html = await page.text();
    check('documentação responde 200', page.status === 200, `status=${page.status}`);
    check('abre o índice por padrão', html.includes('<h1>Documentação Técnica'));
    check('índice tem o diagrama de dependências', html.includes('<pre><code>') && html.includes('commercial'));
    check('menu lista o documento', html.includes('/admin/documentacao?doc=estoque'));

    // Doc de estoque renderiza o markdown (título, tabela).
    const est = await api('/admin/documentacao?doc=estoque', {}, admin);
    const estHtml = await est.text();
    check('renderiza o módulo de estoque', estHtml.includes('Módulo de Estoque'));
    check('markdown virou HTML (título h1)', estHtml.includes('<h1>Módulo de Estoque'));
    check('tabela renderizada', estHtml.includes('<table>') && estHtml.includes('stock_movements'));

    // Segundo documento (vendas) renderiza e aparece no menu.
    const vendas = await api('/admin/documentacao?doc=vendas', {}, admin);
    const vendasHtml = await vendas.text();
    check('renderiza o módulo de vendas', vendas.status === 200 && vendasHtml.includes('Módulo de Vendas / PDV'));
    check('menu lista vendas', html.includes('/admin/documentacao?doc=vendas'));

    // Todos os documentos de módulo renderizam.
    const slugs = ['estoque', 'vendas', 'financeiro', 'fiscal', 'comandas', 'foodservice', 'etiquetas', 'dre', 'painel', 'comercial', 'nfe'];
    let rendered = 0;
    for (const slug of slugs) {
      const r = await api(`/admin/documentacao?doc=${slug}`, {}, admin);
      const body = await r.text();
      if (r.status === 200 && body.includes('<h1>')) rendered++;
      else console.log(`  [doc] ${slug} falhou (status=${r.status})`);
    }
    check('todos os documentos renderizam', rendered === slugs.length, `${rendered}/${slugs.length}`);
    check('menu lista todos os documentos', slugs.every((s) => html.includes(`doc=${s}`)));

    // Slug com tentativa de path traversal é saneado: cai no documento padrão.
    const evil = await api('/admin/documentacao?doc=../../../package', {}, admin);
    const evilHtml = await evil.text();
    check('path traversal não vaza arquivo', evil.status === 200 && !evilHtml.includes('"dependencies"'));

    // Usuário sem a permissão (cargo Operador, sem permissões) é redirecionado.
    const created = await api('/api/users', {
      method: 'POST',
      body: JSON.stringify({ username: 'suporte', name: 'Suporte', password: 'Suporte@123', roleSlug: 'operador' }),
    }, admin);
    check('usuário sem permissão criado', created.status === 201, `status=${created.status}`);
    const op = await login('suporte', 'Suporte@123');
    const denied = await api('/admin/documentacao', { redirect: 'manual' }, op);
    check('usuário sem permissão é redirecionado', denied.status === 302, `status=${denied.status}`);
  } finally {
    server.close();
    closeDb();
  }

  console.log(failures === 0 ? '\nDocumentação técnica: TODOS OS TESTES PASSARAM' : `\n${failures} falha(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
