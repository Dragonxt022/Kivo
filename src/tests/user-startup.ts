/**
 * Testes da abertura personalizada por usuário (`core/users/startup.ts`).
 *
 * - Desligada por padrão.
 * - Grava módulo + tela cheia por usuário.
 * - O servidor entrega a preferência já validada para o `theme-init` (o cliente redireciona
 *   e chama a tela cheia).
 * - Não aceita um módulo que o usuário-alvo não pode abrir.
 *
 * Roda com banco descartável:
 *   node scripts/test-isolated.js src/tests/user-startup.ts
 */
import { migrateUp } from '../core/database/migrator';
import { runSeeds } from '../core/database/seeds';
import { createServer } from '../core/server';
import { closeDb } from '../core/database/connection';
import { activateTestLicense } from './resetTestDb';
import { unwrap } from './testUtils';

const PORT = Number(process.env.KIVO_PORT ?? 3830);
const base = `http://localhost:${PORT}`;
let failures = 0;

function check(label: string, ok: boolean, extra = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures++;
}

async function api(path: string, opts: RequestInit = {}, cookie?: string): Promise<Response> {
  return fetch(`${base}${path}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}), ...(opts.headers ?? {}) },
  });
}

async function loginAs(username: string, password: string): Promise<string | null> {
  const r = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) });
  if (!r.ok) return null;
  const m = (r.headers.get('set-cookie') ?? '').match(/kivo_session=([^;]+)/);
  return m ? `kivo_session=${m[1]}` : null;
}

interface StartupResponse {
  enabled: boolean;
  moduleHref: string;
  fullscreen: boolean;
  modules: { href: string; label: string; moduleName: string | null }[];
}

async function main(): Promise<void> {
  migrateUp();
  runSeeds();
  activateTestLicense();
  const { app } = await createServer();
  const server = app.listen(PORT);

  try {
    const admin = await loginAs('admin', 'admin');
    check('login admin', admin !== null);
    const users = await unwrap<{ id: number; username: string }[]>(await api('/api/users', {}, admin!));
    const adminUser = users.find((u) => u.username === 'admin');
    if (!adminUser) throw new Error('usuário admin não encontrado');

    const initial = await unwrap<StartupResponse>(await api(`/api/users/${adminUser.id}/startup`, {}, admin!));
    check('abertura desligada por padrão', initial.enabled === false);
    check('tela cheia marcada por padrão quando ligar', initial.fullscreen === true);
    check('lista módulos disponíveis para o usuário', initial.modules.length > 0, String(initial.modules.length));

    const target = initial.modules.find((m) => m.href === '/app/store/vendas') ?? initial.modules[0];
    const saved = await api(`/api/users/${adminUser.id}`, {
      method: 'PUT',
      body: JSON.stringify({ startup: { enabled: true, moduleHref: target.href, fullscreen: true } }),
    }, admin!);
    check('salva abertura personalizada', saved.status === 200, String(saved.status));

    const after = await unwrap<StartupResponse>(await api(`/api/users/${adminUser.id}/startup`, {}, admin!));
    check('preferência persistiu por usuário', after.enabled && after.moduleHref === target.href && after.fullscreen,
      JSON.stringify(after));

    // O HTML da home carrega a preferência no theme-init; o cliente é quem redireciona.
    const home = await api('/', {}, admin!);
    const homeHtml = await home.text();
    check('home entrega a preferência para o cliente',
      homeHtml.includes('"enabled":true') && homeHtml.includes(target.href),
      String(home.status));

    // Desligar volta ao comportamento normal.
    await api(`/api/users/${adminUser.id}`, {
      method: 'PUT',
      body: JSON.stringify({ startup: { enabled: false, moduleHref: target.href, fullscreen: true } }),
    }, admin!);
    const off = await unwrap<StartupResponse>(await api(`/api/users/${adminUser.id}/startup`, {}, admin!));
    check('desligar mantém o módulo escolhido na memória', off.enabled === false && off.moduleHref === target.href);
    const homeOff = await (await api('/', {}, admin!)).text();
    check('home desligada não entrega startup', homeOff.includes('var s = null;'));

    // Usuário sem permissão no módulo escolhido: recusa em vez de gravar algo que não abre.
    const created = await api('/api/users', {
      method: 'POST',
      body: JSON.stringify({
        username: 'startup-operador', name: 'Startup Operador', password: 'Teste1234', roleSlug: 'operador',
      }),
    }, admin!);
    check('usuário de teste criado', created.status === 201, String(created.status));
    const createdBody = await unwrap<{ id: number }>(created);
    const denied = await api(`/api/users/${createdBody.id}`, {
      method: 'PUT',
      body: JSON.stringify({ startup: { enabled: true, moduleHref: '/app/finance/caixa', fullscreen: true } }),
    }, admin!);
    check('módulo sem permissão é recusado', denied.status === 400, String(denied.status));

    const noPerms = await unwrap<StartupResponse>(await api(`/api/users/${createdBody.id}/startup`, {}, admin!));
    check('usuário sem cargo não recebe opções de módulo', noPerms.modules.length === 0, String(noPerms.modules.length));
  } finally {
    server.close();
    closeDb();
  }

  console.log(failures === 0 ? '\nAbertura por usuário: TODOS OS TESTES PASSARAM' : `\n${failures} falha(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
