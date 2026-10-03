/**
 * Teste de integração do painel e dos relatórios do Kivo Odonto (fase 9, PR §21 e §27).
 *
 * O que este teste protege:
 *  - os números do painel são CONTAGENS E SOMAS conferidas contra os dados semeados;
 *  - o painel e os relatórios NÃO devolvem texto clínico (observação de evolução, corpo de
 *    documento, resposta de anamnese) — só nomes de procedimento, situações e valores;
 *  - relatório respeita o período informado e exporta CSV com o mesmo conteúdo da tela;
 *  - a auditoria é a do Core (`audit.view`), e enxerga as entidades `odonto_*`;
 *  - sem `odonto.reports.view` não há painel nem relatório.
 *
 * KIVO_DB_PATH TEM que vir do ambiente — rode com
 *   node scripts/test-isolated.js src/tests/odonto-painel.ts
 */
import { migrateUp } from '../core/database/migrator';
import { runSeeds } from '../core/database/seeds';
import { getSqlite } from '../core/database/connection';
import { createServer } from '../core/server';
import { resetTestDb, activateTestLicense } from './resetTestDb';
import { unwrap } from './testUtils';

const PORT = Number(process.env.KIVO_PORT ?? 3851);
const base = `http://localhost:${PORT}`;
const O = '/api/odonto';
const OBSERVACAO = 'Paciente relatou dor intensa à mastigação no lado direito (texto que não pode vazar no painel).';
const CORPO_DOC = 'Declaro que autorizo o procedimento (texto que não pode vazar no painel).';

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

interface Dashboard {
  hoje: string;
  pacientes: { ativos: number; novos_mes: number; sem_anamnese: number };
  agenda: { total: number; por_status: { status: string; total: number }[] };
  proximos: { id: number; starts_at: string; status: string; patient_name: string }[];
  planos: { abertos: number; valor_aberto_cents: number; cobrados: number; valor_cobrado_cents: number };
  odontograma: { dentes_avaliados: number; registros: number };
  documentos: { emitidos: number };
  documentos_do_mes: { por_tipo: { type: string; total: number }[] };
}
interface Relatorio {
  type: string; label: string; from: string; to: string;
  colunas: { key: string; label: string; money?: boolean }[];
  linhas: Record<string, string | number>[];
  totais?: Record<string, number>;
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
    check('sem login → 401', (await api(`${O}/dashboard`)).status === 401);

    // ── Base com números conhecidos ────────────────────────────────────────
    const hoje = new Date().toISOString().slice(0, 10);
    const paciente = (await unwrap<{ id: number }>(await api(`${O}/patients`, {
      method: 'POST', body: JSON.stringify({ name: 'Paulo Painel (teste)', birthday: '1990-01-10' }),
    }, admin!))).id;
    const paciente2 = (await unwrap<{ id: number }>(await api(`${O}/patients`, {
      method: 'POST', body: JSON.stringify({ name: 'Rita Painel (teste)' }),
    }, admin!))).id;
    const dentista = (await unwrap<{ id: number }>(await api(`${O}/professionals`, {
      method: 'POST', body: JSON.stringify({ name: 'Dra. Nina (teste)', cro: '77889', cro_state: 'MT' }),
    }, admin!))).id;
    const procedimento = (await unwrap<{ id: number }>(await api(`${O}/procedures`, {
      method: 'POST', body: JSON.stringify({ name: 'Extração (teste painel)', duration_min: 45, default_price_cents: 30000 }),
    }, admin!))).id;

