/**
 * Teste de integração da anamnese do módulo odonto (PR §5).
 *
 * O que a PR exige e este teste prova: formulário flexível, respostas vinculadas ao paciente
 * com data/hora/responsável, **histórico preservado** (atualizar o formulário não apaga
 * respostas anteriores) e permissão clínica própria — mais a minimização do log de auditoria
 * (o conteúdo das respostas NÃO é copiado para `audit_logs`).
 *
 * KIVO_DB_PATH TEM que vir do ambiente — rode com
 *   node scripts/test-isolated.js src/tests/odonto-anamnese.ts
 */
import { migrateUp } from '../core/database/migrator';
import { runSeeds } from '../core/database/seeds';
import { getSqlite } from '../core/database/connection';
import { createServer } from '../core/server';
import { resetTestDb, activateTestLicense } from './resetTestDb';
import { unwrap } from './testUtils';

const PORT = Number(process.env.KIVO_PORT ?? 3845);
const base = `http://localhost:${PORT}`;
const O = '/api/odonto';
/** Resposta que só existe na anamnese — usada para provar que ela não vaza para o log. */
const QUEIXA = 'Sensibilidade no dente 26 ao frio (teste)';
const ALERGIA = 'Alergia a dipirona (teste anamnese)';

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

interface Field { key: string; label: string; type: string; required?: boolean; options?: string[] }
interface Template { id: number; name: string; version: number; fields: Field[]; is_default: boolean }
interface Form {
  id: number;
  revision: number;
  template_id: number;
  template_version: number;
  answers: Record<string, unknown>;
  filled_by_name: string | null;
  filled_at: string;
}
interface PatientAnamnesis {
  summary: { revisions: number; last_filled_at: string | null; last_revision: number | null; last_template_name: string | null };
  current: Form | null;
  history: Form[];
  template: Template | null;
  templates: Template[];
  has_anamnesis: boolean;
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
    check('sem login → 401', (await api(`${O}/patients/1/anamnesis`)).status === 401);

    // ── Paciente ───────────────────────────────────────────────────────────
    const paciente = await api(`${O}/patients`, {
      method: 'POST',
      body: JSON.stringify({ name: 'João Anamnese (teste)', phone: '(69) 98888-0000' }),
    }, admin!);
    const patientId = (await unwrap<{ id: number }>(paciente)).id;
    check('paciente criado para a anamnese', patientId > 0);

    // ── Formulário padrão ──────────────────────────────────────────────────
    const templates = await unwrap<Template[]>(await api(`${O}/anamnesis/templates`, {}, admin!));
    check('formulário padrão criado no boot', templates.length === 1, `${templates.length} formulário(s)`);
    const padrao = templates[0];
    check('formulário padrão é a Anamnese odontológica v1',
      padrao?.name === 'Anamnese odontológica' && padrao?.version === 1 && padrao?.is_default === true,
      JSON.stringify({ nome: padrao?.name, versao: padrao?.version, padrao: padrao?.is_default }));
    check('formulário tem os campos da PR (queixa, alergias, histórico, hábitos)',
      ['queixa_principal', 'historico_medico', 'alergias', 'medicamentos', 'habitos', 'historico_odontologico']
        .every((k) => padrao.fields.some((f) => f.key === k)),
      padrao.fields.map((f) => f.key).join(', ').slice(0, 120));
    check('queixa principal é obrigatória', padrao.fields.find((f) => f.key === 'queixa_principal')?.required === true);
    check('hábitos é múltipla escolha com opções',
      padrao.fields.find((f) => f.key === 'habitos')?.type === 'multipla'
      && (padrao.fields.find((f) => f.key === 'habitos')?.options?.length ?? 0) > 1);

