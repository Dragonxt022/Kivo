/**
 * Teste das telas de IMPRESSÃO (cupom, orçamento, carnê, relatório de caixa, DRE): elas
 * renderizam e o dinheiro sai formatado.
 *
 * Existe porque essas cinco views eram o único canto do sistema sem cobertura nenhuma —
 * e foi exatamente onde a formatação de dinheiro divergiu sem ninguém notar: cada uma
 * carregava a própria cópia de `brl()`, e a do cupom tinha perdido o separador de milhar,
 * imprimindo "R$ 1234,56" onde o relatório de caixa imprimia "R$ 1.234,56". Agora todas
 * usam `app.locals.brl` (shared/money) e este teste é o que impede a divergência de
 * voltar — incluindo quebrar se alguém remover o helper e deixar `brl is not defined`
 * numa tela que só é vista na hora de imprimir para o cliente.
 *
 * KIVO_DB_PATH TEM que vir do ambiente (`import` é hoisted e connection.ts lê a variável
 * antes de qualquer linha daqui rodar):
 *   node scripts/kivo test:impressao    ← use o comando
 */
import fs from 'node:fs';
import path from 'node:path';

import { migrateUp } from '../core/database/migrator';
import { runSeeds } from '../core/database/seeds';
import { seedDemoData } from '../core/database/seedDemo';
import { createServer } from '../core/server';
import { getSqlite, closeDb } from '../core/database/connection';
import { activateTestLicense } from './resetTestDb';

const PORT = Number(process.env.KIVO_PORT ?? 3841);
const base = `http://localhost:${PORT}`;

/** "R$ 1.234,56" / "R$ 0,05" — o formato de shared/money.formatBRL. */
const MOEDA = /-?R\$ \d{1,3}(\.\d{3})*,\d{2}/;
/** Valor acima de mil COM separador de milhar — o que o cupom tinha perdido. */
const MILHAR = /R\$ \d{1,3}\.\d{3},\d{2}/;
/** "R$ 1234,56": milhar sem ponto, a regressão que este teste existe para pegar. */
const MILHAR_SEM_PONTO = /R\$ \d{4,},\d{2}/;

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
      '`node scripts/kivo test:impressao`, que aponta para um arquivo temporário.',
    );
  }
  const devDb = path.resolve(process.cwd(), 'database', 'kivo.db');
  if (path.resolve(alvo) === devDb) {
    throw new Error(`Recusado: KIVO_DB_PATH aponta para o banco de dev (${devDb}).`);
  }
  return alvo;
}

function conferirHtml(nome: string, html: string): void {
  check(
    `${nome}: sem erro de template`,
    !/brl is not (a function|defined)|ReferenceError/.test(html),
  );
  const achado = html.match(MOEDA);
  check(`${nome}: imprime valor em R$`, !!achado, achado?.[0] ?? 'nenhum valor R$ na página');
  const semPonto = html.match(MILHAR_SEM_PONTO);
  check(
    `${nome}: milhar com separador`,
    !semPonto,
    semPonto ? `formatado sem ponto: ${semPonto[0]}` : '',
  );
}

async function main(): Promise<void> {
  const TMP_DB = assertBancoDescartavel();
  fs.mkdirSync(path.dirname(TMP_DB), { recursive: true });
  fs.rmSync(TMP_DB, { force: true });

  migrateUp();
  runSeeds();
  activateTestLicense();

  const { app } = await createServer();
  seedDemoData(); // depois de createServer: precisa dos serviços dos módulos registrados
  const server = app.listen(PORT);

  try {
    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin' }),
    });
    check('login admin', login.status === 200, String(login.status));
    const cookie = login.headers.get('set-cookie')?.split(';')[0] ?? '';

    const db = getSqlite();
    const venda = db
      .prepare('SELECT id FROM sales WHERE deleted_at IS NULL ORDER BY id DESC LIMIT 1')
      .get() as { id: number } | undefined;
    const caixa = db
      .prepare('SELECT id FROM cash_registers ORDER BY id DESC LIMIT 1')
      .get() as { id: number } | undefined;

    check('seed de demonstração criou venda', !!venda);
    check('seed de demonstração criou caixa', !!caixa);

    const rotas: { nome: string; url: string }[] = [];
    if (venda) rotas.push({ nome: 'cupom da venda', url: `/app/store/vendas/${venda.id}/cupom` });
    if (caixa) rotas.push({ nome: 'relatório de caixa', url: `/app/finance/caixa/${caixa.id}/relatorio` });
    rotas.push({ nome: 'DRE impresso', url: '/app/dre/relatorio/imprimir?from=2026-01-01&to=2099-12-31' });

    for (const r of rotas) {
      const resp = await fetch(base + r.url, { headers: { cookie } });
      check(`${r.nome}: HTTP 200`, resp.status === 200, String(resp.status));
      conferirHtml(r.nome, await resp.text());
    }

    // Orçamento e carnê a seed de demonstração não cria. Renderiza direto, com dados
    // mínimos: o que interessa aqui é o helper de dinheiro chegar na view, não o caminho
    // HTTP (que é o mesmo `res.render` das outras).
    const diretos = [
      {
        nome: 'orçamento impresso',
        view: 'store-quote-print',
        locals: {
          quote: {
            id: 1, created_at: '2026-08-01 10:00:00', customer: 'Cliente Teste',
            subtotal_cents: 123456, discount_cents: 1000, total_cents: 122456,
            status: 'aberto', valid_until: '2026-09-01',
          },
          items: [{ product_name: 'Produto', qty: 2, unit_price_cents: 61728, total_cents: 123456 }],
          company: { name: 'Loja Teste' },
        },
      },
      {
        nome: 'carnê impresso',
        view: 'store-carne-print',
        locals: {
          sale: { id: 1, created_at: '2026-08-01 10:00:00', customer: 'Cliente Teste', total_cents: 250000 },
          installments: [
            { n: 1, amount_cents: 125000, due_date: '2026-09-01' },
            { n: 2, amount_cents: 125000, due_date: '2026-10-01' },
          ],
          company: { name: 'Loja Teste' },
        },
      },
    ];

    for (const d of diretos) {
      const html = await new Promise<string>((resolve, reject) => {
        app.render(d.view, d.locals, (err, out) => (err ? reject(err) : resolve(out)));
      }).catch((e: unknown) => {
        check(`${d.nome}: renderiza sem erro`, false, String(e).slice(0, 200));
        return '';
      });
      if (!html) continue;
      check(`${d.nome}: renderiza sem erro`, true);
      conferirHtml(d.nome, html);
      check(`${d.nome}: milhar formatado`, MILHAR.test(html), html.match(MILHAR)?.[0] ?? 'sem valor > mil');
    }
  } finally {
    server.close();
    closeDb();
  }

  console.log(
    failures === 0 ? '\nImpressão: TODOS OS TESTES PASSARAM' : `\n${failures} falha(s)`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
