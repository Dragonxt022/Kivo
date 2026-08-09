/**
 * Teste: a configuração inicial entrega um sistema utilizável sem o lojista mexer em nada.
 *
 * Cobre quatro coisas que antes o dono da loja tinha que descobrir e arrumar sozinho:
 *
 *   CARGOS      — Caixa/Estoquista/Vendedor nasciam com ZERO permissões. Quem criasse um
 *                 usuário "caixa" no primeiro dia entregava a ele um sistema onde nada
 *                 abria, sem nenhuma pista de que faltava configurar cargo.
 *   CADASTROS   — venda a prazo e registro de compra exigem cliente/fornecedor, e ambas as
 *                 listas nasciam vazias.
 *   RECURSOS    — o assistente só ligava capability junto com os dados de exemplo; quem
 *                 recusava a demonstração respondia "atendo em mesas" e terminava sem o
 *                 módulo de mesas. E nada era DESLIGADO, então recurso de restaurante
 *                 sobrava no menu de uma loja de roupas.
 *   FORÇA BRUTA — o bloqueio por senha errada durava 1 minuto, travando o caixa.
 *
 * KIVO_DB_PATH TEM que vir do ambiente — este teste recria o banco que usar:
 *   node scripts/kivo test:onboarding        ← use o comando
 *   npx tsx src/tests/onboarding-permissoes.ts    ← NÃO: apagaria o banco de dev
 */
import fs from 'node:fs';
import path from 'node:path';

import { migrateUp } from '../core/database/migrator';
import { runSeeds } from '../core/database/seeds';
import { createServer } from '../core/server';
import { getSqlite, closeDb } from '../core/database/connection';
import { activateTestLicense } from './resetTestDb';
import { unwrap } from './testUtils';
import { ROLE_PRESETS } from '../core/roles/presets';

const PORT = Number(process.env.KIVO_PORT ?? 3814);
const base = `http://localhost:${PORT}`;
let failures = 0;

function check(label: string, ok: boolean, extra = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures++;
}

let cookie = '';

