/**
 * Teste de integração do fluxo de variantes PELAS ROTAS — o caminho que a tela de cadastro
 * percorre de verdade. `fase_variants.ts` cobre o modelo com SQL direto e por isso não pegou
 * a regressão que motivou este arquivo: pela interface, criar um produto variável não
 * produzia nada vendável (atributo sem valor + erro de API engolido), e o PDV ficava vazio
 * enquanto a importação "funcionava" — porque a importação grava as filhas direto.
 *
 * KIVO_DB_PATH TEM que vir do ambiente (mesmo motivo de products-import-api.ts: `import` é
 * hoisted e connection.ts lê a variável antes de qualquer linha deste arquivo rodar):
 *   node scripts/kivo test:variantes-api    ← use o comando
 */
import fs from 'node:fs';
import path from 'node:path';

import { migrateUp } from '../core/database/migrator';
import { runSeeds } from '../core/database/seeds';
import { createServer } from '../core/server';
import { getSqlite, closeDb } from '../core/database/connection';
import { activateTestLicense } from './resetTestDb';
import { unwrap } from './testUtils';

const PORT = Number(process.env.KIVO_PORT ?? 3712);
const base = `http://localhost:${PORT}`;
let failures = 0;

function check(label: string, ok: boolean, extra = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures++;
}

