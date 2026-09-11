/**
 * Teste: sugestão de imagens ao cadastrar produto.
 *
 * Cobre a promessa central da funcionalidade:
 *   - Sem a API Key configurada, a busca NÃO chama o Google e cai no sugestor local
 *     (que, sem nuvem/credencial no ambiente de teste, aparece como "indisponível").
 *   - Com a API Key, o Google CSE é consultado e as imagens voltam pela grade, SEMPRE
 *     por um proxy local (`/products/web-image`) — o navegador nunca acessa o host externo.
 *   - O proxy bloqueia SSRF (endereço privado/local).
 *   - A chave some da resposta de status (nunca volta na tela) e pode ser removida.
 *
 * O `fetch` global é interceptado: chamadas ao Google e às imagens externas viram dados
 * de teste; o resto (o próprio servidor local) passa direto.
 *
 * KIVO_DB_PATH TEM que vir do ambiente — este teste recria o banco que usar:
 *   node scripts/test-isolated.js src/tests/product-image-suggest.ts
 */
import fs from 'node:fs';
import path from 'node:path';

import { migrateUp } from '../core/database/migrator';
import { runSeeds } from '../core/database/seeds';
import { createServer } from '../core/server';
import { closeDb } from '../core/database/connection';
import { activateTestLicense } from './resetTestDb';
import { unwrap } from './testUtils';

const PORT = Number(process.env.KIVO_PORT ?? 3827);
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
      '`node scripts/test-isolated.js src/tests/product-image-suggest.ts`.',
    );
  }
  if (path.resolve(alvo) === path.resolve(process.cwd(), 'database', 'kivo.db')) {
    throw new Error('Recusado: KIVO_DB_PATH aponta para o banco de dev.');
  }
  return alvo;
}

const IMAGE_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

/** Endereço público "de mentira" (sem DNS) para as imagens externas do teste. */
const EXT_HOST = '93.184.216.34';

