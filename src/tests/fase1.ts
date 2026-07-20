/**
 * Teste da DoD da Fase 1:
 * 1. Login admin funciona; sem login, API retorna 401.
 * 2. Admin cria usuário "operador" (sem permissões).
 * 3. Operador tenta excluir usuário → 403 (bloqueado por RBAC).
 * 4. Admin exclui → 200 (soft delete).
 * 5. Toda ação sensível (login, criar, excluir, acesso negado) está no audit log.
 */
import { migrateUp } from '../core/database/migrator';
import { runSeeds } from '../core/database/seeds';
import { createServer } from '../core/server';
import { getSqlite, closeDb } from '../core/database/connection';
import { resetTestDb, activateTestLicense } from './resetTestDb';

const PORT = Number(process.env.KIVO_PORT ?? 3199);
const base = `http://localhost:${PORT}`;
let failures = 0;

function check(label: string, ok: boolean, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures++;
}

async function api(path: string, opts: RequestInit = {}, cookie?: string) {
  return fetch(`${base}${path}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { cookie } : {}),
      ...(opts.headers ?? {}),
    },
  });
}

async function loginAs(username: string, password: string): Promise<string | null> {
  const r = await api('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  });
  if (!r.ok) return null;
  const setCookie = r.headers.get('set-cookie') ?? '';
  const m = setCookie.match(/kivo_session=([^;]+)/);
  return m ? `kivo_session=${m[1]}` : null;
}

async function main() {
  resetTestDb();
  migrateUp();
  runSeeds();
  activateTestLicense();
  const { app } = await createServer();
  const server = app.listen(PORT);

  // 1. Sem login → 401
  check('sem login, /api/users retorna 401', (await api('/api/users')).status === 401);

  // Login inválido
  check('login inválido retorna 401', (await loginAs('admin', 'senhaerrada')) === null);

  // Login admin
  const adminCookie = await loginAs('admin', 'admin');
  check('login admin funciona', adminCookie !== null);
  if (!adminCookie) throw new Error('sem sessão admin');

  // 2. Admin cria operador e uma vítima
  const mk = (u: string, role: string) =>
    api('/api/users', {
      method: 'POST',
      body: JSON.stringify({ username: u, name: u, password: '123456', roleSlug: role }),
    }, adminCookie);
  const rOp = await mk('operador1', 'operador');
  const rVi = await mk('vitima', 'caixa');
  check('admin cria usuários (users.create)', rOp.status === 201 && rVi.status === 201);
  const vitima = (await rVi.json()) as { id: number };

  // 3. Operador: sem permissão de listar nem excluir
  const opCookie = await loginAs('operador1', '123456');
  check('login operador funciona', opCookie !== null);
  const rList = await api('/api/users', {}, opCookie!);
  check('operador não lista usuários (403)', rList.status === 403);
  const rDel = await api(`/api/users/${vitima.id}`, { method: 'DELETE' }, opCookie!);
  check('operador NÃO consegue excluir (403)', rDel.status === 403);

  // 4. Admin exclui
  const rDelAdmin = await api(`/api/users/${vitima.id}`, { method: 'DELETE' }, adminCookie);
  check('admin exclui (users.delete)', rDelAdmin.status === 200);

  // 5. Auditoria
  const audit = getSqlite()
    .prepare('SELECT action, entity, username FROM audit_logs')
    .all() as { action: string; entity: string; username: string | null }[];
  const has = (action: string) => audit.some((a) => a.action === action);
  check('auditoria registra login', has('login'));
  check('auditoria registra login falho', has('login_falhou'));
  check('auditoria registra criação', has('criar'));
  check('auditoria registra exclusão', has('excluir'));
  check('auditoria registra acesso negado', has('acesso_negado'));

  server.close();
  closeDb();
  console.log(failures === 0 ? '\nDoD Fase 1: TODOS OS TESTES PASSARAM' : `\n${failures} falha(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
