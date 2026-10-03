/**
 * Teste de integração do plano de tratamento (PR §11) e da cobrança no financeiro (PR §12).
 *
 * O que a PR exige e este teste prova:
 *
 *  §11 — item com procedimento, dente, descrição, valor, quantidade, profissional e situação;
 *        plano com as seis situações (planejado, apresentado, aprovado, em andamento, concluído,
 *        cancelado).
 *  §12 — plano aprovado gera COBRANÇA no financeiro existente, com parcelamento. "Não criar um
 *        segundo financeiro": o teste confere que as contas aparecem na tabela `receivables` do
 *        módulo financeiro (do cliente que ancora o paciente), com número de parcela, e que o
 *        Odonto não guardou dinheiro nenhum em tabela própria.
 *
 * KIVO_DB_PATH TEM que vir do ambiente — rode com
 *   node scripts/test-isolated.js src/tests/odonto-planos.ts
 */
import { migrateUp } from '../core/database/migrator';
import { runSeeds } from '../core/database/seeds';
import { getSqlite } from '../core/database/connection';
import { createServer } from '../core/server';
import { resetTestDb, activateTestLicense } from './resetTestDb';
import { unwrap } from './testUtils';
import { vencimentosParcelas } from '../modules/odonto/treatmentPlans';

const PORT = Number(process.env.KIVO_PORT ?? 3849);
const base = `http://localhost:${PORT}`;
const O = '/api/odonto';

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

interface PlanItem {
  id: number; procedure_id: number | null; procedure_name: string | null; tooth: string | null;
  description: string; amount_cents: number; quantity: number; total_cents: number;
  professional_id: number | null; professional_name: string | null; status: string;
}
interface Plan {
  id: number; patient_id: number; patient_name: string; status: string; title: string | null;
  professional_name: string | null; professional_cro: string | null;
  total_cents: number; items_count: number; items?: PlanItem[];
  approved_at: string | null; charged_at: string | null; installments: number | null;
  first_due_date: string | null; cancelled_at: string | null; cancel_reason: string | null;
}
interface Receivable {
  id: number; description: string; customer_id: number | null; amount_cents: number;
  due_date: string; status: string; installment_no: number | null; installment_count: number | null;
  notes: string | null;
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
    check('sem login → 401', (await api(`${O}/patients/1/treatment-plans`)).status === 401);

    // ── Unidade: vencimentos das parcelas ─────────────────────────────────
    check('parcelas mensais no mesmo dia',
      vencimentosParcelas('2026-11-15', 3).join(',') === '2026-11-15,2026-12-15,2027-01-15',
      vencimentosParcelas('2026-11-15', 3).join(','));
    check('dia 31 cai no fim do mês (fev = 28)',
      vencimentosParcelas('2026-01-31', 3).join(',') === '2026-01-31,2026-02-28,2026-03-31',
      vencimentosParcelas('2026-01-31', 3).join(','));

    // ── Base ──────────────────────────────────────────────────────────────
    const paciente = (await unwrap<{ id: number }>(await api(`${O}/patients`, {
      method: 'POST', body: JSON.stringify({ name: 'Dona Helena Plano (teste)', phone: '(69) 96666-0000' }),
    }, admin!)));
    // O cliente que ancora o paciente (é para ele que a cobrança vai) não vem na resposta da API.
    const clienteDoPaciente = db.prepare('SELECT customer_id FROM odonto_patients WHERE id = ?')
      .get(paciente.id) as { customer_id: number | null };
    const dentista = (await unwrap<{ id: number }>(await api(`${O}/professionals`, {
      method: 'POST', body: JSON.stringify({ name: 'Dra. Paula (teste)', cro: '44556', cro_state: 'MT' }),
    }, admin!))).id;
    const canal = (await unwrap<{ id: number }>(await api(`${O}/procedures`, {
      method: 'POST', body: JSON.stringify({ name: 'Tratamento de canal (teste)', duration_min: 90, default_price_cents: 90000 }),
    }, admin!))).id;
    const coroa = (await unwrap<{ id: number }>(await api(`${O}/procedures`, {
      method: 'POST', body: JSON.stringify({ name: 'Coroa de porcelana (teste)', duration_min: 60, default_price_cents: 120000 }),
    }, admin!))).id;
    check('base criada', paciente.id > 0 && !!clienteDoPaciente.customer_id && dentista > 0,
      `paciente=${paciente.id} cliente=${clienteDoPaciente.customer_id}`);

