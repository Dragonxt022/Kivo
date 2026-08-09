/**
 * Teste: primeiro acesso.
 *
 * Cenário real: o lojista aceita o teste grátis, cai na home e encontra uma tela de
 * login sem nunca ter recebido credencial nenhuma — não tem como adivinhar admin/admin.
 * Enquanto o banco estiver com a credencial de fábrica intacta, a home troca o login
 * pela criação do acesso do dono; feita a troca, a porta de fábrica deixa de existir.
 */
import { migrateUp } from '../core/database/migrator';
import { runSeeds } from '../core/database/seeds';
import { createServer } from '../core/server';
import { closeDb } from '../core/database/connection';
import { resetTestDb, activateTestLicense } from './resetTestDb';
import { unwrap } from './testUtils';

const PORT = Number(process.env.KIVO_PORT ?? 3801);
const base = `http://localhost:${PORT}`;
let failures = 0;

function check(label: string, ok: boolean, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures++;
}

async function api(path: string, opts: RequestInit = {}) {
  return fetch(`${base}${path}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers ?? {}) },
  });
}

async function loginAs(username: string, password: string): Promise<boolean> {
  const r = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) });
  return r.ok;
}

async function main() {
  resetTestDb();
  migrateUp();
  runSeeds();
  activateTestLicense();
  const { app } = await createServer();
  const server = app.listen(PORT);

  // ---------- Instalação nova: primeiro acesso pendente ----------
  const pending0 = await api('/api/auth/first-run');
  check('instalação nova sinaliza primeiro acesso',
    pending0.status === 200 && (await unwrap<{ pending: boolean }>(pending0)).pending === true);

  // Senha fraca não passa: o acesso já nasce no padrão exigido no resto do sistema.
  check('senha fraca é recusada (400)',
    (await api('/api/auth/first-run', {
      method: 'POST', body: JSON.stringify({ name: 'Maria', username: 'maria', password: 'maria' }),
    })).status === 400);
  check('usuário com caractere inválido é recusado (400)',
    (await api('/api/auth/first-run', {
      method: 'POST', body: JSON.stringify({ name: 'Maria', username: 'ma ria', password: 'Loja1234' }),
    })).status === 400);
  check('recusa não consumiu o primeiro acesso',
    (await unwrap<{ pending: boolean }>(await api('/api/auth/first-run'))).pending === true);

  // ---------- Criação do acesso ----------
  const setup = await api('/api/auth/first-run', {
    method: 'POST', body: JSON.stringify({ name: 'Maria Souza', username: 'Maria', password: 'Loja1234' }),
  });
  check('cria o acesso do dono (200)', setup.status === 200);
  // Já entra logado: o objetivo é não devolver o lojista para a tela de login.
  check('primeiro acesso já devolve sessão', (setup.headers.get('set-cookie') ?? '').includes('kivo_session='));
  const setupUser = (await unwrap<{ user: { username: string; role: string } }>(setup)).user;
  check('usuário é normalizado para minúsculas', setupUser.username === 'maria');
  check('herda o cargo de administrador', setupUser.role === 'administrador', `role=${setupUser.role}`);
  check('entra com as credenciais criadas', (await loginAs('maria', 'Loja1234')) === true);

  // ---------- Porta de fábrica fechada ----------
  check('admin/admin não entra mais', (await loginAs('admin', 'admin')) === false);
  check('primeiro acesso deixa de ser sinalizado',
    (await unwrap<{ pending: boolean }>(await api('/api/auth/first-run'))).pending === false);
  check('segunda tentativa de configurar é recusada (409)',
    (await api('/api/auth/first-run', {
      method: 'POST', body: JSON.stringify({ name: 'Invasor', username: 'invasor', password: 'Invasor1' }),
    })).status === 409);

  server.close();
  closeDb();
  console.log(failures === 0 ? '\nPrimeiro acesso: TODOS OS TESTES PASSARAM' : `\n${failures} falha(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