    // ── Resposta 1 ─────────────────────────────────────────────────────────
    const respostas1 = {
      queixa_principal: QUEIXA,
      alergias: ALERGIA,
      habitos: ['Fumo'],
      pressao_alta: 'sim',
      ultima_consulta: '2026-03-10',
    };
    const salvo1 = await api(`${O}/patients/${patientId}/anamnesis`, {
      method: 'POST',
      body: JSON.stringify({ answers: respostas1 }),
    }, admin!);
    check('anamnese respondida (201)', salvo1.status === 201, String(salvo1.status));
    const form1 = await unwrap<Form>(salvo1);
    check('primeira resposta é a revisão 1', form1.revision === 1, String(form1.revision));
    check('revisão guarda o formulário e a versão usados',
      form1.template_id === padrao.id && form1.template_version === 1,
      JSON.stringify({ template_id: form1.template_id, versao: form1.template_version }));
    check('respostas gravadas como enviadas',
      form1.answers.queixa_principal === QUEIXA && form1.answers.pressao_alta === 'sim'
      && JSON.stringify(form1.answers.habitos) === JSON.stringify(['Fumo']),
      JSON.stringify(form1.answers).slice(0, 120));
    check('revisão registra o usuário responsável', form1.filled_by_name === 'admin', String(form1.filled_by_name));
    check('revisão registra data e hora', /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(form1.filled_at), form1.filled_at);

    const detalhe = await unwrap<PatientAnamnesis>(await api(`${O}/patients/${patientId}/anamnesis`, {}, admin!));
    check('ficha do paciente mostra a anamnese atual', detalhe.current?.revision === 1 && detalhe.has_anamnesis === true);
    check('resumo conta 1 revisão', detalhe.summary.revisions === 1 && detalhe.summary.last_revision === 1,
      JSON.stringify(detalhe.summary));
    check('formulário sugerido vem na resposta', detalhe.template?.id === padrao.id);

    // ── Resposta 2: histórico NÃO é sobrescrito (PR §5 e §24.3) ────────────
    const salvo2 = await api(`${O}/patients/${patientId}/anamnesis`, {
      method: 'POST',
      body: JSON.stringify({ answers: { queixa_principal: 'Sem dor hoje.', alergias: ALERGIA, habitos: [] } }),
    }, admin!);
    const form2 = await unwrap<Form>(salvo2);
    check('segunda resposta é a revisão 2', form2.revision === 2, String(form2.revision));

    const depois = await unwrap<PatientAnamnesis>(await api(`${O}/patients/${patientId}/anamnesis`, {}, admin!));
    check('histórico tem as duas revisões', depois.history.length === 2, `${depois.history.length} revisão(ões)`);
    const revisao1 = depois.history.find((h) => h.revision === 1);
    check('revisão 1 continua com a resposta original',
      revisao1?.answers.queixa_principal === QUEIXA, String(revisao1?.answers.queixa_principal));
    check('revisão 2 tem a resposta nova', depois.current?.answers.queixa_principal === 'Sem dor hoje.');
    check('revisões são imutáveis entre si (ids diferentes)',
      revisao1?.id !== depois.current?.id, `${revisao1?.id} x ${depois.current?.id}`);

    // ── Validação ──────────────────────────────────────────────────────────
    const semObrigatoria = await api(`${O}/patients/${patientId}/anamnesis`, {
      method: 'POST', body: JSON.stringify({ answers: { alergias: 'nenhuma' } }),
    }, admin!);
    check('pergunta obrigatória vazia → 400', semObrigatoria.status === 400, String(semObrigatoria.status));

    const chaveInventada = await api(`${O}/patients/${patientId}/anamnesis`, {
      method: 'POST', body: JSON.stringify({ answers: { queixa_principal: 'x', pergunta_que_nao_existe: 'y' } }),
    }, admin!);
    check('pergunta inexistente → 400 (não guarda lixo)', chaveInventada.status === 400, String(chaveInventada.status));

    const simNaoInvalido = await api(`${O}/patients/${patientId}/anamnesis`, {
      method: 'POST', body: JSON.stringify({ answers: { queixa_principal: 'x', pressao_alta: 'talvez' } }),
    }, admin!);
    check('valor inválido em sim/não → 400', simNaoInvalido.status === 400, String(simNaoInvalido.status));

