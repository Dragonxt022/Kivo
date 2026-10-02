/**
 * Teste de integração do prontuário — evolução clínica com retificação versionada (PR §7 e §8).
 *
 * O que a PR exige e este teste prova:
 *  - registro de evolução com paciente, profissional (e CRO do momento), data/hora, consulta,
 *    procedimentos, observações, diagnóstico, conduta e próximos passos;
 *  - **registro clínico NÃO é apagado**: a API recusa exclusão e explica que o caminho é a
 *    retificação;
 *  - retificação cria VERSÃO NOVA ligada à anterior, com motivo obrigatório, autor e data/hora,
 *    e marca a anterior como retificada — o histórico fica inteiro;
 *  - o nome do procedimento vem do catálogo (não do corpo da requisição) e o agendamento
 *    vinculado tem de ser do mesmo paciente (PR §24.2);
 *  - auditoria registra o ato sem copiar o conteúdo clínico.
 *
 * KIVO_DB_PATH TEM que vir do ambiente — rode com
 *   node scripts/test-isolated.js src/tests/odonto-prontuario.ts
 */
import { migrateUp } from '../core/database/migrator';
import { runSeeds } from '../core/database/seeds';
import { getSqlite } from '../core/database/connection';
import { createServer } from '../core/server';
import { resetTestDb, activateTestLicense } from './resetTestDb';
import { unwrap } from './testUtils';

const PORT = Number(process.env.KIVO_PORT ?? 3847);
const base = `http://localhost:${PORT}`;
const O = '/api/odonto';
const OBSERVACAO = 'Sensibilidade relatada no dente 26; anestesia aplicada sem intercorrência.';
const MOTIVO = 'Corrigi o dente: o procedimento foi no 36, não no 26.';

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