async function api(p: string, opts: RequestInit = {}): Promise<Response> {
  return fetch(`${base}${p}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}), ...(opts.headers ?? {}) },
  });
}

function assertBancoDescartavel(): string {
  const alvo = process.env.KIVO_DB_PATH;
  if (!alvo) {
    throw new Error(
      'KIVO_DB_PATH não definida. Este teste APAGA o banco que usar — rode via ' +
      '`node scripts/kivo test:onboarding`, que aponta para um arquivo temporário.',
    );
  }
  if (path.resolve(alvo) === path.resolve(process.cwd(), 'database', 'kivo.db')) {
    throw new Error('Recusado: KIVO_DB_PATH aponta para o banco de dev.');
  }
  return alvo;
}

interface Role { id: number; slug: string; name: string; permissions: string[] }
interface Feature { key: string; label: string; enabled: boolean; recommend?: { usage?: string[]; businessType?: string[] } }

async function main(): Promise<void> {
  const TMP_DB = assertBancoDescartavel();
  fs.mkdirSync(path.dirname(TMP_DB), { recursive: true });
  fs.rmSync(TMP_DB, { force: true });

  migrateUp();
  runSeeds();
  activateTestLicense();
  const { app } = await createServer();
  const server = app.listen(PORT);
  const db = getSqlite();

  try {
    const login = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'admin', password: 'admin' }) });
    const m = (login.headers.get('set-cookie') ?? '').match(/kivo_session=([^;]+)/);
    cookie = m ? `kivo_session=${m[1]}` : '';
    check('login admin', cookie !== '');
    if (!cookie) return;

    // ── Cargos prontos nascem usáveis ─────────────────────────────────────────────
    const roles = await unwrap<Role[]>(await api('/api/roles'));
    const bySlug = new Map(roles.map((r) => [r.slug, r]));

    for (const slug of ['gerente', 'vendedor', 'caixa', 'estoquista', 'entregador', 'garcom', 'cozinha']) {
      const r = bySlug.get(slug);
      check(`cargo "${slug}" existe e já vem com permissões`, !!r && r.permissions.length > 0,
        r ? `${r.permissions.length} permissões` : 'cargo ausente');
    }
    // Vazio DE PROPÓSITO: é a base para montar do zero, e meia dúzia de testes de RBAC
    // (fase1, fase3, fase4, fase5…) dependem dele para provar que 403 acontece.
    check('cargo "operador" continua sem permissão nenhuma',
      (bySlug.get('operador')?.permissions.length ?? -1) === 0);

    const caixa = bySlug.get('caixa')!;
    check('Caixa consegue vender e abrir o caixa',
      ['store.sales.create', 'finance.cash.open', 'finance.cash.close'].every((k) => caixa.permissions.includes(k)));
    check('Caixa NÃO mexe em configuração nem em usuário',
      !caixa.permissions.some((k) => k.startsWith('settings.') || k.startsWith('users.')));

    const estoquista = bySlug.get('estoquista')!;
    check('Estoquista movimenta estoque mas não altera preço de venda',
      estoquista.permissions.includes('commercial.stock.move') && !estoquista.permissions.includes('commercial.products.price'));

    // Toda chave dos modelos precisa existir no catálogo real: um erro de digitação aqui
    // vira permissão fantasma, que nunca dá erro e nunca libera nada.
    const catalogo = new Set(
      (await unwrap<{ key: string }[]>(await api('/api/roles/permissions'))).map((p) => p.key),
    );
    const fantasmas = ROLE_PRESETS.flatMap((p) => (p.permissions === '*' ? [] : p.permissions))
      .filter((k) => !catalogo.has(k));
    check('nenhum modelo referencia permissão inexistente', fantasmas.length === 0, fantasmas.join(', '));

    check('a tela busca os modelos na mesma fonte das seeds',
      (await unwrap<{ slug: string }[]>(await api('/api/roles/presets'))).length === ROLE_PRESETS.length);

    // ── Instalação antiga: o Gerente ganha o resto sem perder o que já tinha ──────
    // Simula a versão anterior, em que o Gerente nascia só com permissões do Core.
    const gerente = bySlug.get('gerente')!;
    db.prepare('DELETE FROM role_permissions WHERE role_id = ?').run(gerente.id);
    db.prepare(`INSERT INTO role_permissions (role_id, permission_key) VALUES (?, 'audit.view'), (?, 'settings.view')`)
      .run(gerente.id, gerente.id);
    db.prepare(`INSERT INTO role_permissions (role_id, permission_key) VALUES (?, 'fiscal.config.edit')`).run(gerente.id);
    db.prepare('DELETE FROM settings WHERE key = ?').run('seeds.role_presets_backfill');
    runSeeds();
    const gerenteDepois = (await unwrap<Role[]>(await api('/api/roles'))).find((r) => r.slug === 'gerente')!;
    check('a atualização completa o Gerente antigo com o que faltava',
      ['store.sales.create', 'commercial.stock.view', 'finance.cash.open'].every((k) => gerenteDepois.permissions.includes(k)),
      `${gerenteDepois.permissions.length} permissões`);
    check('e preserva o que o dono tinha acrescentado à mão',
      gerenteDepois.permissions.includes('fiscal.config.edit'));

    // ── As seeds não ressuscitam o que o administrador removeu ────────────────────
    await api(`/api/roles/${caixa.id}/permissions`, {
      method: 'PUT', body: JSON.stringify({ permissions: caixa.permissions.filter((k) => k !== 'finance.cash.close') }),
    });
    runSeeds(); // simula o próximo boot
    const caixaDepois = (await unwrap<Role[]>(await api('/api/roles'))).find((r) => r.slug === 'caixa')!;
    check('permissão removida à mão continua removida no boot seguinte',
      !caixaDepois.permissions.includes('finance.cash.close'));
    check('as demais permissões do cargo seguem intactas',
      caixaDepois.permissions.includes('store.sales.create'));

    // ── Cliente e fornecedor padrão ───────────────────────────────────────────────
    const clientes = await unwrap<{ name: string }[]>(await api('/api/commercial/customers'));
    check('nasce com o "Cliente à vista" cadastrado', clientes.some((c) => c.name === 'Cliente à vista'),
      clientes.map((c) => c.name).join(', ') || '(nenhum)');
    const fornecedores = await unwrap<{ name: string }[]>(await api('/api/commercial/suppliers'));
    check('nasce com o "Fornecedor Padrão" cadastrado', fornecedores.some((f) => f.name === 'Fornecedor Padrão'),
      fornecedores.map((f) => f.name).join(', ') || '(nenhum)');

    // ── Assistente: as respostas decidem os recursos, COM e SEM dados de exemplo ───
    const features = await unwrap<Feature[]>(await api('/api/onboarding/features'));
    check('o assistente oferece os recursos operacionais', features.length > 0, `${features.length} recursos`);
    check('não oferece recurso que depende de certificado/nuvem',
      !features.some((f) => f.key.startsWith('fiscal.') || f.key === 'commercial.cardapio_online'));

    const ligada = (key: string): boolean =>
      (db.prepare('SELECT enabled FROM capabilities WHERE key = ?').get(key) as { enabled: number } | undefined)?.enabled === 1;

    // Restaurante com mesas, SEM demonstração — este era o caminho que não configurava nada.
    const semDemo = await unwrap<{ featuresEnabled: string[]; tablesCreated: number }>(
      await api('/api/onboarding/provision', {
        method: 'POST',
        body: JSON.stringify({
          usage: 'mesas', businessType: 'restaurante', activePaymentMethodIds: [],
          createDemoData: false,
          activeFeatureKeys: ['comandas.mesas', 'foodservice.cozinha', 'commercial.complementos'],
        }),
      }),
    );
    check('recusar a demonstração ainda liga os recursos escolhidos',
      ligada('comandas.mesas') && ligada('foodservice.cozinha') && ligada('commercial.complementos'),
      `mesas=${ligada('comandas.mesas')} cozinha=${ligada('foodservice.cozinha')} compl=${ligada('commercial.complementos')}`);
    check('o resultado informa o que foi ligado', semDemo.featuresEnabled.length === 3, semDemo.featuresEnabled.join(', '));
    check('sem demonstração, nenhuma mesa de exemplo é criada', semDemo.tablesCreated === 0);

    // Agora o dono muda de ideia: loja de roupas, só balcão. O que era de restaurante sai.
    const trocou = await unwrap<{ featuresDisabled: string[] }>(
      await api('/api/onboarding/provision', {
        method: 'POST',
        body: JSON.stringify({
          usage: 'balcao', businessType: 'roupas', activePaymentMethodIds: [],
          createDemoData: false, activeFeatureKeys: ['commercial.variantes'],
        }),
      }),
    );
    check('trocar de ramo DESLIGA o que não serve mais',
      !ligada('comandas.mesas') && !ligada('foodservice.cozinha') && !ligada('commercial.complementos'),
      `mesas=${ligada('comandas.mesas')} cozinha=${ligada('foodservice.cozinha')} compl=${ligada('commercial.complementos')}`);
    check('e liga o que passou a servir', ligada('commercial.variantes'));
    check('o resultado informa o que foi desligado', trocou.featuresDisabled.length === 3, trocou.featuresDisabled.join(', '));

    // Recurso fora da lista curada não é tocado por tabela nenhuma do assistente.
    db.prepare("UPDATE capabilities SET enabled = 1 WHERE key = 'fiscal.nfce'").run();
    await api('/api/onboarding/provision', {
      method: 'POST',
      body: JSON.stringify({
        usage: 'balcao', businessType: 'outro', activePaymentMethodIds: [],
        createDemoData: false, activeFeatureKeys: [],
      }),
    });
    check('o assistente não desliga a emissão de nota que já estava ligada', ligada('fiscal.nfce'));

    // Cliente antigo (sem o campo novo) cai na recomendação, nunca em "desliga tudo".
    await api('/api/onboarding/provision', {
      method: 'POST',
      body: JSON.stringify({ usage: 'mesas', businessType: 'restaurante', activePaymentMethodIds: [], createDemoData: false }),
    });
    check('chamada sem activeFeatureKeys usa a recomendação das respostas',
      ligada('comandas.mesas') && ligada('commercial.complementos') && !ligada('commercial.variantes'),
      `mesas=${ligada('comandas.mesas')} compl=${ligada('commercial.complementos')} var=${ligada('commercial.variantes')}`);

    // ── As telas mexidas renderizam ───────────────────────────────────────────────
    // Erro de EJS não aparece em teste de API nenhum: a rota devolve 500 só quando um
    // humano abre a página. Um GET aqui custa nada e pega o typo antes do lojista.
    const cargos = await api('/admin/cargos');
    const cargosHtml = await cargos.text();
    check('a tela de cargos abre em formato de cartões',
      cargos.ok && cargosHtml.includes('role-grid') && cargosHtml.includes('perm-dialog'), `status=${cargos.status}`);
    const home = await api('/');
    const homeHtml = await home.text();
    check('a home carrega o assistente com o passo de recursos',
      home.ok && homeHtml.includes('wizard-feature-list'), `status=${home.status}`);
    const config = await api('/admin/configuracoes');
    check('as configurações abrem', config.ok, `status=${config.status}`);

    // ── Bloqueio por senha errada: 30 segundos, não 1 minuto ──────────────────────
    let bloqueio: Response | null = null;
    for (let i = 0; i < 8 && !bloqueio; i++) {
      const r = await fetch(`${base}/api/auth/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'senha-errada' }),
      });
      if (r.status === 429) bloqueio = r;
    }
    check('errar a senha várias vezes bloqueia (429)', bloqueio !== null);
    if (bloqueio) {
      const espera = Number(bloqueio.headers.get('retry-after') ?? '0');
      check('o bloqueio dura no máximo 30 segundos', espera > 0 && espera <= 30, `retry-after=${espera}s`);
      const corpo = (await bloqueio.json()) as { error?: string };
      check('a mensagem informa os 30 segundos', /30 segundos/.test(corpo.error ?? ''), corpo.error ?? '(sem mensagem)');
    }
  } finally {
    server.close();
    closeDb();
  }

  console.log(failures === 0 ? '\nConfiguração inicial: TODOS OS TESTES PASSARAM' : `\n${failures} falha(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