    // ── Criação do plano (PR §11) ─────────────────────────────────────────
    const criar = (corpo: Record<string, unknown>) => api(`${O}/patients/${paciente.id}/treatment-plans`, {
      method: 'POST', body: JSON.stringify(corpo),
    }, admin!);

    const criado = await criar({
      title: 'Reabilitação 26',
      professional_id: dentista,
      items: [
        { procedure_id: canal, tooth: '26', description: 'Tratamento de canal', amount_cents: 90000, quantity: 1, professional_id: dentista },
        { procedure_id: coroa, tooth: '26', description: 'Coroa de porcelana', amount_cents: 120000, quantity: 1 },
        { description: 'Radiografia periapical', amount_cents: 5000, quantity: 3, tooth: '26' },
      ],
    });
    check('plano criado (201)', criado.status === 201, String(criado.status));
    const plano = await unwrap<Plan>(criado);
    check('plano nasce como planejado', plano.status === 'planejado', plano.status);
    check('itens gravados com nome do procedimento do catálogo',
      plano.items?.[0]?.procedure_name === 'Tratamento de canal (teste)', String(plano.items?.[0]?.procedure_name));
    check('item guarda dente, valor, quantidade e profissional',
      plano.items?.[0]?.tooth === '26' && plano.items?.[0]?.amount_cents === 90000
      && plano.items?.[0]?.quantity === 1 && plano.items?.[0]?.professional_name === 'Dra. Paula (teste)',
      JSON.stringify(plano.items?.[0]));
    check('total soma valor x quantidade',
      plano.total_cents === 90000 + 120000 + 15000, String(plano.total_cents));
    check('total do item multiplica a quantidade', plano.items?.[2]?.total_cents === 15000, String(plano.items?.[2]?.total_cents));
    check('plano guarda o CRO de quem assinou', plano.professional_cro === '44556/MT', String(plano.professional_cro));
    check('plano conta os itens', plano.items_count === 3, String(plano.items_count));

    // ── Validações do plano e dos itens ───────────────────────────────────
    check('plano sem item → 400', (await criar({ title: 'Vazio' })).status === 400);
    check('item sem descrição → 400',
      (await criar({ items: [{ amount_cents: 100 }] })).status === 400);
    check('dente fora da FDI → 400',
      (await criar({ items: [{ description: 'X', tooth: '99' }] })).status === 400);
    check('procedimento inexistente → 400',
      (await criar({ items: [{ description: 'X', procedure_id: 99999 }] })).status === 400);
    check('valor negativo → 400',
      (await criar({ items: [{ description: 'X', amount_cents: -100 }] })).status === 400);
    check('quantidade zero → 400',
      (await criar({ items: [{ description: 'X', quantity: 0 }] })).status === 400);
    check('profissional inexistente no plano → 400',
      (await criar({ professional_id: 4242, items: [{ description: 'X' }] })).status === 400);
    check('paciente inexistente → 404',
      (await api(`${O}/patients/9999/treatment-plans`, { method: 'POST', body: JSON.stringify({ items: [{ description: 'X' }] }) }, admin!)).status === 404);

