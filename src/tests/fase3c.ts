/**
 * Teste de extensão da Fase 3/4: PIN de administrador (confirmação de ações críticas
 * no PDV) e relatório completo de fechamento de caixa (imprimível).
 */
import { migrateUp } from '../core/database/migrator';
import { runSeeds } from '../core/database/seeds';
import { createServer } from '../core/server';
import { getSqlite, closeDb } from '../core/database/connection';

const PORT = Number(process.env.KATSU_PORT ?? 3745);
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

    // ---------- PIN de administrador ----------
    const statusBefore = (await (await api('/api/security/pin/status', {}, admin!)).json()) as { configured: boolean };
    check('PIN não configurado inicialmente', statusBefore.configured === false);

    const badPin = await api('/api/security/pin', { method: 'PUT', body: JSON.stringify({ pin: 'abcd' }) }, admin!);
    check('PIN não numérico rejeitado (400)', badPin.status === 400, String(badPin.status));

    const setPin = await api('/api/security/pin', { method: 'PUT', body: JSON.stringify({ pin: '1234' }) }, admin!);
    check('PIN configurado', setPin.status === 200, String(setPin.status));

    const statusAfter = (await (await api('/api/security/pin/status', {}, admin!)).json()) as { configured: boolean };
    check('PIN configurado agora aparece no status', statusAfter.configured === true);

    const verifyWrong = (await (await api('/api/security/pin/verify', { method: 'POST', body: JSON.stringify({ pin: '0000' }) }, admin!)).json()) as { ok: boolean };
    check('PIN errado → ok:false', verifyWrong.ok === false);

    const verifyRight = (await (await api('/api/security/pin/verify', { method: 'POST', body: JSON.stringify({ pin: '1234' }) }, admin!)).json()) as { ok: boolean };
    check('PIN correto → ok:true', verifyRight.ok === true);

    await api('/api/users', { method: 'POST', body: JSON.stringify({ username: 'op3c', name: 'op3c', password: '123456', roleSlug: 'operador' }) }, admin!);
    const op = await loginAs('op3c', '123456');
    check('operador sem permissão não define PIN (403)', (await api('/api/security/pin', { method: 'PUT', body: JSON.stringify({ pin: '5555' }) }, op!)).status === 403);
    // qualquer usuário logado pode TENTAR verificar (é ele quem digita o PIN do gerente)
    const verifyAsOp = (await (await api('/api/security/pin/verify', { method: 'POST', body: JSON.stringify({ pin: '1234' }) }, op!)).json()) as { ok: boolean };
    check('operador pode tentar verificar o PIN (correto → true)', verifyAsOp.ok === true);

    // ---------- Relatório completo de fechamento de caixa ----------
    const prod = (await (
      await api('/api/commercial/products', { method: 'POST', body: JSON.stringify({ name: 'Produto Caixa', priceCents: 2000, initialStock: 50 }) }, admin!)
    ).json()) as { id: number };
    const cust = (await (
      await api('/api/commercial/customers', { method: 'POST', body: JSON.stringify({ name: 'Cliente Caixa' }) }, admin!)
    ).json()) as { id: number };

    const openReg = await api('/api/finance/cash/open', { method: 'POST', body: JSON.stringify({ openingCents: 5000 }) }, admin!);
    check('caixa aberto', openReg.status === 201, String(openReg.status));
    const openBody = (await openReg.json()) as { id: number };

    const saleDinheiro = await api('/api/store/sales', {
      method: 'POST', body: JSON.stringify({ items: [{ productId: prod.id, qty: 2 }], paymentMethod: 'dinheiro', customerId: cust.id }),
    }, admin!);
    check('venda 1 (dinheiro)', saleDinheiro.status === 201, String(saleDinheiro.status));

    const salePix = await api('/api/store/sales', {
      method: 'POST', body: JSON.stringify({ items: [{ productId: prod.id, qty: 3 }], paymentMethod: 'pix' }),
    }, admin!);
    check('venda 2 (pix)', salePix.status === 201, String(salePix.status));

    const closeReg = await api('/api/finance/cash/close', { method: 'POST', body: JSON.stringify({ countedCents: 15000 }) }, admin!);
    check('caixa fechado', closeReg.status === 200, String(closeReg.status));
    const closeBody = (await closeReg.json()) as { id: number };
    check('resposta do fechamento inclui o id do caixa', closeBody.id === openBody.id, JSON.stringify(closeBody));

    const report = (await (await api(`/api/store/reports/cash-register/${openBody.id}`, {}, admin!)).json()) as {
      totals: { vendas: number; total_cents: number };
      byPayment: { payment_method: string; total_cents: number }[];
      sales: { id: number }[];
    };
    check('relatório: 2 vendas', report.totals.vendas === 2, String(report.totals.vendas));
    check('relatório: total 10000 centavos (4000+6000)', report.totals.total_cents === 10000, String(report.totals.total_cents));
    check('relatório: 2 formas de pagamento distintas', report.byPayment.length === 2, JSON.stringify(report.byPayment));
    check('relatório: lista as 2 vendas individualmente', report.sales.length === 2, String(report.sales.length));

    const printPage = await api(`/app/finance/caixa/${openBody.id}/relatorio`, {}, admin!);
    const printHtml = await printPage.text();
    check('página de impressão do relatório renderiza (200)', printPage.status === 200, String(printPage.status));
    check('relatório impresso menciona o total e o cliente', printHtml.includes('Cliente Caixa') && printHtml.includes('100,00'));

    // auditoria cobre PIN
    const actions = new Set((db.prepare('SELECT DISTINCT action FROM audit_logs').all() as { action: string }[]).map((a) => a.action));
    check('auditoria registra PIN definido/confirmado/inválido', actions.has('pin_definido') && actions.has('pin_confirmado') && actions.has('pin_invalido'));
  } finally {
    server.close();
    closeDb();
  }

  console.log(failures === 0 ? '\nFase 3c: TODOS OS TESTES PASSARAM' : `\n${failures} falha(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
