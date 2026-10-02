/**
 * Teste de integração do módulo odonto — fundação e pacientes (PR §4).
 *
 * Cobre: paciente ancorado no cliente (`customers`), ficha clínica atrás de permissão
 * própria, profissionais com CRO, procedimentos, exclusão que preserva o cliente e a
 * minimização do log de auditoria (o conteúdo clínico NÃO é copiado para `audit_logs`).
 *
 * KIVO_DB_PATH TEM que vir do ambiente — rode com
 *   node scripts/test-isolated.js src/tests/odonto-patients.ts
 */
import { migrateUp } from '../core/database/migrator';
import { runSeeds } from '../core/database/seeds';
import { getSqlite } from '../core/database/connection';
import { createServer } from '../core/server';
import { resetTestDb, activateTestLicense } from './resetTestDb';
import { unwrap } from './testUtils';

const PORT = Number(process.env.KIVO_PORT ?? 3844);
const base = `http://localhost:${PORT}`;
const O = '/api/odonto';
/** Texto que só existe na ficha clínica — usado para provar que ele não vaza. */
const ALERGIA = 'Alergia a dipirona (teste)';

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

interface PatientDetail {
  id: number;
  customer_id: number;
  name: string;
  document: string | null;
  has_clinical: number;
  clinical?: { allergies: string | null } | null;
}

