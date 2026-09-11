/**
 * Testes da situação da empresa na nuvem (core/license/service.ts):
 * quando o servidor recusa a empresa — excluída/desativada (404) ou chave trocada (401) —
 * o Kivo registra o motivo para a tela explicar, mas NÃO derruba a licença local: o app
 * segue com o `valid_until` já conhecido até vencer. Um 200 posterior (empresa restaurada)
 * limpa o aviso e atualiza a validade.
 *
 * Roda offline (não precisa de Docker/cloud): SQLite temporário + fetch mockado.
 */
import path from 'node:path';

// Antes de qualquer módulo de runtime abrir a conexão — mesmo padrão de
// license-company-profile.ts.
process.env.KIVO_DB_PATH = path.resolve(process.cwd(), 'storage', 'temp', 'license-cloud-issue.db');
process.env.KIVO_SYNC_SERVER_URL = 'https://cloud.test';
process.env.KIVO_MACHINE_ID = 'test-machine-cloud-issue';

/* eslint-disable @typescript-eslint/no-require-imports */
const { migrateUp } = require('../core/database/migrator');
const { runSeeds } = require('../core/database/seeds');
const { resetTestDb } = require('./resetTestDb');
const {
  setLicense,
  refreshLicenseFromCloud,
  validateLicense,
  getCloudIssue,
  hasCloudIssue,
} = require('../core/license/service');
/* eslint-enable @typescript-eslint/no-require-imports */

let failures = 0;
function check(label: string, ok: boolean, extra = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures++;
}

const FUTURE = '2999-12-31 00:00:00';
const realFetch = globalThis.fetch;

/** Substitui o fetch global por respostas fixas — nenhuma chamada de rede real. */
function mockFetch(status: number, body: unknown): void {
  (globalThis as { fetch: unknown }).fetch = async () =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

async function main(): Promise<void> {
  resetTestDb();
  migrateUp();
  runSeeds();

  setLicense('company-abc', 'key-123', 'diamante', FUTURE);
  check('licença configurada começa válida', validateLicense().status === 'valida');
  check('sem situação de nuvem no início', getCloudIssue().issue === null);

  // ─── 404: empresa excluída/desativada no painel cloud ───
  mockFetch(404, { error: 'Empresa não encontrada no servidor.', code: 'company_not_found' });
  await refreshLicenseFromCloud();
  const removed = validateLicense();
  check('404 marca empresa_removida', getCloudIssue().issue === 'empresa_removida', String(getCloudIssue().issue));
  check('licença continua válida após 404', removed.status === 'valida', removed.status);
  check('validade local é preservada (não trava o app)', removed.validUntil === FUTURE, String(removed.validUntil));
  check('mensagem explica a empresa removida', /não existe mais no servidor/.test(removed.message), removed.message);
  check('hasCloudIssue() reflete o estado', hasCloudIssue() === true);

  // ─── 401: chave de licença trocada/rotacionada ───
  mockFetch(401, { error: 'Credenciais inválidas.', code: 'invalid_credentials' });
  await refreshLicenseFromCloud();
  check('401 marca credenciais_invalidas', getCloudIssue().issue === 'credenciais_invalidas', String(getCloudIssue().issue));

  // ─── 200: empresa restaurada/chave corrigida → limpa o aviso e atualiza ───
  const RENEWED = '3000-01-31 00:00:00';
  mockFetch(200, {
    plan: 'diamante',
    modules: null,
    validUntil: RENEWED,
    supportPhone: null,
    supportEmail: null,
    recoverySecret: null,
    company: null,
    serverTime: new Date().toISOString(),
  });
  await refreshLicenseFromCloud();
  const ok = validateLicense();
  check('200 limpa a situação de nuvem', getCloudIssue().issue === null, String(getCloudIssue().issue));
  check('200 atualiza a validade', ok.validUntil === RENEWED, String(ok.validUntil));
  check('mensagem volta a ser a padrão', ok.message === 'Licença válida.', ok.message);

  (globalThis as { fetch: unknown }).fetch = realFetch;

  if (failures) {
    console.log(`\nSituação da empresa na nuvem: ${failures} FALHA(S)`);
    process.exit(1);
  } else {
    console.log('\nSituação da empresa na nuvem: TODOS OS TESTES PASSARAM');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
