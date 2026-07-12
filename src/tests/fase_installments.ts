/**
 * Teste isolado: parcelamento manual de contas a pagar, rateio automático de pagamento
 * parcial (empurra pra próxima parcela ou cria uma nova), split de forma de pagamento no
 * acerto, e sugestão de valor com multa/juros por atraso.
 */
import { migrateUp } from '../core/database/migrator';
import { runSeeds } from '../core/database/seeds';
import { createServer } from '../core/server';
import { getSqlite, closeDb } from '../core/database/connection';

const PORT = Number(process.env.KATSU_PORT ?? 3761);
const base = `http://localhost:${PORT}`;
let failures = 0;

function check(label: string, ok: boolean, extra = '') {
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
  const m = (r.headers.get('set-cookie') ?? '').match(/katsu_session=([^;]+)/);
  return m ? `katsu_session=${m[1]}` : null;
}

async function main() {
  migrateUp();
  runSeeds();
  const { app } = await createServer();
  const server = app.listen(PORT);
  const db = getSqlite();

  try {
    const admin = await loginAs('admin', 'admin');
    check('login admin', admin !== null);

    // -------- 1. Criar conta parcelada em 5x --------
    const created = (await (
      await api('/api/finance/payables', { method: 'POST', body: JSON.stringify({
        description: 'Consultoria', amountCents: 1_000_000, dueDate: '2026-08-01', installments: 5,
      }) }, admin!)
    ).json()) as { id: number };

    const group = db.prepare(
      `SELECT id, amount_cents, due_date, installment_no, installment_count FROM payables
       WHERE installment_group_id = (SELECT installment_group_id FROM payables WHERE id = ?)
       ORDER BY installment_no`,
    ).all(created.id) as { id: number; amount_cents: number; due_date: string; installment_no: number; installment_count: number }[];

    check('5 parcelas criadas', group.length === 5, String(group.length));
    check('parcela 1 com resto do arredondamento', group[0]?.amount_cents === 200000, String(group[0]?.amount_cents));
    check('parcelas 2-5 com valor base', group.slice(1).every((g) => g.amount_cents === 200000));
    check('vencimentos a cada 30 dias', group.map((g) => g.due_date).join(',') ===
      ['2026-08-01', '2026-08-31', '2026-09-30', '2026-10-30', '2026-11-29'].join(','),
      group.map((g) => g.due_date).join(','));
    check('numeração 1/5..5/5', group.every((g, i) => g.installment_no === i + 1 && g.installment_count === 5));

    // -------- 2. Formas de pagamento ativas --------
    const methods = (await (await api('/api/finance/payment-methods/active', {}, admin!)).json()) as { id: number; name: string; type: string }[];
    const dinheiro = methods.find((m) => m.type === 'dinheiro')!;
    const pix = methods.find((m) => m.type === 'pix')!;
    check('métodos dinheiro e pix disponíveis', !!dinheiro && !!pix);

    // -------- 3. Liquidar parcela 1 pagando só metade (sem caixa aberto, via PIX pra não bloquear) --------
    const settle1 = await api(`/api/finance/payables/${group[0].id}/settle`, {
      method: 'POST', body: JSON.stringify({ payments: [{ paymentMethodId: pix.id, amountCents: 100000 }] }),
    }, admin!);
    check('acerto parcial da parcela 1 (200k) aceito', settle1.status === 200, String(settle1.status));
    const settle1Body = await settle1.json();
    check('rolledOverCents = 100000', settle1Body.rolledOverCents === 100000, JSON.stringify(settle1Body));
    check('rolloverTarget = existing (parcela 2 já existia)', settle1Body.rolloverTarget === 'existing');

    const p1After = db.prepare('SELECT status, amount_cents FROM payables WHERE id = ?').get(group[0].id) as { status: string; amount_cents: number };
    check('parcela 1 fechada no valor pago (100000)', p1After.status === 'paga' && p1After.amount_cents === 100000, JSON.stringify(p1After));
    const p2After = db.prepare('SELECT amount_cents FROM payables WHERE id = ?').get(group[1].id) as { amount_cents: number };
    check('parcela 2 recebeu a diferença (200000+100000=300000)', p2After.amount_cents === 300000, String(p2After.amount_cents));

    // -------- 4. Liquidar a ÚLTIMA parcela (5/5) pagando menos que o devido --------
    const settle5 = await api(`/api/finance/payables/${group[4].id}/settle`, {
      method: 'POST', body: JSON.stringify({ payments: [{ paymentMethodId: pix.id, amountCents: 50000 }] }),
    }, admin!);
    check('acerto parcial da última parcela aceito', settle5.status === 200, String(settle5.status));
    const settle5Body = await settle5.json();
    check('rolloverTarget = new (não havia parcela 6)', settle5Body.rolloverTarget === 'new', JSON.stringify(settle5Body));

    const newInstallment = db.prepare(
      `SELECT id, installment_no, installment_count, amount_cents FROM payables
       WHERE installment_group_id = (SELECT installment_group_id FROM payables WHERE id = ?) AND installment_no = 6`,
    ).get(group[0].id) as { id: number; installment_no: number; installment_count: number; amount_cents: number } | undefined;
    check('parcela 6/6 criada com o shortfall (150000)', !!newInstallment && newInstallment.amount_cents === 150000, JSON.stringify(newInstallment));

    const allSix = db.prepare(
      `SELECT installment_count FROM payables WHERE installment_group_id = (SELECT installment_group_id FROM payables WHERE id = ?)`,
    ).all(group[0].id) as { installment_count: number }[];
    check('todas as 6 parcelas resincronizadas com installment_count = 6', allSix.every((r) => r.installment_count === 6), JSON.stringify(allSix));

    // -------- 5. Split payment (dinheiro + pix) sem caixa aberto --------
    const other = (await (
      await api('/api/finance/payables', { method: 'POST', body: JSON.stringify({
        description: 'Aluguel', amountCents: 300000, dueDate: '2026-07-01',
      }) }, admin!)
    ).json()) as { id: number };

    const blocked = await api(`/api/finance/payables/${other.id}/settle`, {
      method: 'POST', body: JSON.stringify({ payments: [
        { paymentMethodId: dinheiro.id, amountCents: 150000 },
        { paymentMethodId: pix.id, amountCents: 150000 },
      ] }),
    }, admin!);
    const blockedBody = await blocked.json();
    check('bloqueia split com parte em dinheiro sem caixa aberto', blocked.status === 400 && blockedBody.code === 'no_register', JSON.stringify(blockedBody));

    // Abrir caixa e repetir
    const openReg = await api('/api/finance/cash/open', { method: 'POST', body: JSON.stringify({ openingCents: 10000 }) }, admin!);
    check('caixa aberto', openReg.status === 201, String(openReg.status));

    const splitOk = await api(`/api/finance/payables/${other.id}/settle`, {
      method: 'POST', body: JSON.stringify({ payments: [
        { paymentMethodId: dinheiro.id, amountCents: 150000 },
        { paymentMethodId: pix.id, amountCents: 150000 },
      ] }),
    }, admin!);
    const splitOkBody = await splitOk.json();
    check('split aceito com caixa aberto', splitOk.status === 200 && splitOkBody.registeredInCash === true, JSON.stringify(splitOkBody));

    const settlePays = db.prepare('SELECT payment_method_id, amount_cents FROM bill_settlement_payments WHERE entity = ? AND bill_id = ?').all('payable', other.id) as { payment_method_id: number; amount_cents: number }[];
    check('2 linhas em bill_settlement_payments', settlePays.length === 2, String(settlePays.length));

    const movement = db.prepare("SELECT amount_cents FROM cash_movements WHERE ref_entity = 'payable' AND ref_id = ?").get(other.id) as { amount_cents: number } | undefined;
    check('só a parte em dinheiro (150000) entrou no movimento de caixa', movement?.amount_cents === 150000, String(movement?.amount_cents));

    // -------- 6. Multa/juros configurados --------
    db.prepare(`INSERT INTO settings (key, value, uuid) VALUES ('financeiro.multa_atraso.ativa', '1', 'x1')
      ON CONFLICT(key) DO UPDATE SET value = '1', deleted_at = NULL`).run();
    db.prepare(`INSERT INTO settings (key, value, uuid) VALUES ('financeiro.multa_atraso.percentual', '2', 'x2')
      ON CONFLICT(key) DO UPDATE SET value = '2', deleted_at = NULL`).run();
    db.prepare(`INSERT INTO settings (key, value, uuid) VALUES ('financeiro.juros_atraso.ativo', '1', 'x3')
      ON CONFLICT(key) DO UPDATE SET value = '1', deleted_at = NULL`).run();
    db.prepare(`INSERT INTO settings (key, value, uuid) VALUES ('financeiro.juros_atraso.percentual_dia', '0.033', 'x4')
      ON CONFLICT(key) DO UPDATE SET value = '0.033', deleted_at = NULL`).run();

    const overdue = (await (
      await api('/api/finance/payables', { method: 'POST', body: JSON.stringify({
        description: 'Conta vencida', amountCents: 100000, dueDate: '2026-07-02', issueDate: '2026-07-02',
      }) }, admin!)
    ).json()) as { id: number };
    // due_date 2026-07-02, "hoje" é 2026-07-12 no ambiente real, mas o servidor de teste roda com a data real do sistema.
    const list = (await (await api('/api/finance/payables', {}, admin!)).json()) as
      { id: number; diasAtraso?: number; lateMultaCents?: number; lateJurosCents?: number; suggestedSettleCents?: number }[];
    const overdueRow = list.find((r) => r.id === overdue.id)!;
    check('diasAtraso > 0 calculado', (overdueRow.diasAtraso ?? 0) > 0, String(overdueRow.diasAtraso));
    const dias = overdueRow.diasAtraso ?? 0;
    const expectedMulta = Math.round(100000 * 0.02);
    const expectedJuros = Math.round(100000 * (0.033 / 100) * dias);
    check('multa calculada (2%)', overdueRow.lateMultaCents === expectedMulta, `${overdueRow.lateMultaCents} vs ${expectedMulta}`);
    check('juros calculado (0,033%/dia)', overdueRow.lateJurosCents === expectedJuros, `${overdueRow.lateJurosCents} vs ${expectedJuros}`);
    check('suggestedSettleCents = base + multa + juros', overdueRow.suggestedSettleCents === 100000 + expectedMulta + expectedJuros,
      `${overdueRow.suggestedSettleCents} vs ${100000 + expectedMulta + expectedJuros}`);
  } finally {
    server.close();
    closeDb();
  }

  console.log(failures === 0 ? '\nTODOS OS TESTES PASSARAM' : `\n${failures} falha(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
