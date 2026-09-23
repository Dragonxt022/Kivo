/**
 * Configuração de tipos de produto (Configurações › Tipos de produto).
 *
 * Cobre: listagem dos tipos, e que o servidor RESPEITA a configuração — desligar
 * "controla estoque" de um tipo faz o produto nascer sem saldo; desativar um tipo bloqueia
 * a criação de novos produtos daquele tipo.
 *
 *   node scripts/test-isolated.js src/tests/product-types.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { migrateUp } from '../core/database/migrator';
import { runSeeds } from '../core/database/seeds';
import { createServer } from '../core/server';
import { getSqlite, closeDb } from '../core/database/connection';
import { activateTestLicense } from './resetTestDb';
import { unwrap } from './testUtils';

const PORT = Number(process.env.KIVO_PORT ?? 3864);
const base = `http://localhost:${PORT}`;
let failures = 0;
function check(label: string, ok: boolean, extra = '') {
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
    const login = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'admin', password: 'admin' }) });
    const m = (login.headers.get('set-cookie') ?? '').match(/kivo_session=([^;]+)/);
    cookie = m ? `kivo_session=${m[1]}` : '';
    check('login admin', cookie !== '');
    if (!cookie) return;

    const types = await unwrap<{ key: string; controls_stock: number; active: number }[]>(await api('/api/commercial/product-types'));
    check('lista os tipos de produto', types.length === 7, `total=${types.length}`);
    const fisico = types.find((t) => t.key === 'fisico');
    check('físico controla estoque por padrão', fisico?.controls_stock === 1 && fisico?.active === 1, JSON.stringify(fisico));

    // Desliga "controla estoque" do físico e cria um produto sem informar trackStock.
    const off = await api('/api/commercial/product-types/fisico', { method: 'PUT', body: JSON.stringify({ controlsStock: false }) });
    check('desliga controla estoque do físico', off.status === 200, `status=${off.status}`);
    const p1 = await unwrap<{ id: number; track_stock: number }>(await api('/api/commercial/products', {
      method: 'POST', body: JSON.stringify({ name: 'Produto Sem Saldo', productType: 'fisico' }),
    }));
    check('produto nasce sem controle de estoque', p1.track_stock === 0, `track=${p1.track_stock}`);

    // Religa e confirma que volta a controlar.
    await api('/api/commercial/product-types/fisico', { method: 'PUT', body: JSON.stringify({ controlsStock: true }) });
    const p2 = await unwrap<{ id: number; track_stock: number }>(await api('/api/commercial/products', {
      method: 'POST', body: JSON.stringify({ name: 'Produto Com Saldo', productType: 'fisico' }),
    }));
    check('produto volta a controlar estoque', p2.track_stock === 1, `track=${p2.track_stock}`);

    // Desativa o tipo kit e tenta criar.
    await api('/api/commercial/product-types/kit', { method: 'PUT', body: JSON.stringify({ active: false }) });
    const blocked = await api('/api/commercial/products', {
      method: 'POST', body: JSON.stringify({ name: 'Kit Bloqueado', productType: 'kit' }),
    });
    const blockedJson = await blocked.json().catch(() => ({})) as { error?: string };
    check('criar produto de tipo desativado é recusado', blocked.status === 400 && !!blockedJson.error, `status=${blocked.status}`);
    await api('/api/commercial/product-types/kit', { method: 'PUT', body: JSON.stringify({ active: true }) });

    // A tela de configurações renderiza as abas novas (pega typo de EJS).
    const cfg = await api('/admin/configuracoes');
    const html = await cfg.text();
    check('Configurações renderiza a aba Tipos de produto',
      cfg.status === 200 && html.includes('tipos-produto') && html.includes('Tipos de produto'), `status=${cfg.status}`);
    check('Configurações renderiza a aba KIVO IA',
      html.includes("tab === 'ia'") && html.includes('KIVO IA'));

    // KIVO IA desligada por padrão: a rota recusa com mensagem clara (não tenta falar com a nuvem).
    const ia = await api('/api/ai/chat', { method: 'POST', body: JSON.stringify({ prompt: 'oi' }) });
    const iaBody = await ia.json().catch(() => ({})) as { error?: string };
    check('KIVO IA desligada recusa o chat', ia.status === 400 && !!iaBody.error, `${ia.status} ${iaBody.error ?? ''}`);

    // Os UUIDs semeados são fixos (o sync casa a mesma linha entre máquinas).
    const uuids = db.prepare('SELECT uuid FROM product_type_config ORDER BY sort_order').all() as { uuid: string }[];
    check('UUIDs fixos e únicos por tipo', new Set(uuids.map((u) => u.uuid)).size === 7 && uuids[0].uuid === '11111111-1111-4111-8111-111111111111');
  } finally {
    server.close();
    closeDb();
  }

  console.log(failures === 0 ? '\nTipos de produto: TODOS OS TESTES PASSARAM' : `\n${failures} falha(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