    // ── Edição: a lista de itens vem completa ─────────────────────────────
    const itemCanal = plano.items!.find((i) => i.procedure_id === canal)!;
    const itemRaioX = plano.items!.find((i) => i.description.startsWith('Radiografia'))!;
    const editado = await api(`${O}/plans/${plano.id}`, {
      method: 'PUT',
      body: JSON.stringify({
        title: 'Reabilitação 26 (revisado)',
        items: [
          // Mantém o canal com valor novo.
          { id: itemCanal.id, procedure_id: canal, tooth: '26', description: 'Tratamento de canal', amount_cents: 95000, quantity: 1 },
          // A coroa sai da lista: tem de ser excluída (soft delete).
          // O raio-x continua, com quantidade menor.
          { id: itemRaioX.id, description: 'Radiografia periapical', amount_cents: 5000, quantity: 2, tooth: '26' },
        ],
      }),
    }, admin!);
    check('plano editado (200)', editado.status === 200, String(editado.status));
    const revisado = await unwrap<Plan>(editado);
    check('edição mantém, atualiza e remove itens', revisado.items_count === 2, String(revisado.items_count));
    check('total recalculado após a edição', revisado.total_cents === 95000 + 10000, String(revisado.total_cents));
    check('assunto atualizado', revisado.title === 'Reabilitação 26 (revisado)', String(revisado.title));
    const coroaRemovida = db.prepare(
      'SELECT deleted_at FROM odonto_treatment_items WHERE id = ?',
    ).get(plano.items!.find((i) => i.procedure_id === coroa)!.id) as { deleted_at: string | null };
    check('item retirado sai por soft delete (o histórico não perde a linha)', coroaRemovida.deleted_at !== null);

    // ── Situações do plano (PR §11) ───────────────────────────────────────
    const status = (novo: string, motivo?: string) => api(`${O}/plans/${plano.id}/status`, {
      method: 'POST', body: JSON.stringify({ status: novo, motivo }),
    }, admin!);

    check('não pula de planejado direto para concluído',
      (await status('concluido')).status === 400);
    check('planejado → apresentado', (await status('apresentado')).status === 200);
    check('apresentado → aprovado', (await status('aprovado')).status === 200);
    const aprovado = await unwrap<Plan>(await api(`${O}/plans/${plano.id}`, {}, admin!));
    check('aprovação carimba a data', !!aprovado.approved_at);
    check('aprovar o plano aprova os itens',
      aprovado.items!.every((i) => i.status === 'aprovado'), JSON.stringify(aprovado.items!.map((i) => i.status)));
    check('não volta de aprovado para apresentado', (await status('apresentado')).status === 400);

    // Item: em andamento → concluído.
    const itemStatus = (itemId: number, novo: string) => api(`${O}/plans/${plano.id}/items/${itemId}/status`, {
      method: 'POST', body: JSON.stringify({ status: novo }),
    }, admin!);
    check('item aprovado → em andamento', (await itemStatus(itemCanal.id, 'em_andamento')).status === 200);
    check('item em andamento → concluído', (await itemStatus(itemCanal.id, 'concluido')).status === 200);
    check('item concluído não volta', (await itemStatus(itemCanal.id, 'em_andamento')).status === 400);
    check('item de outro plano → 404', (await api(`${O}/plans/99999/items/${itemCanal.id}/status`, {
      method: 'POST', body: JSON.stringify({ status: 'concluido' }),
    }, admin!)).status === 404);

    // ── Cobrança no financeiro (PR §12) ───────────────────────────────────
    const naoAprovado = await unwrap<Plan>(await criar({
      items: [{ description: 'Item para teste de cobrança', amount_cents: 10000 }],
    }));
    check('cobrar plano apenas planejado → 400', (await api(`${O}/plans/${naoAprovado.id}/charge`, {
      method: 'POST', body: JSON.stringify({ installments: 1, first_due_date: '2026-11-10' }),
    }, admin!)).status === 400);

    check('data de vencimento inválida → 400', (await api(`${O}/plans/${plano.id}/charge`, {
      method: 'POST', body: JSON.stringify({ installments: 2, first_due_date: '10/11/2026' }),
    }, admin!)).status === 400);