    const dataInvalida = await api(`${O}/patients/${patientId}/anamnesis`, {
      method: 'POST', body: JSON.stringify({ answers: { queixa_principal: 'x', ultima_consulta: '10/03/2026' } }),
    }, admin!);
    check('data em formato errado → 400', dataInvalida.status === 400, String(dataInvalida.status));

    const textoLongo = await api(`${O}/patients/${patientId}/anamnesis`, {
      method: 'POST', body: JSON.stringify({ answers: { queixa_principal: 'a'.repeat(4001) } }),
    }, admin!);
    check('texto acima do limite → 400', textoLongo.status === 400, String(textoLongo.status));

    const opcaoInvalida = await api(`${O}/patients/${patientId}/anamnesis`, {
      method: 'POST', body: JSON.stringify({ answers: { queixa_principal: 'x', habitos: ['Fumar cachimbo'] } }),
    }, admin!);
    check('opção fora da lista → 400', opcaoInvalida.status === 400, String(opcaoInvalida.status));

    const nadaMudou = await unwrap<PatientAnamnesis>(await api(`${O}/patients/${patientId}/anamnesis`, {}, admin!));
    check('resposta inválida não cria revisão', nadaMudou.history.length === 2, `${nadaMudou.history.length} revisão(ões)`);

    // ── Nova versão do formulário não apaga as respostas antigas ───────────
    const versao2 = await api(`${O}/anamnesis/templates`, {
      method: 'POST',
      body: JSON.stringify({
        name: 'Anamnese odontológica',
        fields: [
          ...padrao.fields.map((f) => ({ key: f.key, label: f.label, type: f.type, required: !!f.required, options: f.options })),
          { key: 'usa_protese', label: 'Usa prótese dentária', type: 'sim_nao' },
        ],
        is_default: true,
      }),
    }, admin!);
    check('nova versão do formulário publicada (201)', versao2.status === 201, String(versao2.status));
    const v2 = await unwrap<Template>(versao2);
    check('nova versão é a 2 e ganhou a pergunta nova',
      v2.version === 2 && v2.fields.some((f) => f.key === 'usa_protese'),
      `v${v2.version} · ${v2.fields.length} campos`);

    const listaDepois = await unwrap<Template[]>(await api(`${O}/anamnesis/templates`, {}, admin!));
    check('lista mostra só a versão mais recente', listaDepois.length === 1 && listaDepois[0].version === 2);
    const versaoAnterior = await unwrap<Template>(await api(`${O}/anamnesis/templates/${padrao.id}`, {}, admin!));
    check('versão 1 continua acessível (não foi apagada)',
      versaoAnterior.version === 1 && !versaoAnterior.fields.some((f) => f.key === 'usa_protese'));

    const salvoV2 = await api(`${O}/patients/${patientId}/anamnesis`, {
      method: 'POST',
      body: JSON.stringify({ template_id: v2.id, answers: { queixa_principal: 'Controle semestral.', usa_protese: 'nao' } }),
    }, admin!);
    const formV2 = await unwrap<Form>(salvoV2);
    check('resposta na versão nova é a revisão 3 com template_version 2',
      formV2.revision === 3 && formV2.template_version === 2, JSON.stringify({ r: formV2.revision, v: formV2.template_version }));

    const antigas = await unwrap<PatientAnamnesis>(await api(`${O}/patients/${patientId}/anamnesis`, {}, admin!));
    check('as 3 revisões continuam no histórico', antigas.history.length === 3, `${antigas.history.length}`);
    check('as revisões antigas continuam na versão 1 do formulário',
      antigas.history.filter((h) => h.template_version === 1).length === 2);

    // ── Recepção: sem permissão clínica, sem anamnese ──────────────────────
    const roleRes = await api('/api/roles', { method: 'POST', body: JSON.stringify({ name: 'Recepção Anamnese' }) }, admin!);
    const role = await unwrap<{ id: number; slug: string }>(roleRes);
    await api(`/api/roles/${role.id}/permissions`, {
      method: 'PUT',
      body: JSON.stringify({ permissions: ['odonto.patients.view'] }),
    }, admin!);
    await api('/api/users', {
      method: 'POST',
      body: JSON.stringify({ username: 'recepcao_an', name: 'Recepção', password: 'Teste1234', roleSlug: role.slug }),
    }, admin!);
    const recepcao = await loginAs('recepcao_an', 'Teste1234');
    check('login da recepção', recepcao !== null);

