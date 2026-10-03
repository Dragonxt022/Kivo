/**
 * Teste da ordem dos cards da tela inicial.
 *
 * O que ele protege (requisito do dono): a arrumacao tem de valer **em qualquer navegador**, nao
 * so na maquina onde foi feita. Antes a ordem vivia em `localStorage` (`HOME_ORDER_KEY`) e cada
 * aparelho mostrava uma tela diferente — no modo navegador (celular/tablet na rede local), a
 * ordem simplesmente nao existia.
 *
 * Agora mora em `settings` (preferencia da empresa), lida no servidor e injetada na pagina. O
 * teste prova isso do jeito que importa: **uma sessao diferente** (outro usuario, sem localStorage
 * nenhum) recebe a mesma ordem na pagina inicial.
 *
 * KIVO_DB_PATH TEM que vir do ambiente — rode com
 *   node scripts/test-isolated.js src/tests/home-cards.ts
 */
import { migrateUp } from '../core/database/migrator';
import { runSeeds } from '../core/database/seeds';
import { getSqlite } from '../core/database/connection';
import { createServer } from '../core/server';
import { resetTestDb, activateTestLicense } from './resetTestDb';
import { unwrap } from './testUtils';
import { applyPriority, applySavedOrder, priorityForBusinessType } from '../core/config/homeCards';

const PORT = Number(process.env.KIVO_PORT ?? 3852);
const base = `http://localhost:${PORT}`;
const ROTA = '/api/settings/interface/cards';

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

