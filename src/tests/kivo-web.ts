/**
 * Kivo Web — o que roda NESTA máquina: aplicar o comando vindo do celular e conceder/revogar
 * o acesso por link/QR.
 *
 * O transporte (nuvem MySQL, SSE) fica fora daqui de propósito: `applyCommand` foi separado
 * de `drainCommands` justamente para o miolo — resolver uuid, personificar o usuário, chamar
 * `createQuote` — ser testável sem subir Docker. O que este teste protege é a parte que, se
 * quebrar, cria orçamento errado ou no nome da pessoa errada.
 *
 * KIVO_DB_PATH TEM que vir do ambiente (import é hoisted; connection.ts lê a variável antes
 * de qualquer linha deste arquivo rodar):
 *   node scripts/kivo test:kivo-web
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { migrateUp } from '../core/database/migrator';
import { runSeeds } from '../core/database/seeds';
import { createServer } from '../core/server';
import { getSqlite, closeDb } from '../core/database/connection';
import { activateTestLicense } from './resetTestDb';
import { applyCommand } from '../core/sync/commands';
import { impersonate, systemRequest } from '../core/auth/systemContext';
import { revokeRemoteAccess, listRemoteAccess, hashToken } from '../core/remote/service';
import { hashPassword } from '../core/auth/service';
import { canUseWebApp } from '../core/license/plans';

let failures = 0;

function check(label: string, ok: boolean, extra = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures++;
}

function assertBancoDescartavel(): string {
  const alvo = process.env.KIVO_DB_PATH;
  if (!alvo) {
    throw new Error(
      'KIVO_DB_PATH não definida. Este teste APAGA o banco que usar — rode via `node scripts/kivo test:kivo-web`.',
    );
  }
  if (path.resolve(alvo) === path.resolve(process.cwd(), 'database', 'kivo.db')) {
    throw new Error('Recusado: KIVO_DB_PATH aponta para o banco de dev.');
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
  // createServer registra os serviços dos módulos (store.quotes vem daqui) — sem isto o
  // handler do comando não encontraria `createQuote`.
  await createServer();
  const db = getSqlite();

  try {
    // ─── Gate de plano ───────────────────────────────────────────────────────────
    check('Kivo Web é exclusivo do Diamante', canUseWebApp('diamante') === true);
    check('Ouro não libera o Kivo Web', canUseWebApp('ouro') === false);
    check('plano nulo não libera (sem fail-open aqui)', canUseWebApp(null) === false);

    // ─── Cenário base ────────────────────────────────────────────────────────────
    const roleId = (db.prepare("SELECT id FROM roles WHERE slug = 'gerente'").get() as { id: number }).id;
    const userUuid = randomUUID();
    const userId = Number(
      db.prepare(
        `INSERT INTO users (username, name, password_hash, role_id, active, uuid)
         VALUES ('vendedor', 'Vendedor Externo', ?, ?, 1, ?)`,
      ).run(hashPassword('Kivo@2026!'), roleId, userUuid).lastInsertRowid,
    );

    const prodUuid = randomUUID();
    const prodId = Number(
      db.prepare(
        `INSERT INTO products (name, sku, unit, price_cents, cost_cents, track_stock, stock_qty, min_stock, active, product_type, uuid)
         VALUES ('Cadeira Gamer', 'CAD-01', 'un', 90000, 50000, 1, 10, 0, 1, 'fisico', ?)`,
      ).run(prodUuid).lastInsertRowid,
    );
    const custUuid = randomUUID();
    db.prepare(`INSERT INTO customers (name, uuid) VALUES ('Cliente do Celular', ?)`).run(custUuid);

    // ─── Personificação ──────────────────────────────────────────────────────────
    const req = impersonate(userId);
    check('impersonate carrega o usuário com as permissões do cargo',
      !!req && req.user.username === 'vendedor' && req.user.permissions.has('store.quotes.create'));
    check('systemRequest não tem usuário (tarefa da máquina, não de uma pessoa)',
      systemRequest().user === undefined);

    // ─── Comando: orçamento criado pelo celular ──────────────────────────────────
    const cmd = {
      id: 1,
      kind: 'store.quote.create',
      created_by_user_uuid: userUuid,
      payload: {
        items: [{ productUuid: prodUuid, qty: 2 }],
        customerUuid: custUuid,
        validUntil: '2099-12-31',
        notes: 'Pedido pelo celular',
      },
    };
    const out = applyCommand(cmd);
    check('comando de orçamento aplicado', out.ok, out.ok ? '' : out.error);

    if (out.ok) {
      const quoteId = out.result.quoteId as number;
      const quote = db.prepare('SELECT customer_id, total_cents, notes, valid_until FROM quotes WHERE id = ?').get(quoteId) as
        { customer_id: number | null; total_cents: number; notes: string | null; valid_until: string | null };
      check('orçamento gravado com o cliente resolvido por uuid', !!quote.customer_id);
      // 2 × R$900,00: o preço saiu do cadastro local, não de valor mandado pelo celular.
      check('preço veio do catálogo local, não do celular', quote.total_cents === 180000, String(quote.total_cents));
      check('observação e validade preservadas',
        quote.notes === 'Pedido pelo celular' && quote.valid_until === '2099-12-31');

      const item = db.prepare('SELECT product_id, qty FROM quote_items WHERE quote_id = ?').get(quoteId) as
        { product_id: number; qty: number };
      check('item aponta para o produto local certo', item.product_id === prodId && item.qty === 2);

      // O que garante que a trilha não vira "sistema": a auditoria sai no nome de quem pediu.
      const log = db.prepare(
        "SELECT username FROM audit_logs WHERE entity = 'quote' AND entity_id = ? ORDER BY id DESC LIMIT 1",
      ).get(String(quoteId)) as { username: string } | undefined;
      check('auditoria registra o usuário que pediu pelo celular',
        log?.username === 'vendedor', log?.username ?? 'sem log');
    }

    // ─── Falhas previsíveis ──────────────────────────────────────────────────────
    const semProduto = applyCommand({
      ...cmd, id: 2, payload: { items: [{ productUuid: randomUUID(), qty: 1 }] },
    });
    check('produto inexistente → erro legível',
      !semProduto.ok && semProduto.error.includes('não existe mais'),
      semProduto.ok ? 'passou' : semProduto.error);

    const semItens = applyCommand({ ...cmd, id: 3, payload: { items: [] } });
    check('orçamento sem itens → erro', !semItens.ok);

    const tipoDesconhecido = applyCommand({ ...cmd, id: 4, kind: 'store.sale.create' });
    check('comando desconhecido vira erro (não trava a fila para sempre)',
      !tipoDesconhecido.ok && tipoDesconhecido.error.includes('Atualize o sistema'),
      tipoDesconhecido.ok ? 'passou' : tipoDesconhecido.error);

    const usuarioSumido = applyCommand({ ...cmd, id: 5, created_by_user_uuid: randomUUID() });
    check('usuário desconhecido → erro (nunca roda com privilégio de outro)',
      !usuarioSumido.ok && usuarioSumido.error.includes('não existe mais'));

    db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(userId);
    const usuarioInativo = applyCommand({ ...cmd, id: 6 });
    check('usuário desativado no desktop deixa de aplicar comandos', !usuarioInativo.ok);
    db.prepare('UPDATE users SET active = 1 WHERE id = ?').run(userId);

    // ─── Comando: baixa de conta a receber pelo celular ──────────────────────────
    // `payment_methods` é configuração por máquina e não sincroniza: o celular manda o TIPO
    // e o desktop resolve para a forma local. Os casos de recusa vêm antes do sucesso para
    // a conta continuar aberta enquanto são testados.
    const recUuid = randomUUID();
    const recId = Number(
      db.prepare(
        `INSERT INTO receivables (description, customer_id, amount_cents, issue_date, due_date, status, original_amount_cents, uuid)
         VALUES ('Fiado do mês', (SELECT id FROM customers WHERE uuid = ?), 5000, '2026-01-01', '2026-01-31', 'aberta', 5000, ?)`,
      ).run(custUuid, recUuid).lastInsertRowid,
    );
    const receber = {
      id: 10,
      kind: 'finance.receivable.receive',
      created_by_user_uuid: userUuid,
      payload: { receivableUuid: recUuid, methodType: 'pix' },
    };

    // 'convenio' é seedado inativo.
    const recInativo = applyCommand({ ...receber, id: 11, payload: { receivableUuid: recUuid, methodType: 'convenio' } });
    check('forma de pagamento inativa → erro legível',
      !recInativo.ok && recInativo.error.includes('não está ativa'),
      recInativo.ok ? 'passou' : recInativo.error);

    const recPrazo = applyCommand({ ...receber, id: 12, payload: { receivableUuid: recUuid, methodType: 'prazo' } });
    check('"prazo" não liquida conta a receber', !recPrazo.ok);

    const recDinheiro = applyCommand({ ...receber, id: 13, payload: { receivableUuid: recUuid, methodType: 'dinheiro' } });
    check('dinheiro sem caixa aberto → recusa orientando abrir o caixa',
      !recDinheiro.ok && recDinheiro.error.includes('caixa'),
      recDinheiro.ok ? 'passou' : recDinheiro.error);

    const recSumiu = applyCommand({ ...receber, id: 14, payload: { receivableUuid: randomUUID(), methodType: 'pix' } });
    check('conta inexistente → erro legível',
      !recSumiu.ok && recSumiu.error.includes('não existe mais'),
      recSumiu.ok ? 'passou' : recSumiu.error);

    // Cargo sem a permissão: o vendedor não recebe, mesmo pedindo pelo celular.
    const roleVend = (db.prepare("SELECT id FROM roles WHERE slug = 'vendedor'").get() as { id: number }).id;
    const vendUuid = randomUUID();
    db.prepare(
      `INSERT INTO users (username, name, password_hash, role_id, active, uuid)
       VALUES ('vendedor2', 'Vendedor Dois', ?, ?, 1, ?)`,
    ).run(hashPassword('Kivo@2026!'), roleVend, vendUuid);
    const recSemPerm = applyCommand({ ...receber, id: 15, created_by_user_uuid: vendUuid });
    check('cargo sem finance.receivables.receive → recusa',
      !recSemPerm.ok && recSemPerm.error.includes('não permite receber'),
      recSemPerm.ok ? 'passou' : recSemPerm.error);

    // Sucesso: quita o total pela forma resolvida no desktop.
    const outRec = applyCommand({ ...receber, id: 16 });
    check('comando de recebimento aplicado', outRec.ok, outRec.ok ? '' : outRec.error);
    if (outRec.ok) {
      const rec = db
        .prepare('SELECT status, received_cents, settle_payment_method_id FROM receivables WHERE id = ?')
        .get(recId) as { status: string; received_cents: number; settle_payment_method_id: number | null };
      check('conta marcada como recebida pelo valor cheio',
        rec.status === 'recebida' && rec.received_cents === 5000,
        `${rec.status}/${rec.received_cents}`);
      check('forma de pagamento resolvida no desktop (pix)', rec.settle_payment_method_id != null);
      const logRec = db.prepare(
        "SELECT username FROM audit_logs WHERE entity = 'receivable' AND entity_id = ? ORDER BY id DESC LIMIT 1",
      ).get(String(recId)) as { username: string } | undefined;
      check('auditoria do recebimento sai no nome de quem pediu',
        logRec?.username === 'vendedor', logRec?.username ?? 'sem log');
    }

    // ─── Concessão de acesso: o token em claro nunca é guardado ──────────────────
    const token = 'a'.repeat(64);
    db.prepare('INSERT INTO remote_access (user_id, token_hash, uuid) VALUES (?, ?, ?)')
      .run(userId, hashToken(token), randomUUID());

    const guardado = db.prepare('SELECT token_hash FROM remote_access WHERE user_id = ?').get(userId) as { token_hash: string };
    check('guarda o sha256, nunca o token em claro',
      guardado.token_hash !== token && guardado.token_hash === hashToken(token));
    const bruto = fs.readFileSync(TMP_DB);
    check('o token em claro não aparece em lugar nenhum do banco', !bruto.includes(Buffer.from(token)));

    check('acesso aparece na listagem do desktop', listRemoteAccess(userId).length === 1);

    // Sem nuvem configurada no teste, a revogação local ainda precisa valer.
    const rev = await revokeRemoteAccess(req!, userId);
    check('revogar marca revoked_at', rev.ok);
    check('acesso revogado some da lista de ativos',
      listRemoteAccess(userId).every((a) => a.revoked_at !== null));
  } finally {
    closeDb();
  }

  console.log(failures === 0 ? '\nKivo Web: TODOS OS TESTES PASSARAM' : `\n${failures} falha(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