    check('recepção não lista formulários (403)',
      (await api(`${O}/anamnesis/templates`, {}, recepcao!)).status === 403);
    check('recepção não vê a anamnese do paciente (403)',
      (await api(`${O}/patients/${patientId}/anamnesis`, {}, recepcao!)).status === 403);
    check('recepção não responde anamnese (403)',
      (await api(`${O}/patients/${patientId}/anamnesis`, {
        method: 'POST', body: JSON.stringify({ answers: { queixa_principal: 'x' } }),
      }, recepcao!)).status === 403);
    check('recepção não abre uma revisão (403)',
      (await api(`${O}/anamnesis/${form1.id}`, {}, recepcao!)).status === 403);
    check('recepção não publica formulário (403)',
      (await api(`${O}/anamnesis/templates`, {
        method: 'POST', body: JSON.stringify({ name: 'X', fields: [{ key: 'a', label: 'A', type: 'texto' }] }),
      }, recepcao!)).status === 403);

    // ── Auditoria: registra o ato, não o conteúdo ──────────────────────────
    const logs = db.prepare(
      "SELECT action, entity, entity_id, after_json FROM audit_logs WHERE entity = 'odonto_anamnesis' ORDER BY id",
    ).all() as { action: string; entity: string; entity_id: number; after_json: string | null }[];
    check('auditoria registrou as anamneses', logs.length === 3, `${logs.length} registro(s)`);
    check('auditoria diz qual revisão foi gravada',
      (logs[0]?.after_json ?? '').includes('"revision":1'), String(logs[0]?.after_json).slice(0, 120));
    check('auditoria NÃO copia o conteúdo clínico',
      !logs.some((l) => (l.after_json ?? '').includes(QUEIXA) || (l.after_json ?? '').includes(ALERGIA)));

    const logsTemplate = db.prepare(
      "SELECT after_json FROM audit_logs WHERE entity = 'odonto_anamnesis_template'",
    ).all() as { after_json: string | null }[];
    check('auditoria do formulário registra versão e quantidade de perguntas',
      logsTemplate.length === 1 && (logsTemplate[0]?.after_json ?? '').includes('"version":2'),
      String(logsTemplate[0]?.after_json).slice(0, 120));

    // ── Excluir o paciente leva a anamnese junto ───────────────────────────
    await api(`${O}/patients/${patientId}`, { method: 'DELETE' }, admin!);
    const depoisDeExcluir = await api(`${O}/patients/${patientId}/anamnesis`, {}, admin!);
    check('anamnese de paciente excluído não é mais acessível', depoisDeExcluir.status === 404, String(depoisDeExcluir.status));
    const restantes = db.prepare(
      'SELECT COUNT(*) AS t FROM odonto_anamnesis_forms WHERE patient_id = ? AND deleted_at IS NULL',
      ).get(patientId) as { t: number };
    check('revisões ficaram com soft delete (histórico preservado no banco)', restantes.t === 0);

    // ── Módulo fora do plano → API bloqueada (mesma regra dos pacientes) ────
    db.prepare(`UPDATE license SET modules_json = ?, license_key = 'teste', company_uuid = 'teste' WHERE id = 1`)
      .run(JSON.stringify(['commercial', 'finance']));
    check('módulo fora do plano → 403 na anamnese',
      (await api(`${O}/anamnesis/templates`, {}, admin!)).status === 403);
    db.prepare(`UPDATE license SET modules_json = NULL, license_key = NULL, company_uuid = NULL WHERE id = 1`).run();
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  console.log(failures === 0 ? '\nAnamnese odonto: TODOS OS TESTES PASSARAM' : `\n${failures} falha(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