/** Extrai a ordem injetada na pagina inicial (e ela que o navegador aplica). */
function ordemDaPagina(html: string): string[] {
  const m = /const ORDEM_CARDS = (\[[^\]]*\]);/.exec(html);
  if (!m) return [];
  try {
    return JSON.parse(m[1]) as string[];
  } catch {
    return [];
  }
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
    check('login admin', admin !== null);

    // ── Unidade: ordem salva e sugestao pelo perfil ────────────────────────
    const cards = [
      { href: '/app/pdv' }, { href: '/app/produtos' }, { href: '/app/odonto/agenda' },
    ];
    check('ordem salva e respeitada',
      applySavedOrder(cards, ['/app/odonto/agenda', '/app/pdv']).map((c) => c.href).join(',')
        === '/app/odonto/agenda,/app/pdv,/app/produtos');
    check('href novo (modulo ligado depois) vai para o fim',
      applySavedOrder(cards, ['/app/produtos'])[0].href === '/app/produtos');
    check('href que nao existe mais e ignorado sem perder card',
      applySavedOrder(cards, ['/app/inexistente', '/app/pdv']).length === 3);
    check('lista vazia nao mexe na ordem do servidor',
      applySavedOrder(cards, []).map((c) => c.href).join(',') === '/app/pdv,/app/produtos,/app/odonto/agenda');
    check('perfil de odontologia prioriza o consultorio',
      priorityForBusinessType('Consultorio odontologico')[0] === '/app/odonto');
    check('perfil de mercadinho prioriza o PDV',
      priorityForBusinessType('Mercadinho do bairro')[0] === '/app/pdv');
    check('perfil desconhecido nao reordena nada',
      priorityForBusinessType('outra coisa qualquer').length === 0);
    check('prioridade ordena mantendo o resto estavel',
      applyPriority(cards, ['/app/odonto'])[0].href === '/app/odonto/agenda');

    // ── API: permissao e persistencia ──────────────────────────────────────
    const inicial = await unwrap<{ ordem: string[]; ocultos: string[] }>(await api(ROTA, {}, admin!));
    check('comeca sem ordem salva', inicial.ordem.length === 0, JSON.stringify(inicial));

    check('corpo invalido -> 400', (await api(ROTA, {
      method: 'PUT', body: JSON.stringify({ ordem: 'nao e lista' }),
    }, admin!)).status === 400);

    const ORDEM = ['/admin/cobrancas', '/app/odonto/painel', '/app/pdv'];
    const salvo = await api(ROTA, {
      method: 'PUT', body: JSON.stringify({ ordem: ORDEM, ocultos: ['/admin/backup'] }),
    }, admin!);
    check('admin salva a ordem (200)', salvo.status === 200, String(salvo.status));

    const lido = await unwrap<{ ordem: string[]; ocultos: string[] }>(await api(ROTA, {}, admin!));
    check('a ordem volta igual', lido.ordem.join(',') === ORDEM.join(','), lido.ordem.join(','));
    check('os cards ocultos tambem ficam salvos', lido.ocultos.join(',') === '/admin/backup');

    // ── O requisito: OUTRO navegador/sessao enxerga a mesma ordem ──────────
    const roleRecepcao = await unwrap<{ id: number; slug: string }>(
      await api('/api/roles', { method: 'POST', body: JSON.stringify({ name: 'Recepcao cards' }) }, admin!));
    await api(`/api/roles/${roleRecepcao.id}/permissions`, {
      method: 'PUT', body: JSON.stringify({ permissions: ['odonto.patients.view', 'settings.view'] }),
    }, admin!);
    await api('/api/users', {
      method: 'POST', body: JSON.stringify({ username: 'recepcao_cards', name: 'Recepcao', password: 'Teste1234', roleSlug: roleRecepcao.slug }),
    }, admin!);
    const recepcao = await loginAs('recepcao_cards', 'Teste1234');
    check('login em outra sessao (outro usuario)', recepcao !== null);

    const paginaOutro = await (await api('/', {}, recepcao!)).text();
    const ordemVista = ordemDaPagina(paginaOutro);
    check('a outra sessao recebe a MESMA ordem na pagina (vale no navegador)',
      ordemVista.join(',') === ORDEM.join(','), ordemVista.join(','));
    check('a pagina nao depende de localStorage para a ordem',
      !paginaOutro.includes('HOME_ORDER_KEY'));

    check('sem settings.edit nao salva (403)', (await api(ROTA, {
      method: 'PUT', body: JSON.stringify({ ordem: ['/app/pdv'] }),
    }, recepcao!)).status === 403);
    const depoisDoBloqueio = await unwrap<{ ordem: string[] }>(await api(ROTA, {}, admin!));
    check('a tentativa sem permissao nao mexeu na ordem',
      depoisDoBloqueio.ordem.join(',') === ORDEM.join(','), depoisDoBloqueio.ordem.join(','));

    // ── Pagina inicial: Recursos e Cobranca tem card ───────────────────────
    const paginaAdmin = await (await api('/', {}, admin!)).text();
    check('Cobranca aparece nos cards', paginaAdmin.includes('/admin/cobrancas'));
    check('Recursos aparece nos cards', paginaAdmin.includes('/admin/recursos'));
    check('o card "Mais" descreve a segunda camada',
      /Usu.rios, cargos, auditoria, backup, cobran/i.test(paginaAdmin));
    check('o atalho do card existe (icone no hover)', paginaAdmin.includes('card-more'));
    check('quem tem settings.edit pode arrastar',
      paginaAdmin.includes('const PODE_ARRUMAR_CARDS = true'));
    check('quem nao tem ve a ordem da empresa sem poder mexer',
      paginaOutro.includes('const PODE_ARRUMAR_CARDS = false'));

    // ── Auditoria ──────────────────────────────────────────────────────────
    const logs = db.prepare(
      "SELECT action, entity FROM audit_logs WHERE entity = 'interface_cards'",
    ).all() as { action: string; entity: string }[];
    check('a mudanca de ordem fica auditada', logs.length === 1 && logs[0].action === 'editar',
      JSON.stringify(logs.map((l) => l.action)));
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    // Dá um respiro para o libuv fechar os soquetes antes de sair (evita o assert do async.c).
    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  console.log(failures === 0 ? '\nOrdem dos cards: TODOS OS TESTES PASSARAM' : `\n${failures} falha(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