    const total = aprovado.total_cents;
    const cobranca = await api(`${O}/plans/${plano.id}/charge`, {
      method: 'POST', body: JSON.stringify({ installments: 3, first_due_date: '2026-01-31' }),
    }, admin!);
    check('cobrança gerada (201)', cobranca.status === 201, String(cobranca.status));
    const resultado = await unwrap<{
      total_cents: number; installments: number; installment_cents: number;
      due_dates: string[]; receivable_ids: number[]; ajuste_ultima_parcela_cents: number;
    }>(cobranca);
    check('cobrança devolve 3 parcelas', resultado.installments === 3 && resultado.receivable_ids.length === 3,
      JSON.stringify(resultado.receivable_ids));
    check('parcelas com vencimento mensal (dia 31 ajustado)',
      resultado.due_dates.join(',') === '2026-01-31,2026-02-28,2026-03-31', resultado.due_dates.join(','));

    // O dinheiro foi para o FINANCEIRO do Kivo, não para uma tabela do Odonto.
    const contas = db.prepare(
      'SELECT * FROM receivables WHERE id IN (?, ?, ?) ORDER BY due_date',
    ).all(...resultado.receivable_ids) as unknown as Receivable[];
    check('as contas existem em receivables (financeiro do Kivo)', contas.length === 3, String(contas.length));
    check('conta a receber é do cliente do paciente',
      contas.every((c) => c.customer_id === clienteDoPaciente.customer_id), JSON.stringify(contas.map((c) => c.customer_id)));
    check('a soma das parcelas fecha o total do plano',
      contas.reduce((s, c) => s + c.amount_cents, 0) === total,
      `${contas.reduce((s, c) => s + c.amount_cents, 0)} vs ${total}`);
    check('parcelamento identificado (nº e total de parcelas)',
      contas.every((c) => c.installment_count === 3) && contas.map((c) => c.installment_no).join(',') === '1,2,3',
      contas.map((c) => `${c.installment_no}/${c.installment_count}`).join(' '));
    check('descrição diz de qual plano é a parcela',
      contas.every((c) => c.description.includes(`Plano de tratamento #${plano.id}`)),
      String(contas[0]?.description));
    check('contas nascem em aberto', contas.every((c) => c.status === 'aberta'));
    check('sobrou resto de centavos na última parcela',
      contas[0].amount_cents === resultado.installment_cents
      && contas[2].amount_cents === resultado.installment_cents + resultado.ajuste_ultima_parcela_cents,
      JSON.stringify(contas.map((c) => c.amount_cents)));

    const depoisDaCobranca = await unwrap<Plan>(await api(`${O}/plans/${plano.id}`, {}, admin!));
    check('plano marca que foi cobrado', !!depoisDaCobranca.charged_at && depoisDaCobranca.installments === 3);
    check('plano guarda o primeiro vencimento', depoisDaCobranca.first_due_date === '2026-01-31', String(depoisDaCobranca.first_due_date));

    check('não cobra duas vezes o mesmo plano', (await api(`${O}/plans/${plano.id}/charge`, {
      method: 'POST', body: JSON.stringify({ installments: 1, first_due_date: '2026-12-01' }),
    }, admin!)).status === 400);
    check('plano cobrado não tem itens editáveis', (await api(`${O}/plans/${plano.id}`, {
      method: 'PUT', body: JSON.stringify({ items: [{ description: 'Tentativa de mudar o que já foi cobrado', amount_cents: 1 }] }),
    }, admin!)).status === 400);
    check('plano cobrado não é apagado', (await api(`${O}/plans/${plano.id}`, { method: 'DELETE' }, admin!)).status === 400);
    // Plano de 3 centavos não se divide em 36 parcelas (cada parcela tem de valer ao menos 1).
    const centavos = await unwrap<Plan>(await criar({ items: [{ description: 'Item de 3 centavos', amount_cents: 3 }] }));
    await api(`${O}/plans/${centavos.id}/status`, { method: 'POST', body: JSON.stringify({ status: 'aprovado' }) }, admin!);
    check('mais parcelas do que centavos → 400', (await api(`${O}/plans/${centavos.id}/charge`, {
      method: 'POST', body: JSON.stringify({ installments: 36, first_due_date: '2026-11-10' }),
    }, admin!)).status === 400);

