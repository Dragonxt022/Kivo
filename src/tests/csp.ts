/**
 * Teste da Content-Security-Policy: o cabeçalho sai em toda página e TODA tag <script>
 * carrega o nonce daquela resposta.
 *
 * A CSP tinha ficado desligada em `helmet({ contentSecurityPolicy: false })` com um
 * comentário justificando por causa do Alpine vindo de CDN — coisa que deixou de ser
 * verdade quando o Alpine passou a ser servido local. Ao ligar de volta, o risco deixa de
 * ser "XSS passa" e vira "uma tela para de funcionar em silêncio": um `<script>` sem
 * nonce é recusado pelo navegador sem erro visível no servidor, e só quem abrir aquela
 * tela específica descobre. Este teste varre TODAS as páginas e falha antes disso.
 *
 * KIVO_DB_PATH TEM que vir do ambiente (`import` é hoisted e connection.ts lê a variável
 * antes de qualquer linha daqui rodar):
 *   node scripts/kivo test:csp    ← use o comando
 */
import fs from 'node:fs';
import path from 'node:path';

import { migrateUp } from '../core/database/migrator';
import { runSeeds } from '../core/database/seeds';
import { createServer } from '../core/server';
import { closeDb } from '../core/database/connection';
import { activateTestLicense } from './resetTestDb';

const PORT = Number(process.env.KIVO_PORT ?? 3843);
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
      '`node scripts/kivo test:csp`, que aponta para um arquivo temporário.',
    );
  }
  const devDb = path.resolve(process.cwd(), 'database', 'kivo.db');
  if (path.resolve(alvo) === devDb) {
    throw new Error(`Recusado: KIVO_DB_PATH aponta para o banco de dev (${devDb}).`);
  }
  return alvo;
}

/** Toda página do app que o navegador abre com sessão de administrador. */
const PAGINAS = [
  '/',
  '/notificacoes',
  '/admin/usuarios',
  '/admin/cargos',
  '/admin/auditoria',
  '/admin/backup',
  '/admin/configuracoes',
  '/admin/cobrancas',
  '/admin/recursos',
  '/app/commercial/produtos',
  '/app/commercial/categorias',
  '/app/commercial/clientes',
  '/app/commercial/fornecedores',
  '/app/commercial/compras',
  '/app/commercial/listas-de-preco',
  '/app/store/pdv',
  '/app/store/vendas',
  '/app/store/orcamentos',
  '/app/finance/caixa',
  '/app/finance/pagar',
  '/app/finance/receber',
  '/app/finance/fluxo',
  '/app/finance/formas-pagamento',
  '/app/finance/convenios',
  '/app/finance/reconciliacao',
  '/app/dre/relatorio',
  '/app/dre/categorias',
  '/app/comandas/mesas',
  '/app/foodservice/cozinha',
  '/app/foodservice/roteamento',
];

/** Tags de abertura de <script>, com os atributos que vierem. */
const TAG_SCRIPT = /<script\b([^>]*)>/gi;

async function main(): Promise<void> {
  const TMP_DB = assertBancoDescartavel();
  fs.mkdirSync(path.dirname(TMP_DB), { recursive: true });
  fs.rmSync(TMP_DB, { force: true });

  migrateUp();
  runSeeds();
  activateTestLicense();

  const { app } = await createServer();
  const server = app.listen(PORT);

  try {
    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin' }),
    });
    check('login admin', login.status === 200, String(login.status));
    const cookie = login.headers.get('set-cookie')?.split(';')[0] ?? '';

    // ── 1. O cabeçalho existe e traz as diretivas que interessam ──────────────
    const home = await fetch(base + '/', { headers: { cookie } });
    const csp = home.headers.get('content-security-policy') ?? '';
    check('cabeçalho Content-Security-Policy presente', !!csp, csp.slice(0, 80));
    check("script-src recusa host externo (tem 'self')", /script-src[^;]*'self'/.test(csp));
    check('script-src usa nonce', /script-src[^;]*'nonce-/.test(csp));
    check("connect-src limitado a 'self'", /connect-src\s+'self'/.test(csp));
    check("object-src 'none'", /object-src\s+'none'/.test(csp));
    check("frame-ancestors 'none'", /frame-ancestors\s+'none'/.test(csp));
    check(
      'nonce muda a cada resposta',
      await (async () => {
        const outra = await fetch(base + '/', { headers: { cookie } });
        const a = /'nonce-([^']+)'/.exec(csp)?.[1];
        const b = /'nonce-([^']+)'/.exec(outra.headers.get('content-security-policy') ?? '')?.[1];
        return !!a && !!b && a !== b;
      })(),
    );

    // ── 2. Toda tag <script> de toda página carrega o nonce da resposta ───────
    let paginasOk = 0;
    for (const url of PAGINAS) {
      const resp = await fetch(base + url, { headers: { cookie } });
      if (resp.status !== 200) {
        check(`${url}: HTTP 200`, false, String(resp.status));
        continue;
      }
      const html = await resp.text();
      const nonce = /'nonce-([^']+)'/.exec(resp.headers.get('content-security-policy') ?? '')?.[1];
      if (!nonce) {
        check(`${url}: resposta traz nonce`, false);
        continue;
      }

      const semNonce: string[] = [];
      for (const m of html.matchAll(TAG_SCRIPT)) {
        const attrs = m[1];
        if (!attrs.includes(`nonce="${nonce}"`)) semNonce.push(`<script${attrs}>`.slice(0, 90));
      }
      if (semNonce.length) {
        check(
          `${url}: todo <script> com nonce`,
          false,
          `${semNonce.length} sem nonce — o navegador NÃO executaria: ${semNonce[0]}`,
        );
      } else {
        paginasOk++;
      }
    }
    check(
      `todas as ${PAGINAS.length} páginas com <script> carimbado`,
      paginasOk === PAGINAS.length,
      `${paginasOk}/${PAGINAS.length}`,
    );
  } finally {
    server.close();
    closeDb();
  }

  console.log(failures === 0 ? '\nCSP: TODOS OS TESTES PASSARAM' : `\n${failures} falha(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