    // Dois atendimentos hoje (um já atendido, um agendado) e um amanhã.
    const hojeBase = `${hoje} `;
    const consulta1 = await unwrap<{ id: number }>(await api(`${O}/appointments`, {
      method: 'POST', body: JSON.stringify({ patient_id: paciente, professional_id: dentista, procedure_id: procedimento, starts_at: hojeBase + '09:00', duration_min: 45 }),
    }, admin!));
    // O status não se define na criação: a transição é um ato próprio da agenda.
    // O status é transição: agendado → em_atendimento → atendido.
    await api(`${O}/appointments/${consulta1.id}/status`, {
      method: 'POST', body: JSON.stringify({ status: 'em_atendimento' }),
    }, admin!);
    const responderStatus = await api(`${O}/appointments/${consulta1.id}/status`, {
      method: 'POST', body: JSON.stringify({ status: 'atendido' }),
    }, admin!);
    const statusNoBanco = db.prepare('SELECT status FROM odonto_appointments WHERE id = ?').get(consulta1.id) as { status: string };
    check('consulta marcada como atendida', statusNoBanco.status === 'atendido',
      `HTTP ${responderStatus.status} → ${statusNoBanco.status}`);
    await api(`${O}/appointments`, {
      method: 'POST', body: JSON.stringify({ patient_id: paciente2, professional_id: dentista, starts_at: hojeBase + '11:00', duration_min: 45 }),
    }, admin!);
    const amanha = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    await api(`${O}/appointments`, {
      method: 'POST', body: JSON.stringify({ patient_id: paciente, professional_id: dentista, starts_at: amanha + ' 08:00', duration_min: 30 }),
    }, admin!);

    // Anamnese respondida por um paciente (o outro fica sem). A listagem devolve os modelos.
    const formularios = await unwrap<{ id: number; fields: { key: string; label: string; type: string }[] }[]>(
      await api(`${O}/anamnesis/templates`, {}, admin!),
    );
    const formulario = formularios[0];
    check('a anamnese padrão está semeada', !!formulario && (formulario.fields ?? []).length > 0,
      `${formularios.length} modelo(s)`);
    const salvarAnamnese = await api(`${O}/patients/${paciente}/anamnesis`, {
      method: 'POST',
      body: JSON.stringify({
        template_id: formulario.id,
        // Campo de seleção/múltipla exige uma das opções: responde a primeira de cada lista.
        answers: Object.fromEntries((formulario.fields || []).map((f) => {
          const campo = f as { key: string; type: string; options?: string[] };
          if (campo.type === 'multipla') return [campo.key, [campo.options?.[0] ?? 'Nenhum']];
          if (campo.type === 'selecao') return [campo.key, campo.options?.[0] ?? 'nao'];
          if (campo.type === 'numero') return [campo.key, 1];
          // sim_nao usa chaves sem acento: sim | nao | nao_sei.
          if (campo.type === 'sim_nao') return [campo.key, 'nao'];
          if (campo.type === 'data') return [campo.key, '2026-01-01'];
          return [campo.key, 'não'];
        })),
      }),
    }, admin!);
    check('anamnese salva (201)', salvarAnamnese.status === 201,
      `${salvarAnamnese.status} ${(await salvarAnamnese.text()).slice(0, 120)}`);
    const anamneseSalva = await unwrap<{ summary: { revisions: number } }>(
      await api(`${O}/patients/${paciente}/anamnesis`, {}, admin!),
    );
    check('anamnese respondida ficou gravada', anamneseSalva.summary.revisions === 1,
      JSON.stringify(anamneseSalva.summary));

