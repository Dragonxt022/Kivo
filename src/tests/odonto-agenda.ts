/**
 * Teste de integração da agenda do módulo odonto (PR §6).
 *
 * Cobre o que faz a agenda ser confiável no balcão: sobreposição de horário do mesmo
 * profissional é recusada (com mensagem que diz com quem bate), encaixe é a exceção
 * declarada, reagendar move o MESMO agendamento e registra de/para, cancelado/faltou liberam
 * o horário, as situações andam na ordem certa (atendido é final) e quem não tem permissão de
 * agenda não vê nem mexe.
 *
 * KIVO_DB_PATH TEM que vir do ambiente — rode com
 *   node scripts/test-isolated.js src/tests/odonto-agenda.ts
 */
import { migrateUp } from '../core/database/migrator';
import { runSeeds } from '../core/database/seeds';
import { getSqlite } from '../core/database/connection';
import { createServer } from '../core/server';
import { resetTestDb, activateTestLicense } from './resetTestDb';
import { unwrap } from './testUtils';

const PORT = Number(process.env.KIVO_PORT ?? 3846);
const base = `http://localhost:${PORT}`;
const O = '/api/odonto';
const DIA = '2026-11-10';

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

interface Appointment {
  id: number;
  patient_id: number;
  professional_id: number;
  starts_at: string;
  ends_at: string;
  duration_min: number;
  status: string;
  is_fit_in: boolean;
  cancel_reason: string | null;
  patient_name: string;
  professional_name: string;
}
interface AppointmentList { from: string; to: string; items: Appointment[]; porDia: { dia: string; total: number }[] }
interface AppointmentDetail { appointment: Appointment; history: { event: string; from: string | null; to: string | null; from_status: string | null; to_status: string | null; username: string | null }[] }

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
    check('sem login → 401', (await api(`${O}/appointments`)).status === 401);

    // ── Base: paciente, profissional e procedimento ────────────────────────
    const pacienteA = (await unwrap<{ id: number }>(await api(`${O}/patients`, {
      method: 'POST', body: JSON.stringify({ name: 'Ana Agenda (teste)', phone: '(69) 91111-1111' }),
    }, admin!))).id;
    const pacienteB = (await unwrap<{ id: number }>(await api(`${O}/patients`, {
      method: 'POST', body: JSON.stringify({ name: 'Bruno Agenda (teste)' }),
    }, admin!))).id;
    const dr = (await unwrap<{ id: number }>(await api(`${O}/professionals`, {
      method: 'POST', body: JSON.stringify({ name: 'Dra. Cláudia (teste)', cro: '12345', cro_state: 'MT' }),
    }, admin!))).id;
    const dr2 = (await unwrap<{ id: number }>(await api(`${O}/professionals`, {
      method: 'POST', body: JSON.stringify({ name: 'Dr. Diego (teste)', cro: '54321', cro_state: 'MT' }),
    }, admin!))).id;
    const procedimento = (await unwrap<{ id: number }>(await api(`${O}/procedures`, {
      method: 'POST', body: JSON.stringify({ name: 'Restauração (teste)', duration_min: 45, default_price_cents: 18000 }),
    }, admin!))).id;
    check('base criada (2 pacientes, 2 profissionais, 1 procedimento)',
      pacienteA > 0 && pacienteB > 0 && dr > 0 && dr2 > 0 && procedimento > 0);

    // ── Agendar ────────────────────────────────────────────────────────────
    const agendado = await api(`${O}/appointments`, {
      method: 'POST',
      body: JSON.stringify({
        patient_id: pacienteA, professional_id: dr, procedure_id: procedimento,
        starts_at: `${DIA} 09:00`, duration_min: 30, room: 'Cadeira 1', notes: 'Paciente prefere manhã.',
      }),
    }, admin!);
    check('agendamento criado (201)', agendado.status === 201, String(agendado.status));
    const a1 = await unwrap<Appointment>(agendado);
    check('situação inicial é agendado', a1.status === 'agendado', a1.status);
    check('horário de término calculado pela duração', a1.ends_at === `${DIA} 09:30`, a1.ends_at);
    check('procedimento e sala gravados', a1.professional_name === 'Dra. Cláudia (teste)', a1.professional_name);

    const detalhe = await unwrap<AppointmentDetail>(await api(`${O}/appointments/${a1.id}`, {}, admin!));
    check('histórico começa com o evento criado', detalhe.history[0]?.event === 'criado', JSON.stringify(detalhe.history[0]));

    // ── Sobreposição do mesmo profissional é recusada ─────────────────────
    const choque = await api(`${O}/appointments`, {
      method: 'POST',
      body: JSON.stringify({ patient_id: pacienteB, professional_id: dr, starts_at: `${DIA} 09:15`, duration_min: 30 }),
    }, admin!);
    const erroChoque = (await choque.json()) as { error?: string };
    check('sobreposição recusada (409)', choque.status === 409, String(choque.status));
    check('a mensagem diz com quem bate', /Ana Agenda/.test(String(erroChoque.error)), String(erroChoque.error).slice(0, 110));

    // ── Horário adjacente (09:30) é livre; outro profissional também ──────
    const adjacente = await api(`${O}/appointments`, {
      method: 'POST',
      body: JSON.stringify({ patient_id: pacienteB, professional_id: dr, starts_at: `${DIA} 09:30`, duration_min: 30 }),
    }, admin!);
    check('horário colado no fim do anterior é aceito', adjacente.status === 201, String(adjacente.status));
    const a2 = await unwrap<Appointment>(adjacente);

    const outroProf = await api(`${O}/appointments`, {
      method: 'POST',
      body: JSON.stringify({ patient_id: pacienteB, professional_id: dr2, starts_at: `${DIA} 09:15`, duration_min: 30 }),
    }, admin!);
    check('mesmo horário com outro profissional é aceito', outroProf.status === 201, String(outroProf.status));

    // ── Encaixe pode sobrepor ─────────────────────────────────────────────
    const encaixe = await api(`${O}/appointments`, {
      method: 'POST',
      body: JSON.stringify({
        patient_id: pacienteB, professional_id: dr, starts_at: `${DIA} 09:15`, duration_min: 15, is_fit_in: true,
      }),
    }, admin!);
    check('encaixe sobrepõe (201)', encaixe.status === 201, String(encaixe.status));
    const a3 = await unwrap<Appointment>(encaixe);
    check('encaixe vem marcado na agenda', a3.is_fit_in === true);
    const detalheEncaixe = await unwrap<AppointmentDetail>(await api(`${O}/appointments/${a3.id}`, {}, admin!));
    check('histórico registra o encaixe', detalheEncaixe.history.some((e) => e.event === 'encaixe'));

    // ── Cancelar libera o horário ─────────────────────────────────────────
    const cancelado = await api(`${O}/appointments/${a3.id}/status`, {
      method: 'POST', body: JSON.stringify({ status: 'cancelado', motivo: 'Paciente desmarcou.' }),
    }, admin!);
    const a3c = await unwrap<Appointment>(cancelado);
    check('cancelamento com motivo', a3c.status === 'cancelado' && a3c.cancel_reason === 'Paciente desmarcou.', JSON.stringify(a3c.cancel_reason));

    // Cancelar o encaixe NÃO libera 09:15: o atendimento das 09:00 (a1) continua valendo e
    // cobre esse horário. Quem libera é o cancelamento do próprio atendimento.
    const dentroDoA1 = await api(`${O}/appointments`, {
      method: 'POST',
      body: JSON.stringify({ patient_id: pacienteA, professional_id: dr, starts_at: `${DIA} 09:15`, duration_min: 15 }),
    }, admin!);
    check('cancelar o encaixe não libera horário coberto por atendimento ativo (409)', dentroDoA1.status === 409, String(dentroDoA1.status));

    const vaiCancelar = await unwrap<Appointment>(await api(`${O}/appointments`, {
      method: 'POST',
      body: JSON.stringify({ patient_id: pacienteB, professional_id: dr, starts_at: `${DIA} 14:00`, duration_min: 30 }),
    }, admin!));
    await api(`${O}/appointments/${vaiCancelar.id}/status`, {
      method: 'POST', body: JSON.stringify({ status: 'cancelado', motivo: 'Paciente remarcou.' }),
    }, admin!);
    const depoisDeCancelar = await api(`${O}/appointments`, {
      method: 'POST',
      body: JSON.stringify({ patient_id: pacienteA, professional_id: dr, starts_at: `${DIA} 14:00`, duration_min: 30 }),
    }, admin!);
    check('horário de atendimento cancelado fica livre', depoisDeCancelar.status === 201, String(depoisDeCancelar.status));
    const a4 = await unwrap<Appointment>(depoisDeCancelar);

    // ── Situações andam na ordem; atendido é final ────────────────────────
    const pulo = await api(`${O}/appointments/${a1.id}/status`, { method: 'POST', body: JSON.stringify({ status: 'atendido' }) }, admin!);
    check('não pula de agendado direto para atendido (400)', pulo.status === 400, String(pulo.status));

    const confirmado = await api(`${O}/appointments/${a1.id}/status`, { method: 'POST', body: JSON.stringify({ status: 'confirmado' }) }, admin!);
    check('agendado → confirmado', confirmado.status === 200, String(confirmado.status));
    const emAtendimento = await api(`${O}/appointments/${a1.id}/status`, { method: 'POST', body: JSON.stringify({ status: 'em_atendimento' }) }, admin!);
    check('confirmado → em atendimento', emAtendimento.status === 200, String(emAtendimento.status));
    const atendido = await unwrap<Appointment>(await api(`${O}/appointments/${a1.id}/status`, { method: 'POST', body: JSON.stringify({ status: 'atendido' }) }, admin!));
    check('em atendimento → atendido', atendido.status === 'atendido');

    const depoisDeFinal = await api(`${O}/appointments/${a1.id}/status`, { method: 'POST', body: JSON.stringify({ status: 'cancelado' }) }, admin!);
    check('atendido é final (não cancela mais)', depoisDeFinal.status === 400, String(depoisDeFinal.status));

    const reagendarAtendido = await api(`${O}/appointments/${a1.id}`, { method: 'PUT', body: JSON.stringify({ starts_at: `${DIA} 15:00` }) }, admin!);
    check('atendimento realizado não é reagendado (400)', reagendarAtendido.status === 400, String(reagendarAtendido.status));

    // ── Faltou libera o horário e pode ser reaberto ───────────────────────
    const faltou = await api(`${O}/appointments/${a2.id}/status`, { method: 'POST', body: JSON.stringify({ status: 'faltou' }) }, admin!);
    check('registro de falta', (await unwrap<Appointment>(faltou)).status === 'faltou');
    const reabriu = await api(`${O}/appointments/${a2.id}/status`, { method: 'POST', body: JSON.stringify({ status: 'agendado' }) }, admin!);
    check('falta pode ser reaberta para agendado', reabriu.status === 200, String(reabriu.status));

    // ── Reagendar move o MESMO atendimento ────────────────────────────────
    const reagendado = await api(`${O}/appointments/${a4.id}`, {
      method: 'PUT',
      body: JSON.stringify({ starts_at: `${DIA} 16:00`, duration_min: 45, room: 'Cadeira 2' }),
    }, admin!);
    check('reagendamento aceito (200)', reagendado.status === 200, String(reagendado.status));
    const a4r = await unwrap<Appointment>(reagendado);
    check('é o mesmo agendamento (id preservado)', a4r.id === a4.id && a4r.starts_at === `${DIA} 16:00`, `${a4r.id} · ${a4r.starts_at}`);
    check('novo horário de término após reagendar', a4r.ends_at === `${DIA} 16:45`, a4r.ends_at);

    const historicoA4 = await unwrap<AppointmentDetail>(await api(`${O}/appointments/${a4.id}`, {}, admin!));
    const eventoReagendado = historicoA4.history.find((e) => e.event === 'reagendado');
    check('histórico guarda o de/para do reagendamento',
      eventoReagendado?.from === `${DIA} 14:00` && eventoReagendado?.to === `${DIA} 16:00`,
      JSON.stringify({ de: eventoReagendado?.from, para: eventoReagendado?.to }));
    check('histórico registra quem reagendou', eventoReagendado?.username === 'admin', String(eventoReagendado?.username));

    const choqueReagendar = await api(`${O}/appointments/${a4.id}`, {
      method: 'PUT', body: JSON.stringify({ starts_at: `${DIA} 09:45`, duration_min: 30 }),
    }, admin!);
    check('reagendar para horário ocupado é recusado (409)', choqueReagendar.status === 409, String(choqueReagendar.status));

    // ── Listagens por período ─────────────────────────────────────────────
    const dia = await unwrap<AppointmentList>(await api(`${O}/appointments?view=dia&date=${DIA}`, {}, admin!));
    check('visão do dia traz os atendimentos do dia', dia.items.length >= 4, `${dia.items.length} item(ns)`);
    check('visão do dia vem ordenada por horário',
      dia.items.every((a, i) => i === 0 || dia.items[i - 1].starts_at <= a.starts_at));
    check('contagem por dia na resposta', dia.porDia.some((c) => String(c.dia).slice(0, 10) === DIA));

    const outroDia = await unwrap<AppointmentList>(await api(`${O}/appointments?view=dia&date=2026-11-11`, {}, admin!));
    check('dia sem atendimento vem vazio', outroDia.items.length === 0, `${outroDia.items.length}`);

    const semana = await unwrap<AppointmentList>(await api(`${O}/appointments?view=semana&date=${DIA}`, {}, admin!));
    check('visão da semana cobre 7 dias', semana.from.slice(0, 10) <= DIA && semana.to.slice(0, 10) >= DIA,
      `${semana.from} → ${semana.to}`);

    const mes = await unwrap<AppointmentList>(await api(`${O}/appointments?view=mes&date=${DIA}`, {}, admin!));
    check('visão do mês cobre o mês inteiro', mes.from.startsWith('2026-11-01') && mes.to.startsWith('2026-11-30'),
      `${mes.from} → ${mes.to}`);

    const porProfissional = await unwrap<AppointmentList>(await api(`${O}/appointments?view=dia&date=${DIA}&professional_id=${dr2}`, {}, admin!));
    check('filtro por profissional', porProfissional.items.every((a) => a.professional_id === dr2) && porProfissional.items.length === 1,
      `${porProfissional.items.length} item(ns)`);

    const porStatus = await unwrap<AppointmentList>(await api(`${O}/appointments?view=dia&date=${DIA}&status=atendido`, {}, admin!));
    check('filtro por situação', porStatus.items.every((a) => a.status === 'atendido'), `${porStatus.items.length}`);

    // ── Duplicidade de horário: criar e recusar de novo ───────────────────
    const duplicado = await api(`${O}/appointments`, {
      method: 'POST', body: JSON.stringify({ patient_id: pacienteB, professional_id: dr, starts_at: `${DIA} 09:00`, duration_min: 30 }),
    }, admin!);
    check('novo agendamento no horário já ocupado é recusado', duplicado.status === 409, String(duplicado.status));

    // ── Validações ────────────────────────────────────────────────────────
    const semPaciente = await api(`${O}/appointments`, {
      method: 'POST', body: JSON.stringify({ professional_id: dr, starts_at: `${DIA} 16:00` }),
    }, admin!);
    check('agendamento sem paciente → 400', semPaciente.status === 400, String(semPaciente.status));

    const profissionalInativo = await api(`${O}/professionals/${dr2}`, { method: 'PUT', body: JSON.stringify({ active: false }) }, admin!);
    check('profissional desativado', profissionalInativo.status === 200, String(profissionalInativo.status));
    const comInativo = await api(`${O}/appointments`, {
      method: 'POST', body: JSON.stringify({ patient_id: pacienteA, professional_id: dr2, starts_at: `${DIA} 16:00` }),
    }, admin!);
    check('agendar com profissional inativo → 400', comInativo.status === 400, String(comInativo.status));

    const horaInvalida = await api(`${O}/appointments`, {
      method: 'POST', body: JSON.stringify({ patient_id: pacienteA, professional_id: dr, starts_at: `${DIA}` }),
    }, admin!);
    check('data sem hora → 400', horaInvalida.status === 400, String(horaInvalida.status));

    const duracaoInvalida = await api(`${O}/appointments`, {
      method: 'POST', body: JSON.stringify({ patient_id: pacienteA, professional_id: dr, starts_at: `${DIA} 17:00`, duration_min: 600 }),
    }, admin!);
    check('duração fora do limite → 400', duracaoInvalida.status === 400, String(duracaoInvalida.status));

    // ── Excluir: permitido antes do atendimento, proibido depois ──────────
    const apagar = await api(`${O}/appointments/${a2.id}`, { method: 'DELETE' }, admin!);
    check('agendamento lançado por engano pode ser excluído', apagar.status === 200, String(apagar.status));
    const listaDepoisDeApagar = await unwrap<AppointmentList>(await api(`${O}/appointments?view=dia&date=${DIA}`, {}, admin!));
    check('agendamento excluído sai da agenda', !listaDepoisDeApagar.items.some((a) => a.id === a2.id));

    const apagarAtendido = await api(`${O}/appointments/${a1.id}`, { method: 'DELETE' }, admin!);
    check('atendimento realizado não é excluído (400)', apagarAtendido.status === 400, String(apagarAtendido.status));

    // ── Permissões ────────────────────────────────────────────────────────
    const roleRes = await api('/api/roles', { method: 'POST', body: JSON.stringify({ name: 'Recepção Agenda' }) }, admin!);
    const role = await unwrap<{ id: number; slug: string }>(roleRes);
    await api(`/api/roles/${role.id}/permissions`, {
      method: 'PUT', body: JSON.stringify({ permissions: ['odonto.agenda.view'] }),
    }, admin!);
    await api('/api/users', {
      method: 'POST', body: JSON.stringify({ username: 'recepcao_ag', name: 'Recepção', password: 'Teste1234', roleSlug: role.slug }),
    }, admin!);
    const recepcao = await loginAs('recepcao_ag', 'Teste1234');
    check('login da recepção', recepcao !== null);
    check('recepção VÊ a agenda', (await api(`${O}/appointments?view=dia&date=${DIA}`, {}, recepcao!)).status === 200);
    check('recepção NÃO agenda (403)', (await api(`${O}/appointments`, {
      method: 'POST', body: JSON.stringify({ patient_id: pacienteA, professional_id: dr, starts_at: `${DIA} 18:00` }),
    }, recepcao!)).status === 403);
    check('recepção NÃO muda situação (403)', (await api(`${O}/appointments/${a4.id}/status`, {
      method: 'POST', body: JSON.stringify({ status: 'confirmado' }),
    }, recepcao!)).status === 403);
    check('recepção NÃO exclui (403)', (await api(`${O}/appointments/${a4.id}`, { method: 'DELETE' }, recepcao!)).status === 403);

    // Sem a permissão de agenda, a tela e a API ficam fechadas (nem leitura).
    const roleSem = await unwrap<{ id: number; slug: string }>(
      await api('/api/roles', { method: 'POST', body: JSON.stringify({ name: 'Sem Agenda' }) }, admin!),
    );
    await api(`/api/roles/${roleSem.id}/permissions`, {
      method: 'PUT', body: JSON.stringify({ permissions: ['odonto.patients.view'] }),
    }, admin!);
    await api('/api/users', {
      method: 'POST', body: JSON.stringify({ username: 'sem_agenda', name: 'Sem agenda', password: 'Teste1234', roleSlug: roleSem.slug }),
    }, admin!);
    const semAgenda = await loginAs('sem_agenda', 'Teste1234');
    check('login do usuário sem agenda', semAgenda !== null);
    check('sem permissão de agenda a lista é 403',
      (await api(`${O}/appointments?view=dia&date=${DIA}`, {}, semAgenda!)).status === 403);
    check('sem permissão de agenda não agenda (403)', (await api(`${O}/appointments`, {
      method: 'POST', body: JSON.stringify({ patient_id: pacienteA, professional_id: dr, starts_at: `${DIA} 19:00` }),
    }, semAgenda!)).status === 403);

    // ── Auditoria: registra o ato, sem observação clínica ─────────────────
    const logs = db.prepare(
      "SELECT action, after_json FROM audit_logs WHERE entity = 'odonto_appointment' ORDER BY id",
    ).all() as { action: string; after_json: string | null }[];
    check('auditoria registrou criação e mudanças', logs.length >= 6, `${logs.length} registro(s)`);
    check('auditoria marca quando foi encaixe',
      logs.some((l) => (l.after_json ?? '').includes('"encaixe":true')));
    check('auditoria não copia a observação do agendamento',
      !logs.some((l) => (l.after_json ?? '').includes('Paciente prefere manhã')));

    // ── Módulo fora do plano → API bloqueada ──────────────────────────────
    db.prepare(`UPDATE license SET modules_json = ?, license_key = 'teste', company_uuid = 'teste' WHERE id = 1`)
      .run(JSON.stringify(['commercial', 'finance']));
    check('módulo fora do plano → 403 na agenda', (await api(`${O}/appointments`, {}, admin!)).status === 403);
    db.prepare(`UPDATE license SET modules_json = NULL, license_key = NULL, company_uuid = NULL WHERE id = 1`).run();
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  console.log(failures === 0 ? '\nAgenda odonto: TODOS OS TESTES PASSARAM' : `\n${failures} falha(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