async function main(): Promise<void> {
  resetTestDb();
  migrateUp();
  runSeeds();
  activateTestLicense();
  const { app } = await createServer();
  const server = app.listen(PORT);

  try {
    const admin = await loginAs('admin', 'admin');
    check('login admin', admin !== null);

    // ── Sem sessão não passa ────────────────────────────────────────────────
    check('sem login → 401', (await api(`${O}/patients`)).status === 401);

    // ── Cadastro de paciente (cria o cliente por baixo) ─────────────────────
    const created = await api(`${O}/patients`, {
      method: 'POST',
      body: JSON.stringify({
        name: 'Maria Souza (teste odonto)',
        document: '529.982.247-25',
        phone: '(69) 99999-0000',
        birthday: '1985-04-12',
        sex: 'feminino',
        rg: '1234567',
        notes: 'Prefere atendimento pela manhã.',
        clinical: { allergies: ALERGIA, medical_history: 'Hipertensão controlada.' },
      }),
    }, admin!);
    check('paciente criado (201)', created.status === 201, String(created.status));
    const patientId = (await unwrap<{ id: number }>(created)).id;

    const detail = await unwrap<PatientDetail>(await api(`${O}/patients/${patientId}`, {}, admin!));
    check('nome vem do cadastro de cliente', detail.name === 'Maria Souza (teste odonto)', detail.name);
    check('data de nascimento vem de customers.birthday', detail.has_clinical === 1);
    check('admin vê a ficha clínica', detail.clinical?.allergies === ALERGIA, String(detail.clinical?.allergies));

    const list = await unwrap<PatientDetail[]>(await api(`${O}/patients?q=Maria`, {}, admin!));
    check('lista encontra o paciente pela busca', list.length === 1 && list[0].id === patientId);

    // O cliente precisa existir para a cobrança do tratamento funcionar depois.
    const customers = await unwrap<{ id: number; name: string }[]>(
      await api('/api/commercial/customers?q=Maria Souza', {}, admin!),
    );
    check('cliente criado no commercial (âncora do paciente)', customers.length === 1 &&
      customers[0].id === detail.customer_id);

    // ── Validações ─────────────────────────────────────────────────────────
    const cpfRuim = await api(`${O}/patients`, { method: 'POST', body: JSON.stringify({ name: 'X', document: '111.111.111-11' }) }, admin!);
    check('CPF inválido → 400', cpfRuim.status === 400, String(cpfRuim.status));

    const cpfDuplicado = await api(`${O}/patients`, { method: 'POST', body: JSON.stringify({ name: 'Outra', document: '52998224725' }) }, admin!);
    check('CPF já cadastrado → 409', cpfDuplicado.status === 409, String(cpfDuplicado.status));

    // ── Recepção: cadastro sim, clínica não (PR §19) ────────────────────────
    const roleRes = await api('/api/roles', { method: 'POST', body: JSON.stringify({ name: 'Recepção Odonto' }) }, admin!);
    const role = await unwrap<{ id: number; slug: string }>(roleRes);
    await api(`/api/roles/${role.id}/permissions`, {
      method: 'PUT',
      body: JSON.stringify({
        permissions: ['odonto.patients.view', 'odonto.patients.create', 'odonto.patients.edit'],
      }),
    }, admin!);
    await api('/api/users', {
      method: 'POST',
      body: JSON.stringify({ username: 'recepcao', name: 'Recepção', password: 'Teste1234', roleSlug: role.slug }),
    }, admin!);
    const recepcao = await loginAs('recepcao', 'Teste1234');
    check('login da recepção', recepcao !== null);

    const recepList = await api(`${O}/patients`, {}, recepcao!);
    check('recepção lista pacientes (tem view)', recepList.status === 200, String(recepList.status));

    const recepDetail = await unwrap<PatientDetail>(await api(`${O}/patients/${patientId}`, {}, recepcao!));
    check('recepção NÃO recebe o conteúdo clínico', !('clinical' in recepDetail),
      JSON.stringify(Object.keys(recepDetail)));
    check('recepção vê o cadastro do paciente', recepDetail.name === 'Maria Souza (teste odonto)');

    const recepCreateClinical = await api(`${O}/patients`, {
      method: 'POST',
      body: JSON.stringify({ name: 'Paciente Sem Permissão', clinical: { allergies: 'Nada' } }),
    }, recepcao!);
    check('recepção não cria ficha clínica (403)', recepCreateClinical.status === 403, String(recepCreateClinical.status));

    const recepEditClinical = await api(`${O}/patients/${patientId}`, {
      method: 'PUT',
      body: JSON.stringify({ clinical: { allergies: 'Tentativa da recepção' } }),
    }, recepcao!);
    check('recepção não altera ficha clínica (403)', recepEditClinical.status === 403, String(recepEditClinical.status));

    const recepEditCadastro = await api(`${O}/patients/${patientId}`, {
      method: 'PUT',
      body: JSON.stringify({ phone: '(69) 98888-1111' }),
    }, recepcao!);
    check('recepção edita cadastro (tem edit)', recepEditCadastro.status === 200, String(recepEditCadastro.status));
    const afterRecep = await unwrap<PatientDetail>(await api(`${O}/patients/${patientId}`, {}, admin!));
    check('telefone atualizado sem apagar a ficha clínica',
      afterRecep.clinical?.allergies === ALERGIA, String(afterRecep.clinical?.allergies));

    check('recepção não acessa profissionais (403)',
      (await api(`${O}/professionals`, {}, recepcao!)).status === 403);
    check('recepção não cadastra profissional (403)',
      (await api(`${O}/professionals`, { method: 'POST', body: JSON.stringify({ name: 'X' }) }, recepcao!)).status === 403);

    // ── Profissionais ──────────────────────────────────────────────────────
    const prof = await api(`${O}/professionals`, {
      method: 'POST',
      body: JSON.stringify({ name: 'Dr. João Prado', cro: '12345', cro_state: 'mt', specialties: 'Endodontia' }),
    }, admin!);
    check('profissional criado (201)', prof.status === 201, String(prof.status));
    const profId = (await unwrap<{ id: number }>(prof)).id;

    const profCroDuplicado = await api(`${O}/professionals`, {
      method: 'POST',
      body: JSON.stringify({ name: 'Outro', cro: '12345', cro_state: 'MT' }),
    }, admin!);
    check('CRO repetido → 400', profCroDuplicado.status === 400, String(profCroDuplicado.status));

    const profLista = await unwrap<{ id: number; cro_state: string | null }[]>(await api(`${O}/professionals`, {}, admin!));
    check('UF do CRO normalizada para maiúsculas',
      profLista.some((p) => p.id === profId && p.cro_state === 'MT'));

    // ── Procedimentos ──────────────────────────────────────────────────────
    const proc = await api(`${O}/procedures`, {
      method: 'POST',
      body: JSON.stringify({ name: 'Restauração em resina', code: 'REST-01', category: 'Dentística', default_price_cents: 25000, duration_min: 60 }),
    }, admin!);
    check('procedimento criado (201)', proc.status === 201, String(proc.status));
    const procId = (await unwrap<{ id: number }>(proc)).id;

    check('código de procedimento repetido → 400',
      (await api(`${O}/procedures`, { method: 'POST', body: JSON.stringify({ name: 'Outro', code: 'REST-01' }) }, admin!)).status === 400);

    const procEdit = await api(`${O}/procedures/${procId}`, {
      method: 'PUT',
      body: JSON.stringify({ default_price_cents: 31000 }),
    }, admin!);
    check('procedimento atualizado', procEdit.status === 200, String(procEdit.status));
    check('valor do procedimento gravado em centavos',
      (await unwrap<{ default_price_cents: number }>(await api(`${O}/procedures/${procId}`, {}, admin!))).default_price_cents === 31000);

    check('procedimento excluído', (await api(`${O}/procedures/${procId}`, { method: 'DELETE' }, admin!)).status === 200);
    check('procedimento fora da lista',
      !(await unwrap<{ id: number }[]>(await api(`${O}/procedures`, {}, admin!))).some((p) => p.id === procId));

    // ── Auditoria: registra o ato, não o conteúdo clínico ───────────────────
    const auditRaw = await (await api('/api/audit?limit=500', {}, admin!)).text();
    check('auditoria registra odonto_patient', auditRaw.includes('odonto_patient'));
    check('auditoria NÃO copia o conteúdo clínico', !auditRaw.includes(ALERGIA));

    // ── Excluir paciente preserva o cliente ────────────────────────────────
    check('paciente excluído', (await api(`${O}/patients/${patientId}`, { method: 'DELETE' }, admin!)).status === 200);
    check('paciente fora da lista',
      !(await unwrap<{ id: number }[]>(await api(`${O}/patients`, {}, admin!))).some((p) => p.id === patientId));
    const customerAfter = await unwrap<{ id: number }[]>(
      await api(`/api/commercial/customers?q=Maria Souza`, {}, admin!),
    );
    check('cliente permanece após excluir a ficha', customerAfter.length === 1);

    // ── Gate de plano: módulo fora da licença não responde ─────────────────
    // O plano (modules_json) decide ACESSO, não carga — mas o gate só vale com licença
    // configurada: sem `license_key`/`company_uuid` o Core é fail-open de propósito
    // (primeiro boot não pode travar). Por isso o teste configura a licença inteira.
    const db = getSqlite();
    const setLicense = (modules: string[] | null) =>
      db.prepare(`UPDATE license SET modules_json = ?, license_key = 'teste', company_uuid = 'teste' WHERE id = 1`)
        .run(modules ? JSON.stringify(modules) : null);
    setLicense(['commercial', 'finance']);
    check('módulo fora do plano → 403 na API', (await api(`${O}/patients`, {}, admin!)).status === 403);
    setLicense(['commercial', 'finance', 'odonto']);
    check('módulo incluído no plano → 200', (await api(`${O}/patients`, {}, admin!)).status === 200);
    // Devolve a licença ao estado de licença ativada sem plano (fail-open), como estava.
    db.prepare(`UPDATE license SET modules_json = NULL, license_key = NULL, company_uuid = NULL WHERE id = 1`).run();
  } finally {
    server.close();
  }

  console.log(failures === 0 ? '\nOdonto (pacientes): TODOS OS TESTES PASSARAM' : `\n${failures} falha(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