    // Plano aprovado e cobrado + evolução com procedimento.
    const plano = await unwrap<{ id: number }>(await api(`${O}/patients/${paciente}/treatment-plans`, {
      method: 'POST',
      body: JSON.stringify({ professional_id: dentista, items: [{ procedure_id: procedimento, tooth: '36', description: 'Extração do 36', amount_cents: 30000, quantity: 1 }] }),
    }, admin!));
    await api(`${O}/plans/${plano.id}/status`, { method: 'POST', body: JSON.stringify({ status: 'aprovado' }) }, admin!);
    await api(`${O}/plans/${plano.id}/charge`, {
      method: 'POST', body: JSON.stringify({ installments: 1, first_due_date: hoje }),
    }, admin!);
    await api(`${O}/patients/${paciente}/notes`, {
      method: 'POST',
      body: JSON.stringify({
        professional_id: dentista,
        happened_at: `${hoje} 09:30`,
        procedures: [{ procedure_id: procedimento, tooth: '36' }],
        observations: OBSERVACAO,
      }),
    }, admin!);
    await api(`${O}/patients/${paciente}/odontogram`, {
      method: 'POST', body: JSON.stringify({ tooth: '36', condition_id: 1 }),
    }, admin!);
    const docEmitido = await unwrap<{ id: number }>(await api(`${O}/patients/${paciente}/documents`, {
      method: 'POST', body: JSON.stringify({ type: 'tcle', title: 'TCLE (teste painel)', body: CORPO_DOC, professional_id: dentista }),
    }, admin!));
    await api(`${O}/documents/${docEmitido.id}/issue`, {
      method: 'POST', body: JSON.stringify({ professional_id: dentista }),
    }, admin!);

    // ── Painel ────────────────────────────────────────────────────────────
    const painelRes = await api(`${O}/dashboard`, {}, admin!);
    check('painel responde 200', painelRes.status === 200, String(painelRes.status));
    const painel = await unwrap<Dashboard>(painelRes);
    check('painel conta os pacientes ativos', painel.pacientes.ativos === 2, String(painel.pacientes.ativos));
    check('painel conta os pacientes sem anamnese', painel.pacientes.sem_anamnese === 1, String(painel.pacientes.sem_anamnese));
    check('painel conta os atendimentos de hoje', painel.agenda.total === 2, String(painel.agenda.total));
    check('painel detalha a agenda por situação',
      painel.agenda.por_status.some((s) => s.status === 'atendido' && Number(s.total) === 1)
      && painel.agenda.por_status.some((s) => s.status === 'agendado'),
      JSON.stringify(painel.agenda.por_status));
    check('painel lista os próximos atendimentos (inclui amanhã)',
      painel.proximos.length === 3 && painel.proximos[0].patient_name.length > 0, `${painel.proximos.length}`);
    check('painel mostra o plano em aberto e o valor previsto',
      painel.planos.abertos === 1 && painel.planos.valor_aberto_cents === 30000,
      JSON.stringify({ a: painel.planos.abertos, v: painel.planos.valor_aberto_cents }));
    check('painel mostra o valor cobrado no mês',
      painel.planos.cobrados === 1 && painel.planos.valor_cobrado_cents === 30000, JSON.stringify(painel.planos));
    check('painel conta os dentes avaliados no odontograma',
      painel.odontograma.dentes_avaliados === 1 && painel.odontograma.registros === 1, JSON.stringify(painel.odontograma));
    check('painel conta os documentos emitidos', painel.documentos.emitidos === 1, String(painel.documentos.emitidos));
    check('painel agrupa os documentos do mês por tipo',
      painel.documentos_do_mes.por_tipo.some((t) => t.type === 'tcle' && Number(t.total) === 1),
      JSON.stringify(painel.documentos_do_mes.por_tipo));

    // O painel conta, não conta histórias: nenhum texto clínico pode aparecer.
    const brutoPainel = JSON.stringify(painel);
    check('painel NÃO traz a observação da evolução', !brutoPainel.includes(OBSERVACAO));
    check('painel NÃO traz o corpo do documento', !brutoPainel.includes(CORPO_DOC));
    check('painel NÃO traz resposta de anamnese', !brutoPainel.includes('"answers"'));

    // ── Relatórios ────────────────────────────────────────────────────────
    const tipos = await unwrap<{ type: string; label: string }[]>(await api(`${O}/reports`, {}, admin!));
    check('lista os tipos de relatório', tipos.length === 6, `${tipos.length}`);
    check('relatório inválido → 400', (await api(`${O}/reports/inventado`, {}, admin!)).status === 400);