    // ── Integração com o odontograma (planejado vem do plano) ─────────────
    const odonto1 = await unwrap<{ planned: { tooth: string; description: string; plan_id: number }[] }>(
      await api(`${O}/patients/${paciente.id}/odontogram`, {}, admin!));
    check('o plano alimenta o "planejado" do odontograma',
      odonto1.planned.some((p) => p.tooth === '26' && p.plan_id === plano.id),
      JSON.stringify(odonto1.planned.map((p) => p.tooth)));

    // ── Cancelar ──────────────────────────────────────────────────────────
    const cancelado = await api(`${O}/plans/${naoAprovado.id}/status`, {
      method: 'POST', body: JSON.stringify({ status: 'cancelado', motivo: 'paciente desistiu' }),
    }, admin!);
    check('cancelar o plano (200)', cancelado.status === 200, String(cancelado.status));
    const canceladoDetalhe = await unwrap<Plan>(await api(`${O}/plans/${naoAprovado.id}`, {}, admin!));
    check('cancelamento guarda data e motivo',
      !!canceladoDetalhe.cancelled_at && canceladoDetalhe.cancel_reason === 'paciente desistiu',
      String(canceladoDetalhe.cancel_reason));
    check('cancelado não gera cobrança', (await api(`${O}/plans/${naoAprovado.id}/charge`, {
      method: 'POST', body: JSON.stringify({ installments: 1, first_due_date: '2026-11-10' }),
    }, admin!)).status === 400);
    check('cancelar duas vezes → 400',
      (await api(`${O}/plans/${naoAprovado.id}/status`, { method: 'POST', body: JSON.stringify({ status: 'cancelado' }) }, admin!)).status === 400);
    check('plano cancelado pode ser reaberto',
      (await api(`${O}/plans/${naoAprovado.id}/status`, { method: 'POST', body: JSON.stringify({ status: 'planejado' }) }, admin!)).status === 200);

    // Concluir o plano conclui os itens e tira o dente do "planejado" do odontograma.
    await api(`${O}/plans/${naoAprovado.id}/status`, { method: 'POST', body: JSON.stringify({ status: 'apresentado' }) }, admin!);
    await api(`${O}/plans/${naoAprovado.id}/status`, { method: 'POST', body: JSON.stringify({ status: 'aprovado' }) }, admin!);
    await api(`${O}/plans/${naoAprovado.id}/status`, { method: 'POST', body: JSON.stringify({ status: 'em_andamento' }) }, admin!);
    const concluido = await api(`${O}/plans/${naoAprovado.id}/status`, { method: 'POST', body: JSON.stringify({ status: 'concluido' }) }, admin!);
    check('plano concluído (200)', concluido.status === 200, String(concluido.status));
    const concluidoDetalhe = await unwrap<Plan>(concluido);
    check('concluir o plano conclui os itens',
      concluidoDetalhe.items!.every((i) => i.status === 'concluido'), JSON.stringify(concluidoDetalhe.items!.map((i) => i.status)));
    check('plano concluído não é editável', (await api(`${O}/plans/${naoAprovado.id}`, {
      method: 'PUT', body: JSON.stringify({ title: 'não pode' }),
    }, admin!)).status === 400);

    // ── Permissões ────────────────────────────────────────────────────────
    const roleRecepcao = await unwrap<{ id: number; slug: string }>(
      await api('/api/roles', { method: 'POST', body: JSON.stringify({ name: 'Recepção Planos' }) }, admin!),
    );
    await api(`/api/roles/${roleRecepcao.id}/permissions`, {
      method: 'PUT', body: JSON.stringify({ permissions: ['odonto.patients.view', 'odonto.plans.view', 'odonto.plans.charge'] }),
    }, admin!);
    await api('/api/users', {
      method: 'POST', body: JSON.stringify({ username: 'recepcao_pl', name: 'Recepção', password: 'Teste1234', roleSlug: roleRecepcao.slug }),
    }, admin!);
    const recepcao = await loginAs('recepcao_pl', 'Teste1234');
    check('login da recepção', recepcao !== null);
    check('recepção VÊ os planos (é ela que cobra)',
      (await api(`${O}/patients/${paciente.id}/treatment-plans`, {}, recepcao!)).status === 200);
    check('recepção não cria plano (403)', (await api(`${O}/patients/${paciente.id}/treatment-plans`, {
      method: 'POST', body: JSON.stringify({ items: [{ description: 'X' }] }),
    }, recepcao!)).status === 403);
    check('recepção não aprova plano (403)', (await api(`${O}/plans/${naoAprovado.id}/status`, {
      method: 'POST', body: JSON.stringify({ status: 'planejado' }),
    }, recepcao!)).status === 403);

