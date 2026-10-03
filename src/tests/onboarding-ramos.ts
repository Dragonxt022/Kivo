/**
 * Teste do assistente de boas-vindas: TODO ramo oferecido precisa completar o primeiro acesso.
 *
 * Este teste existe por causa de um defeito real: a tela passou a oferecer "Odontologia / clínica"
 * e "Sorveteria / açaí", o tipo do servidor foi atualizado, mas a lista de valores ACEITOS ficou
 * para trás — quem escolhia odontologia terminava o assistente com "Campo businessType inválido."
 * na última etapa, depois de responder tudo.
 *
 * Duas guardas aqui:
 *  1. a lista de ramos da TELA (`public/js/onboarding.js`) tem de bater com a do SERVIDOR
 *     (`BUSINESS_TYPES`) — divergência em qualquer direção falha;
 *  2. percorrer todos os ramos pelo endpoint de provisionamento, conferindo que nenhum responde 400.
 *
 * KIVO_DB_PATH TEM que vir do ambiente — rode com
 *   node scripts/test-isolated.js src/tests/onboarding-ramos.ts
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { migrateUp } from '../core/database/migrator';
import { runSeeds } from '../core/database/seeds';
import { getSqlite } from '../core/database/connection';
import { createServer } from '../core/server';
import { resetTestDb, activateTestLicense } from './resetTestDb';
import { unwrap } from './testUtils';
import { BUSINESS_TYPES, EMPLOYEE_RANGES } from '../core/onboarding/service';

const PORT = Number(process.env.KIVO_PORT ?? 3854);
const base = `http://localhost:${PORT}`;
const ROTA = '/api/onboarding/provision';

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

/** Ramos que a TELA oferece (o assistente é Alpine e carrega a lista em public/js/onboarding.js). */
function ramosDaTela(): string[] {
  const js = readFileSync(path.resolve(__dirname, '..', 'public', 'js', 'onboarding.js'), 'utf8');
  const bloco = /businessTypes:\s*\[([\s\S]*?)\n\s*\],/.exec(js)?.[1] ?? '';
  return [...bloco.matchAll(/id:\s*'([a-z]+)'/g)].map((m) => m[1]);
}

async function main(): Promise<void> {
  resetTestDb();
  migrateUp();
  runSeeds();
  // O assistente roda no primeiro acesso, com a licença já ativa (a rota fica depois do
  // `requireActivation`): sem ativar, toda chamada volta `not_activated` em vez de validar o ramo.
  activateTestLicense();
  const { app } = await createServer();
  const server = app.listen(PORT);
  const db = getSqlite();

  try {
    const admin = await loginAs('admin', 'admin');
    check('login admin', admin !== null);

    // ── Guarda 1: a lista da tela e a do servidor são a mesma ──────────────
    const daTela = ramosDaTela();
    check('a tela oferece ramos', daTela.length >= 10, `${daTela.length} na tela`);
    const faltamNoServidor = daTela.filter((t) => !(BUSINESS_TYPES as readonly string[]).includes(t));
    check('todo ramo da tela é aceito pelo servidor', faltamNoServidor.length === 0, faltamNoServidor.join(', '));
    const foraDaTela = (BUSINESS_TYPES as readonly string[]).filter((t) => !daTela.includes(t));
    check('todo ramo do servidor aparece na tela', foraDaTela.length === 0, foraDaTela.join(', '));

    // ── Guarda 2: cada ramo completa o primeiro acesso ────────────────────
    const problemas: string[] = [];
    for (const ramo of BUSINESS_TYPES) {
      const r = await api(ROTA, {
        method: 'POST',
        body: JSON.stringify({
          usage: 'balcao',
          businessType: ramo,
          businessName: 'Kivo - Sistemas',
          employeeRange: EMPLOYEE_RANGES[0],
          activePaymentMethodIds: [],
          // Dados de demonstração só no ramo do consultório: aqui o alvo é a VALIDAÇÃO do ramo.
          createDemoData: ramo === 'odontologia',
          resetDemoData: false,
          activeFeatureKeys: [],
        }),
      }, admin!);
      if (r.status !== 200) problemas.push(`${ramo}: HTTP ${r.status} ${(await r.text()).slice(0, 80)}`);
    }
    check('todos os ramos completam o assistente (nenhum 400)', problemas.length === 0,
      problemas.length ? '\n    ' + problemas.join('\n    ') : `${BUSINESS_TYPES.length} ramos`);

    // O ramo do consultório (o que falhava) cria o ambiente de teste de verdade.
    const produtos = db.prepare('SELECT COUNT(*) AS t FROM products WHERE deleted_at IS NULL').get() as { t: number };
    check('o ramo odontologia prepara o ambiente de teste', produtos.t > 0, `${produtos.t} produto(s)`);

    // ── A validação continua recusando o que não existe ───────────────────
    check('ramo inventado → 400', (await api(ROTA, {
      method: 'POST',
      body: JSON.stringify({ usage: 'balcao', businessType: 'inventado', businessName: 'X', employeeRange: EMPLOYEE_RANGES[0] }),
    }, admin!)).status === 400);
    check('uso inválido → 400', (await api(ROTA, {
      method: 'POST',
      body: JSON.stringify({ usage: 'inventado', businessType: 'outro', businessName: 'X', employeeRange: EMPLOYEE_RANGES[0] }),
    }, admin!)).status === 400);
    check('sem nome do negócio no primeiro acesso → 400', (await api(ROTA, {
      method: 'POST',
      body: JSON.stringify({ usage: 'balcao', businessType: 'outro', employeeRange: EMPLOYEE_RANGES[0], createDemoData: true }),
    }, admin!)).status === 400);
    check('sem permissão → 403', (await api(ROTA, {
      method: 'POST',
      body: JSON.stringify({ usage: 'balcao', businessType: 'outro', businessName: 'X', employeeRange: EMPLOYEE_RANGES[0] }),
    })).status === 401 || (await api(ROTA, {
      method: 'POST',
      body: JSON.stringify({ usage: 'balcao', businessType: 'outro', businessName: 'X', employeeRange: EMPLOYEE_RANGES[0] }),
    })).status === 403);

    // ── Estado do assistente ──────────────────────────────────────────────
    const status = await unwrap<{ completed: boolean; businessType?: string }>(
      await api('/api/onboarding/status', {}, admin!));
    check('o assistente fica marcado como concluído', status.completed === true, JSON.stringify(status));
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  console.log(failures === 0
    ? `\nAssistente de boas-vindas: TODOS OS TESTES PASSARAM (${BUSINESS_TYPES.length} ramos)`
    : `\n${failures} falha(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