    const rel = await unwrap<Relatorio>(await api(`${O}/reports/atendimentos?from=${hoje}&to=${hoje}`, {}, admin!));
    check('relatório de atendimentos traz situação e profissional',
      rel.linhas.some((l) => l.grupo === 'Situação' && l.nome === 'atendido')
      && rel.linhas.some((l) => l.grupo === 'Profissional' && String(l.nome).includes('Dra. Nina')),
      JSON.stringify(rel.linhas.slice(0, 3)));
    check('relatório de atendimentos soma o total', rel.totais?.total === 2, JSON.stringify(rel.totais));
    check('relatório respeita o período (dia sem atendimento vem vazio)',
      (await unwrap<Relatorio>(await api(`${O}/reports/atendimentos?from=2020-01-01&to=2020-01-02`, {}, admin!))).linhas.length === 0);

    const producao = await unwrap<Relatorio>(await api(`${O}/reports/producao?from=${hoje}&to=${hoje}`, {}, admin!));
    check('relatório de produção traz o procedimento realizado',
      producao.linhas.some((l) => l.grupo === 'Procedimento' && l.nome === 'Extração (teste painel)' && Number(l.total) === 1),
      JSON.stringify(producao.linhas));
    check('relatório de produção soma o valor de tabela', producao.totais?.valor_cents === 30000, JSON.stringify(producao.totais));
    check('relatório de produção NÃO traz a observação clínica', !JSON.stringify(producao).includes(OBSERVACAO));

    const planosRel = await unwrap<Relatorio>(await api(`${O}/reports/planos?from=${hoje}&to=${hoje}`, {}, admin!));
    check('relatório de planos mostra a situação e o valor',
      planosRel.linhas.some((l) => l.status === 'aprovado' && Number(l.valor_cents) === 30000), JSON.stringify(planosRel.linhas));

    const docsRel = await unwrap<Relatorio>(await api(`${O}/reports/documentos?from=${hoje}&to=${hoje}`, {}, admin!));
    check('relatório de documentos agrupa por tipo e separa emitidos',
      docsRel.linhas.some((l) => l.tipo === 'tcle' && Number(l.total) === 1 && Number(l.emitidos) === 1),
      JSON.stringify(docsRel.linhas));
    check('relatório de documentos NÃO traz o corpo', !JSON.stringify(docsRel).includes(CORPO_DOC));

    const anamneseRel = await unwrap<Relatorio>(await api(`${O}/reports/anamnese?from=${hoje}&to=${hoje}`, {}, admin!));
    check('relatório de anamnese conta respostas e pacientes',
      anamneseRel.linhas.some((l) => l.metrica === 'Pacientes que responderam' && Number(l.valor) === 1),
      JSON.stringify(anamneseRel.linhas));
    check('relatório de anamnese NÃO traz respostas', !JSON.stringify(anamneseRel).includes('"answers"'));

    const pacientesRel = await unwrap<Relatorio>(await api(`${O}/reports/pacientes`, {}, admin!));
    check('relatório de pacientes traz a carteira',
      pacientesRel.linhas.some((l) => l.metrica === 'Pacientes ativos' && Number(l.valor) === 2),
      JSON.stringify(pacientesRel.linhas));

    // ── CSV ───────────────────────────────────────────────────────────────
    const csvResp = await api(`${O}/reports/atendimentos/csv?from=${hoje}&to=${hoje}`, {}, admin!);
    const csv = await csvResp.text();
    check('CSV responde como arquivo', csvResp.status === 200
      && (csvResp.headers.get('content-type') ?? '').includes('text/csv')
      && (csvResp.headers.get('content-disposition') ?? '').includes('odonto-atendimentos'),
      csvResp.headers.get('content-type') ?? '');
    check('CSV tem cabeçalho, linhas e totais',
      csv.includes('Situação / profissional') && csv.includes('atendido') && csv.includes('TOTAIS'), csv.split('\r\n').slice(3, 5).join(' | '));
    check('CSV NÃO traz texto clínico', !csv.includes(OBSERVACAO));
    check('CSV de tipo inválido → 400', (await api(`${O}/reports/inventado/csv`, {}, admin!)).status === 400);