interface Note {
  id: number;
  patient_id: number;
  professional_id: number | null;
  professional_name: string | null;
  professional_cro: string | null;
  appointment_id: number | null;
  happened_at: string;
  title: string | null;
  procedures: { procedure_id: number; name: string; tooth: string | null; note: string | null }[];
  observations: string | null;
  diagnosis: string | null;
  conduct: string | null;
  next_steps: string | null;
  documents: number[];
  exams: number[];
  status: 'vigente' | 'retificado';
  version: number;
  replaced_by_id: number | null;
  retifica_id: number | null;
  retification_reason: string | null;
  created_by_name: string | null;
}
interface NotesList { items: Note[]; resumo: { vigentes: number; retificadas: number; ultima: string | null } }
interface NoteDetail { note: Note; history: Note[] }

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
    check('sem login → 401', (await api(`${O}/patients/1/notes`)).status === 401);

    // ── Base ───────────────────────────────────────────────────────────────
    const paciente = (await unwrap<{ id: number }>(await api(`${O}/patients`, {
      method: 'POST', body: JSON.stringify({ name: 'Clara Prontuário (teste)', phone: '(69) 95555-0000' }),
    }, admin!))).id;
    const outro = (await unwrap<{ id: number }>(await api(`${O}/patients`, {
      method: 'POST', body: JSON.stringify({ name: 'Outro Paciente (teste)' }),
    }, admin!))).id;
    const dentista = (await unwrap<{ id: number }>(await api(`${O}/professionals`, {
      method: 'POST', body: JSON.stringify({ name: 'Dr. Henrique (teste)', cro: '99887', cro_state: 'MT' }),
    }, admin!))).id;
    const restauracao = (await unwrap<{ id: number }>(await api(`${O}/procedures`, {
      method: 'POST', body: JSON.stringify({ name: 'Restauração em resina (teste)', duration_min: 60, default_price_cents: 28000 }),
    }, admin!))).id;
    const limpeza = (await unwrap<{ id: number }>(await api(`${O}/procedures`, {
      method: 'POST', body: JSON.stringify({ name: 'Profilaxia (teste)', duration_min: 30, default_price_cents: 15000 }),
    }, admin!))).id;
    const atendimento = (await unwrap<{ id: number }>(await api(`${O}/appointments`, {
      method: 'POST',
      body: JSON.stringify({ patient_id: paciente, professional_id: dentista, procedure_id: restauracao, starts_at: '2026-11-10 09:00', duration_min: 60 }),
    }, admin!))).id;
    const atendimentoDeOutro = (await unwrap<{ id: number }>(await api(`${O}/appointments`, {
      method: 'POST',
      body: JSON.stringify({ patient_id: outro, professional_id: dentista, starts_at: '2026-11-10 11:00', duration_min: 30 }),
    }, admin!))).id;
    check('base criada', paciente > 0 && dentista > 0 && restauracao > 0 && atendimento > 0);

    // ── Registro de evolução ───────────────────────────────────────────────
    const criado = await api(`${O}/patients/${paciente}/notes`, {
      method: 'POST',
      body: JSON.stringify({
        professional_id: dentista,
        appointment_id: atendimento,
        happened_at: '2026-11-10 09:05',
        title: 'Restauração do dente 26',
        // O nome enviado está ERRADO de propósito: o serviço tem de usar o do catálogo.
        procedures: [{ procedure_id: restauracao, tooth: '26', note: 'face oclusal' }],
        observations: OBSERVACAO,
        diagnosis: 'Cárie oclusal em 26.',
        conduct: 'Restauração em resina.',
        next_steps: 'Retorno em 15 dias para controle.',
        documents: [],
        exams: [],
      }),
    }, admin!);
    check('evolução registrada (201)', criado.status === 201, String(criado.status));
    const n1 = await unwrap<Note>(criado);
    check('primeira versão é vigente', n1.version === 1 && n1.status === 'vigente', JSON.stringify({ v: n1.version, s: n1.status }));
    check('nome do procedimento vem do catálogo',
      n1.procedures[0]?.name === 'Restauração em resina (teste)', String(n1.procedures[0]?.name));
    check('dente e observação do procedimento gravados',
      n1.procedures[0]?.tooth === '26' && n1.procedures[0]?.note === 'face oclusal', JSON.stringify(n1.procedures[0]));
    check('CRO do momento fica no registro', n1.professional_cro === '99887/MT', String(n1.professional_cro));
    check('data/hora do atendimento preservada', n1.happened_at === '2026-11-10 09:05', n1.happened_at);
    check('consulta vinculada', n1.appointment_id === atendimento);
    check('campos clínicos gravados',
      n1.observations === OBSERVACAO && n1.diagnosis === 'Cárie oclusal em 26.' && n1.conduct === 'Restauração em resina.',
      JSON.stringify({ obs: !!n1.observations, diag: n1.diagnosis }));
    check('quem registrou aparece no registro', n1.created_by_name === 'admin', String(n1.created_by_name));

    const semHora = await unwrap<Note>(await api(`${O}/patients/${paciente}/notes`, {
      method: 'POST',
      body: JSON.stringify({
        professional_id: dentista,
        // Procedimento sem dente e sem observação: é comum em profilaxia/orientação.
        procedures: [{ procedure_id: limpeza }],
        observations: 'Atendimento sem data informada.',
      }),
    }, admin!));
    check('sem data/hora o registro usa agora', /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(semHora.happened_at), semHora.happened_at);
    check('procedimento sem dente é aceito', semHora.procedures[0]?.tooth === null && semHora.procedures[0]?.name === 'Profilaxia (teste)',
      JSON.stringify(semHora.procedures[0]));

    // ── Validações ─────────────────────────────────────────────────────────
    const vazio = await api(`${O}/patients/${paciente}/notes`, {
      method: 'POST', body: JSON.stringify({ professional_id: dentista }),
    }, admin!);
    check('registro sem conteúdo → 400', vazio.status === 400, String(vazio.status));

    const procFantasma = await api(`${O}/patients/${paciente}/notes`, {
      method: 'POST', body: JSON.stringify({ procedures: [{ procedure_id: 99999 }] }),
    }, admin!);
    check('procedimento inexistente → 400', procFantasma.status === 400, String(procFantasma.status));

    const procSemId = await api(`${O}/patients/${paciente}/notes`, {
      method: 'POST', body: JSON.stringify({ procedures: [{ tooth: '26' }], observations: 'sem procedimento' }),
    }, admin!);
    check('procedimento sem id → 400 (nome não vem do cliente)', procSemId.status === 400, String(procSemId.status));

    const consultaDeOutro = await api(`${O}/patients/${paciente}/notes`, {
      method: 'POST', body: JSON.stringify({ appointment_id: atendimentoDeOutro, observations: 'consulta de outro paciente' }),
    }, admin!);
    check('consulta de outro paciente → 400', consultaDeOutro.status === 400, String(consultaDeOutro.status));

    const horaRuim = await api(`${O}/patients/${paciente}/notes`, {
      method: 'POST', body: JSON.stringify({ happened_at: '10/11/2026', observations: 'data inválida' }),
    }, admin!);
    check('data em formato errado → 400', horaRuim.status === 400, String(horaRuim.status));

    const profissionalFantasma = await api(`${O}/patients/${paciente}/notes`, {
      method: 'POST', body: JSON.stringify({ professional_id: 4242, observations: 'profissional inexistente' }),
    }, admin!);
    check('profissional inexistente → 400', profissionalFantasma.status === 400, String(profissionalFantasma.status));

    const pacienteInexistente = await api(`${O}/patients/9999/notes`, {
      method: 'POST', body: JSON.stringify({ observations: 'paciente fantasma' }),
    }, admin!);
    check('paciente inexistente → 404', pacienteInexistente.status === 404, String(pacienteInexistente.status));

    // ── Lista e resumo ─────────────────────────────────────────────────────
    const lista = await unwrap<NotesList>(await api(`${O}/patients/${paciente}/notes`, {}, admin!));
    check('lista traz as evoluções vigentes', lista.items.length === 2, `${lista.items.length} item(ns)`);
    check('resumo conta vigentes e última data',
      lista.resumo.vigentes === 2 && !!lista.resumo.ultima, JSON.stringify(lista.resumo));
    check('lista ordenada da mais recente para a mais antiga',
      lista.items[0]?.happened_at >= lista.items[1]?.happened_at,
      `${lista.items[0]?.happened_at} >= ${lista.items[1]?.happened_at}`);

    // ── Retificação: a regra central da PR §8 ──────────────────────────────
    const semMotivo = await api(`${O}/notes/${n1.id}/retify`, {
      method: 'POST', body: JSON.stringify({ observations: 'texto corrigido' }),
    }, admin!);
    check('retificação sem motivo → 400', semMotivo.status === 400, String(semMotivo.status));

    const motivoCurto = await api(`${O}/notes/${n1.id}/retify`, {
      method: 'POST', body: JSON.stringify({ observations: 'texto corrigido', motivo: 'ops' }),
    }, admin!);
    check('motivo curto → 400', motivoCurto.status === 400, String(motivoCurto.status));

    const retificado = await api(`${O}/notes/${n1.id}/retify`, {
      method: 'POST',
      body: JSON.stringify({
        // Só o que mudou: o resto tem de ser herdado da versão anterior.
        procedures: [{ procedure_id: restauracao, tooth: '36' }],
        motivo: MOTIVO,
      }),
    }, admin!);
    check('retificação aceita (201)', retificado.status === 201, String(retificado.status));
    const n2 = await unwrap<Note>(retificado);
    check('retificação é a versão seguinte', n2.version === 2 && n2.status === 'vigente', JSON.stringify({ v: n2.version, s: n2.status }));
    check('a nova versão aponta para a anterior', n2.retifica_id === n1.id, String(n2.retifica_id));
    check('motivo da retificação gravado', n2.retification_reason === MOTIVO, String(n2.retification_reason));
    check('o que não foi enviado veio da versão anterior',
      n2.observations === OBSERVACAO && n2.diagnosis === 'Cárie oclusal em 26.' && n2.next_steps === 'Retorno em 15 dias para controle.',
      JSON.stringify({ obs: n2.observations === OBSERVACAO, diag: n2.diagnosis }));
    check('a correção aplicada é a nova', n2.procedures[0]?.tooth === '36', String(n2.procedures[0]?.tooth));
    check('consulta vinculada herdada', n2.appointment_id === atendimento);

    const anterior = db.prepare('SELECT status, replaced_by_id FROM odonto_clinical_notes WHERE id = ?').get(n1.id) as
      { status: string; replaced_by_id: number | null };
    check('a versão anterior fica marcada como retificada', anterior.status === 'retificado', anterior.status);
    check('a versão anterior aponta para quem a substituiu', anterior.replaced_by_id === n2.id, String(anterior.replaced_by_id));

    const listaDepois = await unwrap<NotesList>(await api(`${O}/patients/${paciente}/notes`, {}, admin!));
    check('a lista mostra só a versão vigente', listaDepois.items.length === 2 && !listaDepois.items.some((i) => i.id === n1.id),
      `${listaDepois.items.length} item(ns)`);
    check('o resumo conta a retificada', listaDepois.resumo.retificadas === 1, JSON.stringify(listaDepois.resumo));

    const comRetificadas = await unwrap<NotesList>(await api(`${O}/patients/${paciente}/notes?retificadas=1`, {}, admin!));
    check('com ?retificadas=1 o histórico aparece', comRetificadas.items.some((i) => i.id === n1.id), `${comRetificadas.items.length} item(ns)`);
    check('a versão retificada aparece com o autor da correção',
      comRetificadas.items.find((i) => i.id === n1.id)?.replaced_by_id === n2.id);

    const retificarDeNovo = await api(`${O}/notes/${n1.id}/retify`, {
      method: 'POST', body: JSON.stringify({ observations: 'de novo', motivo: 'tentando retificar a versão antiga' }),
    }, admin!);
    check('retificar versão já retificada → 400', retificarDeNovo.status === 400, String(retificarDeNovo.status));

    const terceira = await unwrap<Note>(await api(`${O}/notes/${n2.id}/retify`, {
      method: 'POST', body: JSON.stringify({ diagnosis: 'Cárie oclusal em 36.', motivo: 'Ajustei também o texto do diagnóstico.' }),
    }, admin!));
    check('retificação da versão vigente vira versão 3', terceira.version === 3 && terceira.retifica_id === n2.id,
      JSON.stringify({ v: terceira.version, retifica: terceira.retifica_id }));

    const detalhe = await unwrap<NoteDetail>(await api(`${O}/notes/${terceira.id}`, {}, admin!));
    check('a cadeia de versões traz as três', detalhe.history.length === 3, `${detalhe.history.length} versão(ões)`);
    check('a cadeia vem em ordem de versão',
      detalhe.history.map((v) => v.version).join(',') === '1,2,3', detalhe.history.map((v) => v.version).join(','));
    check('a cadeia mostra o motivo de cada retificação',
      !!detalhe.history[1]?.retification_reason && !!detalhe.history[2]?.retification_reason);
    check('só a última está vigente', detalhe.history.filter((v) => v.status === 'vigente').length === 1);

    // ── Exclusão de registro clínico NÃO existe (PR §8) ───────────────────
    const apagar = await api(`${O}/notes/${terceira.id}`, { method: 'DELETE' }, admin!);
    const corpoApagar = (await apagar.json()) as { error?: string };
    check('excluir registro clínico → 400', apagar.status === 400, String(apagar.status));
    check('a resposta explica que o caminho é retificar', /retific/i.test(String(corpoApagar.error)), String(corpoApagar.error).slice(0, 90));
    // A prova que importa: o registro recusado continua NO BANCO (nada foi apagado).
    const aindaExiste = db.prepare(
      'SELECT COUNT(*) AS t FROM odonto_clinical_notes WHERE id = ? AND deleted_at IS NULL',
    ).get(terceira.id) as { t: number };
    check('o registro recusado continua no banco', aindaExiste.t === 1, `${aindaExiste.t} linha(s) com esse id`);
    const todas = db.prepare('SELECT COUNT(*) AS t FROM odonto_clinical_notes WHERE patient_id = ? AND deleted_at IS NULL')
      .get(paciente) as { t: number };
    check('todas as versões continuam gravadas', todas.t === 4, `${todas.t} linha(s)`);

    // ── Permissões ─────────────────────────────────────────────────────────
    const roleRes = await api('/api/roles', { method: 'POST', body: JSON.stringify({ name: 'Clínica sem retificar' }) }, admin!);
    const role = await unwrap<{ id: number; slug: string }>(roleRes);
    await api(`/api/roles/${role.id}/permissions`, {
      method: 'PUT',
      body: JSON.stringify({ permissions: ['odonto.patients.view', 'odonto.clinical.view', 'odonto.clinical.edit'] }),
    }, admin!);
    await api('/api/users', {
      method: 'POST', body: JSON.stringify({ username: 'clinico', name: 'Clínico', password: 'Teste1234', roleSlug: role.slug }),
    }, admin!);
    const clinico = await loginAs('clinico', 'Teste1234');
    check('login do usuário clínico', clinico !== null);
    check('sem odonto.clinical.retify não retifica (403)', (await api(`${O}/notes/${terceira.id}/retify`, {
      method: 'POST', body: JSON.stringify({ observations: 'tentativa', motivo: 'sem permissão para retificar' }),
    }, clinico!)).status === 403);
    check('com clinical.edit registra evolução normalmente', (await api(`${O}/patients/${paciente}/notes`, {
      method: 'POST', body: JSON.stringify({ observations: 'Registro feito pelo clínico.' }),
    }, clinico!)).status === 201);

    const roleSemClinica = await unwrap<{ id: number; slug: string }>(
      await api('/api/roles', { method: 'POST', body: JSON.stringify({ name: 'Recepção sem clínica' }) }, admin!),
    );
    await api(`/api/roles/${roleSemClinica.id}/permissions`, {
      method: 'PUT', body: JSON.stringify({ permissions: ['odonto.patients.view'] }),
    }, admin!);
    await api('/api/users', {
      method: 'POST', body: JSON.stringify({ username: 'recepcao_pr', name: 'Recepção', password: 'Teste1234', roleSlug: roleSemClinica.slug }),
    }, admin!);
    const recepcao = await loginAs('recepcao_pr', 'Teste1234');
    check('sem permissão clínica não vê o prontuário (403)',
      (await api(`${O}/patients/${paciente}/notes`, {}, recepcao!)).status === 403);
    check('sem permissão clínica não registra evolução (403)', (await api(`${O}/patients/${paciente}/notes`, {
      method: 'POST', body: JSON.stringify({ observations: 'tentativa' }),
    }, recepcao!)).status === 403);

    // ── Auditoria: registra o ato, sem o conteúdo clínico ──────────────────
    const logs = db.prepare(
      "SELECT action, after_json FROM audit_logs WHERE entity = 'odonto_clinical_note' ORDER BY id",
    ).all() as { action: string; after_json: string | null }[];
    check('auditoria registrou criação e retificações', logs.length >= 5, `${logs.length} registro(s)`);
    check('auditoria NÃO copia as observações clínicas',
      !logs.some((l) => (l.after_json ?? '').includes(OBSERVACAO)));
    check('auditoria registra o motivo da retificação (justificativa do ato)',
      logs.some((l) => (l.after_json ?? '').includes(MOTIVO)));
    check('auditoria diz qual versão foi criada',
      logs.some((l) => (l.after_json ?? '').includes('"versao":3')));

    // ── Excluir o paciente leva o prontuário junto ─────────────────────────
    await api(`${O}/patients/${paciente}`, { method: 'DELETE' }, admin!);
    const restantes = db.prepare(
      'SELECT COUNT(*) AS t FROM odonto_clinical_notes WHERE patient_id = ? AND deleted_at IS NULL',
    ).get(paciente) as { t: number };
    check('prontuário do paciente excluído sai por soft delete', restantes.t === 0, `${restantes.t} linha(s)`);
    check('prontuário de paciente excluído não é acessível (404)', (await api(`${O}/patients/${paciente}/notes`, {}, admin!)).status === 404);

    // ── Módulo fora do plano → API bloqueada ──────────────────────────────
    db.prepare(`UPDATE license SET modules_json = ?, license_key = 'teste', company_uuid = 'teste' WHERE id = 1`)
      .run(JSON.stringify(['commercial', 'finance']));
    check('módulo fora do plano → 403 no prontuário', (await api(`${O}/patients/${outro}/notes`, {}, admin!)).status === 403);
    db.prepare(`UPDATE license SET modules_json = NULL, license_key = NULL, company_uuid = NULL WHERE id = 1`).run();
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  console.log(failures === 0 ? '\nProntuário odonto: TODOS OS TESTES PASSARAM' : `\n${failures} falha(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