function installFetchMock(): void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | { url: string }, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

    if (url.includes('googleapis.com/customsearch')) {
      return new Response(JSON.stringify({
        items: [
          { title: 'Refrigerante Cola Lata', link: `https://${EXT_HOST}/coca.jpg`, image: { thumbnailLink: `https://${EXT_HOST}/coca-thumb.jpg`, contextLink: 'https://exemplo.com/coca' } },
          { title: 'Refrigerante Lata', link: `https://${EXT_HOST}/refri.jpg`, image: { thumbnailLink: `https://${EXT_HOST}/refri-thumb.jpg` } },
        ],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    if (url.startsWith(`https://${EXT_HOST}/`)) {
      return new Response(IMAGE_BYTES, {
        status: 200,
        headers: { 'Content-Type': 'image/png', 'Content-Length': String(IMAGE_BYTES.length) },
      });
    }

    return original(input as Parameters<typeof fetch>[0], init);
  }) as typeof fetch;
}

interface Suggestion {
  id: number;
  name: string;
  url: string;
  thumb: string;
  source: 'catalog' | 'web';
  srcUrl?: string;
}

async function main(): Promise<void> {
  const TMP_DB = assertBancoDescartavel();
  fs.mkdirSync(path.dirname(TMP_DB), { recursive: true });
  fs.rmSync(TMP_DB, { force: true });

  migrateUp();
  runSeeds();
  activateTestLicense();
  installFetchMock();
  const { app } = await createServer();
  const server = app.listen(PORT);

  try {
    const login = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'admin', password: 'admin' }) });
    const m = (login.headers.get('set-cookie') ?? '').match(/kivo_session=([^;]+)/);
    cookie = m ? `kivo_session=${m[1]}` : '';
    check('login admin', cookie !== '');
    if (!cookie) return;

    // 1. Sem chave: status diz "não configurado", com o cx padrão do usuário.
    const cfg0 = await unwrap<{ configured: boolean; cx: string; defaultCx: string }>(
      await api('/api/settings/image-search-config'),
    );
    check('sem chave, a config aparece como não configurada', cfg0.configured === false);
    check('o cx padrão é o motor criado pelo usuário',
      cfg0.defaultCx === 'a7c7f9a8761d54e79', cfg0.defaultCx);
    check('a resposta de status NÃO devolve a chave',
      !('apiKey' in (cfg0 as unknown as Record<string, unknown>)));

    // 2. Sem chave e sem nuvem → sugestor local vazio e "indisponível".
    const s0 = await unwrap<{ results: Suggestion[]; offline: boolean }>(
      await api('/api/commercial/products/image-search?q=refrigerante'),
    );
    check('sem chave, não busca no Google e a lista fica vazia', s0.results.length === 0);
    check('sem chave e sem nuvem, a tela recebe o aviso de indisponível', s0.offline === true);

    // 3. Salva uma chave falsa; o cx vazio cai no padrão.
    const saved = await unwrap<{ configured: boolean; cx: string }>(
      await api('/api/settings/image-search-config', {
        method: 'PUT', body: JSON.stringify({ apiKey: 'chave-de-teste', cx: '' }),
      }),
    );
    check('salvar a chave marca como configurada', saved.configured === true);
    check('cx vazio usa o padrão', saved.cx === 'a7c7f9a8761d54e79', saved.cx);

    // O botão "Testar busca" devolve quantas imagens voltaram (não colapsa no envelope).
    const tested = await unwrap<{ tested: boolean; count: number }>(
      await api('/api/settings/image-search-config/test', { method: 'POST', body: '{}' }),
    );
    check('o teste da config reporta sucesso e a contagem',
      tested.tested === true && tested.count === 2, JSON.stringify(tested));

    // 4. Com a chave, o Google (mock) alimenta a grade — via proxy local.
    const s1 = await unwrap<{ results: Suggestion[]; offline: boolean }>(
      await api('/api/commercial/products/image-search?q=refrigerante'),
    );
    check('com a chave, as imagens do Google aparecem', s1.results.length === 2, `n=${s1.results.length}`);
    check('as sugestões da web vêm marcadas com source=web',
      s1.results.every((r) => r.source === 'web'));
    check('a URL exibida é o proxy LOCAL, não o host externo',
      s1.results.every((r) => r.url.startsWith('/api/commercial/products/web-image?u=')),
      s1.results[0]?.url);
    check('a URL original é preservada para o aprendizado', !!s1.results[0]?.srcUrl?.includes(EXT_HOST));
    check('a lista respeita o teto de 6 sugestões', s1.results.length <= 6);

    // 5. O proxy devolve os bytes da imagem (mock) e bloqueia SSRF.
    const img = await api(s1.results[0].url);
    check('o proxy de imagem responde 200', img.ok, `status=${img.status}`);
    check('o proxy devolve content-type de imagem',
      (img.headers.get('content-type') ?? '').startsWith('image/png'));
    const imgBuf = Buffer.from(await img.arrayBuffer());
    check('o proxy devolve os bytes da imagem', imgBuf.length === IMAGE_BYTES.length);

    const ssrf = await api(`/api/commercial/products/web-image?u=${encodeURIComponent(`${base}/api/health`)}`);
    check('o proxy recusa endereço local (SSRF)', ssrf.status === 404, `status=${ssrf.status}`);

    // 6. Aprender uma escolha da web não quebra sem nuvem (best-effort).
    const learn = await api('/api/commercial/products/image-web-learn', {
      method: 'POST',
      body: JSON.stringify({ term: 'refrigerante', url: `https://${EXT_HOST}/coca.jpg`, title: 'Coca' }),
    });
    check('registrar a escolha da web responde', learn.ok, `status=${learn.status}`);

    // 7. Remover a chave desliga a busca no Google.
    const removed = await unwrap<{ configured: boolean }>(
      await api('/api/settings/image-search-config', {
        method: 'PUT', body: JSON.stringify({ apiKey: '' }),
      }),
    );
    check('chave em branco remove a configuração', removed.configured === false);
    const s2 = await unwrap<{ results: Suggestion[] }>(
      await api('/api/commercial/products/image-search?q=refrigerante'),
    );
    check('sem chave de novo, o Google não é consultado', s2.results.length === 0);

    // 8. A tela de produtos renderiza a grade de sugestões.
    const pagina = await api('/app/commercial/produtos');
    const html = await pagina.text();
    check('a tela de produtos traz a grade de sugestões automáticas',
      pagina.ok && html.includes('searchCatalogImages') && html.includes('image-web-learn'),
      `status=${pagina.status}`);

    // 9. A tela de Configurações renderiza o painel da API Key (pega typo de EJS antes do lojista).
    const cfgPage = await api('/admin/configuracoes');
    const cfgHtml = await cfgPage.text();
    check('Configurações traz o painel de imagens do Google',
      cfgPage.ok && cfgHtml.includes('Imagens de produtos (Google)') && cfgHtml.includes('saveImageSearchConfig'),
      `status=${cfgPage.status}`);
  } finally {
    server.close();
    closeDb();
  }

  console.log(failures === 0 ? '\nSugestão de imagens: TODOS OS TESTES PASSARAM' : `\n${failures} falha(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