function assertBancoDescartavel(): string {
  const alvo = process.env.KIVO_DB_PATH;
  if (!alvo) {
    throw new Error(
      'KIVO_DB_PATH não definida. Este teste APAGA o banco que usar — rode via ' +
      '`node scripts/kivo test:variantes-api`, que aponta para um arquivo temporário.',
    );
  }
  const devDb = path.resolve(process.cwd(), 'database', 'kivo.db');
  if (path.resolve(alvo) === devDb) {
    throw new Error(`Recusado: KIVO_DB_PATH aponta para o banco de dev (${devDb}).`);
  }
  return alvo;
}

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

  let cookie = '';
  const api = (p: string, opts: RequestInit = {}) =>
    fetch(`${base}${p}`, {
      ...opts,
      headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}), ...(opts.headers ?? {}) },
    });
  const post = (p: string, b: unknown) => api(p, { method: 'POST', body: JSON.stringify(b) });

  const setCapability = (on: boolean) =>
    db.prepare("UPDATE capabilities SET enabled = ? WHERE key = 'commercial.variantes'").run(on ? 1 : 0);

  try {
    const login = await post('/api/auth/login', { username: 'admin', password: 'admin' });
    const m = (login.headers.get('set-cookie') ?? '').match(/kivo_session=([^;]+)/);
    cookie = m ? `kivo_session=${m[1]}` : '';
    check('login admin', !!cookie);
    if (!cookie) return;

    // ── 1. Capability desligada: o produto-pai não pode nem ser criado ──────────────
    // Antes ele era criado normalmente e o usuário ficava preso: as telas de atributo e de
    // geração respondiam 403, e o produto nunca chegava ao PDV.
    setCapability(false);
    const negado = await post('/api/commercial/products', { name: 'Sofá', productType: 'variante', priceCents: 100 });
    const negadoBody = (await negado.json().catch(() => ({}))) as { error?: string };
    check('POST /products variante com capability desligada → 403', negado.status === 403, String(negado.status));
    check('erro no formato que a tela reconhece para oferecer "Ativar agora"',
      /^Recurso desativado: commercial\.variantes$/.test(negadoBody.error ?? ''), negadoBody.error ?? '');

    const simples = await post('/api/commercial/products', { name: 'Caneta', productType: 'fisico', priceCents: 500 });
    check('produto simples não é afetado pela capability de variantes', simples.status === 201, String(simples.status));

    // ── 2. Capability ligada: fluxo completo da tela ────────────────────────────────
    setCapability(true);
    const paiRes = await post('/api/commercial/products', {
      name: 'Sofá Retrátil', productType: 'variante', priceCents: 160000, sku: 'SOF-001',
    });
    const pai = await unwrap<{ id: number }>(paiRes);
    check('produto-pai criado com a capability ligada', paiRes.status === 201, String(paiRes.status));

    // O produto-pai NÃO é vendável — é o comportamento correto, e é o que o aviso na tela
    // de cadastro passou a explicar em vez de deixar o operador achando que sumiu.
    const vendaveis1 = await unwrap<{ id: number }[]>(await api('/api/commercial/products?scope=sellable'));
    check('produto-pai sem variantes não aparece no PDV',
      !vendaveis1.some((p) => p.id === pai.id), JSON.stringify(vendaveis1.map((p) => p.id)));

    // ── 3. Atributo SEM valores: o estado que gerava "Cadastre um atributo primeiro" ──
    const attrRes = await post('/api/commercial/attributes', { name: 'Densidade' });
    const attr = await unwrap<{ id: number }>(attrRes);
    check('atributo criado', attrRes.status === 201, String(attrRes.status));

    const listaAttrs = await unwrap<{ id: number; name: string }[]>(await api('/api/commercial/attributes'));
    const valoresVazios = await unwrap<unknown[]>(await api(`/api/commercial/attributes/${attr.id}/values`));
    // A tela distingue os dois: atributo existe (lista não vazia) mas sem valores. Antes os
    // dois casos caíam na mesma mensagem, que dizia para cadastrar o atributo já cadastrado.
    check('atributo aparece na listagem mesmo sem valores', listaAttrs.length === 1, String(listaAttrs.length));
    check('atributo sem valores devolve lista vazia (não erro)', valoresVazios.length === 0);

    // ── 4. Valores + geração ────────────────────────────────────────────────────────
    const leve = await unwrap<{ id: number }>(await post(`/api/commercial/attributes/${attr.id}/values`, { value: 'Leve' }));
    const pesada = await unwrap<{ id: number }>(await post(`/api/commercial/attributes/${attr.id}/values`, { value: 'Média Alta' }));
    check('dois valores cadastrados', !!leve.id && !!pesada.id);

    const genRes = await post(`/api/commercial/products/${pai.id}/attributes/generate-variants`, {
      attributeValueIds: [leve.id, pesada.id],
    });
    const gen = await unwrap<{ created: number[]; skipped: number[] }>(genRes);
    check('geração responde 201', genRes.status === 201, String(genRes.status));
    check('2 variantes criadas', gen.created.length === 2, JSON.stringify(gen));

    const filhas = db.prepare(
      'SELECT id, name, sku FROM products WHERE parent_product_id = ? AND deleted_at IS NULL ORDER BY id',
    ).all(pai.id) as { id: number; name: string; sku: string | null }[];
    check('filhas gravadas com parent_product_id', filhas.length === 2, String(filhas.length));
    // SKU derivado do pai: sem ele a variante só era achada no PDV digitando o nome.
    check('SKU da filha deriva do SKU do pai', filhas[0].sku === 'SOF-001-LEVE', String(filhas[0].sku));
    check('SKU normaliza acento e espaço', filhas[1].sku === 'SOF-001-MEDIAALTA', String(filhas[1].sku));

    // ── 5. Agora sim o PDV enxerga — o pai continua fora ────────────────────────────
    const vendaveis2 = await unwrap<{ id: number }[]>(await api('/api/commercial/products?scope=sellable'));
    const ids = vendaveis2.map((p) => p.id);
    check('as 2 variantes aparecem no PDV', filhas.every((f) => ids.includes(f.id)), JSON.stringify(ids));
    check('o produto-pai continua fora do PDV', !ids.includes(pai.id));

    const busca = await unwrap<{ id: number }[]>(await api('/api/commercial/products?q=Sof%C3%A1'));
    check('busca por nome traz as variantes, não o pai',
      busca.length === 2 && !busca.some((p) => p.id === pai.id), JSON.stringify(busca.map((p) => p.id)));

    // ── 6. Gerar de novo não duplica ────────────────────────────────────────────────
    const gen2 = await unwrap<{ created: number[]; skipped: number[] }>(
      await post(`/api/commercial/products/${pai.id}/attributes/generate-variants`, {
        attributeValueIds: [leve.id, pesada.id],
      }),
    );
    check('regerar pula as combinações existentes', gen2.created.length === 0 && gen2.skipped.length === 2,
      JSON.stringify(gen2));
  } finally {
    server.close();
    closeDb();
  }

  console.log(failures === 0 ? '\nVariantes (API): TODOS OS TESTES PASSARAM' : `\n${failures} falha(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