    // ── Auditoria: é a do Core, e enxerga o odonto ─────────────────────────
    const auditoria = await unwrap<{ entity: string; action: string }[]>(await api('/api/audit?limit=500', {}, admin!));
    check('a auditoria do Core lista as entidades do odonto',
      auditoria.some((l) => l.entity.startsWith('odonto_')), `${auditoria.filter((l) => l.entity.startsWith('odonto_')).length} registro(s)`);
    check('a auditoria registra os atos do odonto',
      auditoria.some((l) => l.entity === 'odonto_document' && l.action === 'editar')
      && auditoria.some((l) => l.entity === 'odonto_treatment_plan_charge'),
      JSON.stringify([...new Set(auditoria.filter((l) => l.entity.startsWith('odonto_')).map((l) => `${l.entity}:${l.action}`))].slice(0, 6)));
    check('a auditoria NÃO copia texto clínico', !JSON.stringify(auditoria).includes(OBSERVACAO));

    // ── Permissões ────────────────────────────────────────────────────────
    const roleSemPainel = await unwrap<{ id: number; slug: string }>(
      await api('/api/roles', { method: 'POST', body: JSON.stringify({ name: 'Sem painel odonto' }) }, admin!),
    );
    await api(`/api/roles/${roleSemPainel.id}/permissions`, {
      method: 'PUT', body: JSON.stringify({ permissions: ['odonto.patients.view'] }),
    }, admin!);
    await api('/api/users', {
      method: 'POST', body: JSON.stringify({ username: 'sem_painel', name: 'Sem painel', password: 'Teste1234', roleSlug: roleSemPainel.slug }),
    }, admin!);
    const semPainel = await loginAs('sem_painel', 'Teste1234');
    check('login do usuário sem relatórios', semPainel !== null);
    check('sem odonto.reports.view não abre o painel (403)',
      (await api(`${O}/dashboard`, {}, semPainel!)).status === 403);
    check('sem odonto.reports.view não gera relatório (403)',
      (await api(`${O}/reports/atendimentos`, {}, semPainel!)).status === 403);
    check('sem odonto.reports.view não baixa CSV (403)',
      (await api(`${O}/reports/atendimentos/csv`, {}, semPainel!)).status === 403);

    const roleRecepcao = await unwrap<{ id: number; slug: string }>(
      await api('/api/roles', { method: 'POST', body: JSON.stringify({ name: 'Painel recepcao' }) }, admin!),
    );
    await api(`/api/roles/${roleRecepcao.id}/permissions`, {
      method: 'PUT', body: JSON.stringify({ permissions: ['odonto.patients.view', 'odonto.reports.view'] }),
    }, admin!);
    await api('/api/users', {
      method: 'POST', body: JSON.stringify({ username: 'painel_recepcao', name: 'Recepção', password: 'Teste1234', roleSlug: roleRecepcao.slug }),
    }, admin!);
    const recepcao = await loginAs('painel_recepcao', 'Teste1234');
    check('a recepção vê o painel (é ela que acompanha a agenda e a cobrança)',
      (await api(`${O}/dashboard`, {}, recepcao!)).status === 200);
    check('a recepção não vê o prontuário clínico (403)',
      (await api(`${O}/patients/${paciente}/notes`, {}, recepcao!)).status === 403);

    // ── Módulo fora do plano → API bloqueada ──────────────────────────────
    db.prepare(`UPDATE license SET modules_json = ?, license_key = 'teste', company_uuid = 'teste' WHERE id = 1`)
      .run(JSON.stringify(['commercial', 'finance']));
    check('módulo fora do plano → 403 no painel', (await api(`${O}/dashboard`, {}, admin!)).status === 403);
    db.prepare(`UPDATE license SET modules_json = NULL, license_key = NULL, company_uuid = NULL WHERE id = 1`).run();
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  console.log(failures === 0 ? '\nPainel odonto: TODOS OS TESTES PASSARAM' : `\n${failures} falha(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