    const roleSemPlanos = await unwrap<{ id: number; slug: string }>(
      await api('/api/roles', { method: 'POST', body: JSON.stringify({ name: 'Sem planos' }) }, admin!),
    );
    await api(`/api/roles/${roleSemPlanos.id}/permissions`, {
      method: 'PUT', body: JSON.stringify({ permissions: ['odonto.patients.view'] }),
    }, admin!);
    await api('/api/users', {
      method: 'POST', body: JSON.stringify({ username: 'sem_planos', name: 'Sem planos', password: 'Teste1234', roleSlug: roleSemPlanos.slug }),
    }, admin!);
    const semPlanos = await loginAs('sem_planos', 'Teste1234');
    check('sem permissão não vê planos (403)',
      (await api(`${O}/patients/${paciente.id}/treatment-plans`, {}, semPlanos!)).status === 403);
    check('sem permissão não vê o plano (403)', (await api(`${O}/plans/${plano.id}`, {}, semPlanos!)).status === 403);

    // ── Auditoria ─────────────────────────────────────────────────────────
    const logs = db.prepare(
      "SELECT action, entity, after_json FROM audit_logs WHERE entity IN ('odonto_treatment_plan', 'odonto_treatment_plan_charge') ORDER BY id",
    ).all() as { action: string; entity: string; after_json: string | null }[];
    check('auditoria registrou criação e situação do plano', logs.length >= 5, `${logs.length} registro(s)`);
    check('auditoria da cobrança diz total e parcelas',
      logs.some((l) => l.entity === 'odonto_treatment_plan_charge'
        && (l.after_json ?? '').includes('"parcelas":3') && (l.after_json ?? '').includes(`"total_cents":${total}`)),
      String(logs.find((l) => l.entity === 'odonto_treatment_plan_charge')?.after_json).slice(0, 140));

    // ── Excluir o paciente leva planos e itens junto ──────────────────────
    await api(`${O}/patients/${paciente.id}`, { method: 'DELETE' }, admin!);
    const planosRestantes = db.prepare(
      'SELECT COUNT(*) AS t FROM odonto_treatment_plans WHERE patient_id = ? AND deleted_at IS NULL',
    ).get(paciente.id) as { t: number };
    const itensRestantes = db.prepare(
      `SELECT COUNT(*) AS t FROM odonto_treatment_items i JOIN odonto_treatment_plans p ON p.id = i.plan_id
        WHERE p.patient_id = ? AND i.deleted_at IS NULL`,
    ).get(paciente.id) as { t: number };
    check('planos do paciente excluído saem por soft delete', planosRestantes.t === 0, `${planosRestantes.t}`);
    check('itens dos planos também saem', itensRestantes.t === 0, `${itensRestantes.t}`);
    check('as contas a receber do financeiro NÃO são apagadas com o paciente',
      (db.prepare('SELECT COUNT(*) AS t FROM receivables WHERE deleted_at IS NULL').get() as { t: number }).t === 3);

    // ── Módulo fora do plano → API bloqueada ──────────────────────────────
    db.prepare(`UPDATE license SET modules_json = ?, license_key = 'teste', company_uuid = 'teste' WHERE id = 1`)
      .run(JSON.stringify(['commercial', 'finance']));
    check('módulo fora do plano → 403 nos planos',
      (await api(`${O}/patients/1/treatment-plans`, {}, admin!)).status === 403);
    db.prepare(`UPDATE license SET modules_json = NULL, license_key = NULL, company_uuid = NULL WHERE id = 1`).run();
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  console.log(failures === 0 ? '\nPlanos de tratamento: TODOS OS TESTES PASSARAM' : `\n${failures} falha(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
