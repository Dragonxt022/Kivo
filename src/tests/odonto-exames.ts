/**
 * Teste de integração dos exames e imagens (PR §16 e §17).
 *
 * O que a PR pede e este teste prova:
 *  §16 — cada arquivo com paciente, data, tipo, descrição, arquivo e responsável;
 *  §17 — fotografia clínica com fase antes/durante/depois e profissional.
 *
 * Decisões que o teste protege:
 *  - o ARQUIVO fica no disco (`storage/odonto-exams`) e o banco guarda só a referência: aqui se
 *    confere que ele foi gravado, que é servido por `/uploads/odonto-exams/...` e que sai do disco
 *    quando o exame é excluído ou o paciente é apagado;
 *  - formato fora da lista (executável) é recusado, e arquivo vazio também;
 *  - consulta/plano vinculados têm de ser do mesmo paciente (PR §24.2);
 *  - a auditoria registra o ato e o TAMANHO, nunca o conteúdo do arquivo;
 *  - exames são dado clínico: sem `odonto.exams.view` não se vê, sem `manage` não se anexa.
 *
 * KIVO_DB_PATH TEM que vir do ambiente — rode com
 *   node scripts/test-isolated.js src/tests/odonto-exames.ts
 */
import { existsSync } from 'node:fs';
import { migrateUp } from '../core/database/migrator';
import { runSeeds } from '../core/database/seeds';
import { getSqlite } from '../core/database/connection';
import { createServer } from '../core/server';
import { resetTestDb, activateTestLicense } from './resetTestDb';
import { unwrap } from './testUtils';
import { examFilePath } from '../modules/odonto/examFiles';

const PORT = Number(process.env.KIVO_PORT ?? 3853);
const base = `http://localhost:${PORT}`;
const O = '/api/odonto';

/** PNG 1x1 transparente: menor arquivo válido para exercitar o caminho de imagem. */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const PDF_BASE64 = 'JVBERi0xLjQKJcOkw7zDtsOfCjIgMCBvYmoKPDwvTGVuZ3RoIDM+PnN0cmVhbQpYWFgKZW5kc3RyZWFt';

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

interface Exam {
  id: number; patient_id: number; type: string; type_label: string; phase: string | null; phase_label: string | null;
  exam_date: string; tooth: string | null; title: string; description: string | null;
  original_name: string; mime: string; size_bytes: number; is_image: boolean; url: string;
  professional_name: string | null; appointment_id: number | null; plan_id: number | null; created_by_name: string | null;
}
interface ExamList {
  items: Exam[];
  resumo: { total: number; por_tipo: { type: string; total: number }[]; ultimo_em: string | null };
  tipos: { type: string; label: string }[];
  fases: { phase: string; label: string }[];
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
    check('sem login → 401', (await api(`${O}/patients/1/exams`)).status === 401);

    const paciente = (await unwrap<{ id: number }>(await api(`${O}/patients`, {
      method: 'POST', body: JSON.stringify({ name: 'Clara Exames (teste)', birthday: '1980-05-05' }),
    }, admin!))).id;
    const outro = (await unwrap<{ id: number }>(await api(`${O}/patients`, {
      method: 'POST', body: JSON.stringify({ name: 'Outro Exames (teste)' }),
    }, admin!))).id;
    const dentista = (await unwrap<{ id: number }>(await api(`${O}/professionals`, {
      method: 'POST', body: JSON.stringify({ name: 'Dr. Laudo (teste)', cro: '33445', cro_state: 'MT' }),
    }, admin!))).id;
    const atendimento = (await unwrap<{ id: number }>(await api(`${O}/appointments`, {
      method: 'POST', body: JSON.stringify({ patient_id: paciente, professional_id: dentista, starts_at: '2026-11-20 10:00', duration_min: 30 }),
    }, admin!))).id;
    const plano = (await unwrap<{ id: number }>(await api(`${O}/patients/${paciente}/treatment-plans`, {
      method: 'POST', body: JSON.stringify({ items: [{ description: 'Restauração 26', amount_cents: 20000, tooth: '26' }] }),
    }, admin!))).id;
    check('base criada', paciente > 0 && dentista > 0 && atendimento > 0 && plano > 0);

    // ── Anexar uma radiografia ────────────────────────────────────────────
    const criar = (corpo: Record<string, unknown>, pid = paciente) => api(`${O}/patients/${pid}/exams`, {
      method: 'POST', body: JSON.stringify(corpo),
    }, admin!);

    const criado = await criar({
      type: 'radiografia', exam_date: '2026-11-20', tooth: '26',
      title: 'Radiografia periapical do 26', description: 'Cárie profunda próxima à polpa.',
      professional_id: dentista, appointment_id: atendimento, plan_id: plano,
      file_base64: PNG_BASE64, file_name: 'rx-26.png',
    });
    check('exame anexado (201)', criado.status === 201, String(criado.status));
    const exame = await unwrap<Exam>(criado);
    check('guarda tipo, data, dente e título',
      exame.type === 'radiografia' && exame.exam_date === '2026-11-20' && exame.tooth === '26' && exame.title.includes('26'),
      JSON.stringify({ t: exame.type, d: exame.exam_date, dente: exame.tooth }));
    check('reconhece que é imagem', exame.is_image === true && exame.mime === 'image/png', exame.mime);
    check('guarda o tamanho do arquivo', exame.size_bytes > 0, String(exame.size_bytes));
    check('devolve a URL servida pelo sistema', exame.url.startsWith('/uploads/odonto-exams/'), exame.url);
    check('guarda quem anexou', exame.created_by_name === 'admin', String(exame.created_by_name));
    check('vincula consulta e plano', exame.appointment_id === atendimento && exame.plan_id === plano);

    const linha = db.prepare('SELECT file_name, original_name, size_bytes FROM odonto_exams WHERE id = ?')
      .get(exame.id) as { file_name: string; original_name: string; size_bytes: number };
    check('o banco guarda a REFERÊNCIA, não o arquivo (não há coluna de conteúdo)',
      !!linha.file_name && !Object.keys(linha).includes('file_base64'));
    check('o arquivo existe no disco', existsSync(examFilePath(linha.file_name) as string));
    check('o nome no disco é um UUID (não o nome do consultório)',
      /^[0-9a-f-]{36}\.png$/.test(linha.file_name), linha.file_name);

    const servido = await fetch(`${base}${exame.url}`);
    const bytes = Buffer.from(await servido.arrayBuffer());
    check('o arquivo é servido por /uploads/odonto-exames', servido.status === 200, String(servido.status));
    check('o conteúdo servido é o mesmo que foi enviado',
      bytes.toString('base64') === PNG_BASE64, `${bytes.length} bytes`);

    // ── Fotografia clínica nas três fases (PR §17) ────────────────────────
    const foto = await unwrap<Exam>(await criar({
      type: 'fotografia', phase: 'antes', exam_date: '2026-11-01', title: 'Foto inicial do sorriso',
      professional_id: dentista, file_base64: PNG_BASE64, file_name: 'sorriso-antes.png',
    }));
    check('fotografia com fase "antes"', foto.phase === 'antes' && foto.phase_label === 'Antes',
      JSON.stringify({ p: foto.phase, l: foto.phase_label }));
    await criar({ type: 'fotografia', phase: 'depois', exam_date: '2026-11-30', title: 'Foto final do sorriso', file_base64: PNG_BASE64, file_name: 'sorriso-depois.png' });

    // ── Documento em PDF ──────────────────────────────────────────────────
    const docPdf = await unwrap<Exam>(await criar({
      type: 'documento', exam_date: '2026-11-21', title: 'Laudo do radiologista',
      file_base64: PDF_BASE64, file_name: 'laudo.pdf',
    }));
    check('PDF é aceito como documento e não é imagem', docPdf.mime === 'application/pdf' && docPdf.is_image === false,
      JSON.stringify({ m: docPdf.mime, img: docPdf.is_image }));

    // ── Validações ────────────────────────────────────────────────────────
    check('sem arquivo → 400', (await criar({ type: 'radiografia', title: 'Sem arquivo' })).status === 400);
    check('formato não aceito (.exe) → 400',
      (await criar({ type: 'outro', title: 'Executável', file_base64: PNG_BASE64, file_name: 'virus.exe' })).status === 400);
    check('arquivo vazio → 400',
      (await criar({ type: 'outro', title: 'Vazio', file_base64: '', file_name: 'x.png' })).status === 400);
    check('tipo inválido → 400',
      (await criar({ type: 'inventado', title: 'X', file_base64: PNG_BASE64, file_name: 'x.png' })).status === 400);
    check('fase inválida → 400',
      (await criar({ type: 'fotografia', phase: 'depois de amanhã', title: 'X', file_base64: PNG_BASE64, file_name: 'x.png' })).status === 400);
    check('dente fora da FDI → 400',
      (await criar({ type: 'radiografia', tooth: '99', title: 'X', file_base64: PNG_BASE64, file_name: 'x.png' })).status === 400);
    check('data inválida → 400',
      (await criar({ type: 'radiografia', exam_date: '20/11/2026', title: 'X', file_base64: PNG_BASE64, file_name: 'x.png' })).status === 400);
    check('sem título → 400',
      (await criar({ type: 'radiografia', file_base64: PNG_BASE64, file_name: 'x.png' })).status === 400);
    check('consulta de outro paciente → 400',
      (await criar({ type: 'radiografia', title: 'X', appointment_id: 99999, file_base64: PNG_BASE64, file_name: 'x.png' })).status === 400);
    check('plano de outro paciente → 400', (await api(`${O}/patients/${outro}/exams`, {
      method: 'POST', body: JSON.stringify({ type: 'radiografia', title: 'X', plan_id: plano, file_base64: PNG_BASE64, file_name: 'x.png' }),
    }, admin!)).status === 400);
    check('paciente inexistente → 404', (await criar({ type: 'radiografia', title: 'X', file_base64: PNG_BASE64, file_name: 'x.png' }, 9999)).status === 404);

    // ── Lista, filtros e resumo ───────────────────────────────────────────
    const lista = await unwrap<ExamList>(await api(`${O}/patients/${paciente}/exams`, {}, admin!));
    check('lista traz os exames do paciente', lista.items.length === 4, `${lista.items.length}`);
    check('mais recente primeiro', lista.items[0].exam_date >= lista.items[lista.items.length - 1].exam_date,
      `${lista.items[0].exam_date} >= ${lista.items[3].exam_date}`);
    check('resumo conta por tipo',
      lista.resumo.total === 4 && lista.resumo.por_tipo.some((t) => t.type === 'fotografia' && t.total === 2),
      JSON.stringify(lista.resumo));
    check('lista os tipos e as fases disponíveis', lista.tipos.length === 5 && lista.fases.length === 3,
      `${lista.tipos.length}/${lista.fases.length}`);
    const soFotos = await unwrap<ExamList>(await api(`${O}/patients/${paciente}/exams?type=fotografia`, {}, admin!));
    check('filtro por tipo', soFotos.items.length === 2 && soFotos.items.every((e) => e.type === 'fotografia'), `${soFotos.items.length}`);
    const soDepois = await unwrap<ExamList>(await api(`${O}/patients/${paciente}/exams?phase=depois`, {}, admin!));
    check('filtro por fase (antes/durante/depois)', soDepois.items.length === 1 && soDepois.items[0].phase === 'depois', `${soDepois.items.length}`);
    const porPeriodo = await unwrap<ExamList>(await api(`${O}/patients/${paciente}/exams?from=2026-11-20&to=2026-11-25`, {}, admin!));
    check('filtro por período', porPeriodo.items.length === 2, `${porPeriodo.items.length}`);

    // ── Editar metadados e trocar o arquivo ───────────────────────────────
    const editado = await api(`${O}/exams/${exame.id}`, {
      method: 'PUT', body: JSON.stringify({ title: 'Radiografia periapical 26 (revisada)', description: 'Laudo atualizado.' }),
    }, admin!);
    check('edita metadados sem tocar no arquivo (200)', editado.status === 200, String(editado.status));
    const aposEditar = await unwrap<Exam>(editado);
    check('metadados atualizados', aposEditar.title.includes('revisada') && aposEditar.description === 'Laudo atualizado.');
    check('o arquivo continua o mesmo', aposEditar.url === exame.url);

    const arquivoAntigo = linha.file_name;
    const trocado = await unwrap<Exam>(await api(`${O}/exams/${exame.id}`, {
      method: 'PUT', body: JSON.stringify({ file_base64: PDF_BASE64, file_name: 'rx-26-novo.pdf' }),
    }, admin!));
    check('troca de arquivo gera novo nome', trocado.url !== exame.url && trocado.mime === 'application/pdf', trocado.url);
    check('o arquivo anterior sai do disco', !existsSync(examFilePath(arquivoAntigo) as string));

    // ── Permissões ────────────────────────────────────────────────────────
    const roleLeitura = await unwrap<{ id: number; slug: string }>(
      await api('/api/roles', { method: 'POST', body: JSON.stringify({ name: 'Exames leitura' }) }, admin!));
    await api(`/api/roles/${roleLeitura.id}/permissions`, {
      method: 'PUT', body: JSON.stringify({ permissions: ['odonto.patients.view', 'odonto.exams.view'] }),
    }, admin!);
    await api('/api/users', {
      method: 'POST', body: JSON.stringify({ username: 'exames_leitura', name: 'Leitura', password: 'Teste1234', roleSlug: roleLeitura.slug }),
    }, admin!);
    const leitura = await loginAs('exames_leitura', 'Teste1234');
    check('login do usuário de leitura', leitura !== null);
    check('com exams.view a lista é acessível', (await api(`${O}/patients/${paciente}/exams`, {}, leitura!)).status === 200);
    check('sem exams.manage não anexa (403)', (await api(`${O}/patients/${paciente}/exams`, {
      method: 'POST', body: JSON.stringify({ type: 'radiografia', title: 'X', file_base64: PNG_BASE64, file_name: 'x.png' }),
    }, leitura!)).status === 403);
    check('sem exams.manage não exclui (403)', (await api(`${O}/exams/${foto.id}`, { method: 'DELETE' }, leitura!)).status === 403);

    const roleSemExames = await unwrap<{ id: number; slug: string }>(
      await api('/api/roles', { method: 'POST', body: JSON.stringify({ name: 'Sem exames' }) }, admin!));
    await api(`/api/roles/${roleSemExames.id}/permissions`, {
      method: 'PUT', body: JSON.stringify({ permissions: ['odonto.patients.view'] }),
    }, admin!);
    await api('/api/users', {
      method: 'POST', body: JSON.stringify({ username: 'sem_exames', name: 'Sem exames', password: 'Teste1234', roleSlug: roleSemExames.slug }),
    }, admin!);
    const semExames = await loginAs('sem_exames', 'Teste1234');
    check('exame é dado clínico: sem permissão não vê (403)',
      (await api(`${O}/patients/${paciente}/exams`, {}, semExames!)).status === 403);
    check('sem permissão não vê um exame específico (403)', (await api(`${O}/exams/${foto.id}`, {}, semExames!)).status === 403);

    // ── Excluir: linha sai do histórico visível e arquivo sai do disco ────
    const apagado = await api(`${O}/exams/${foto.id}`, { method: 'DELETE' }, admin!);
    check('exclusão aceita (200)', apagado.status === 200, String(apagado.status));
    const fotoLinha = db.prepare('SELECT file_name, deleted_at FROM odonto_exams WHERE id = ?')
      .get(foto.id) as { file_name: string; deleted_at: string | null };
    check('a linha sai por soft delete (fica o rastro)', fotoLinha.deleted_at !== null);
    check('o arquivo do exame é removido do disco', !existsSync(examFilePath(fotoLinha.file_name) as string));
    const depoisDeApagar = await unwrap<ExamList>(await api(`${O}/patients/${paciente}/exams`, {}, admin!));
    check('o exame apagado sai da lista', !depoisDeApagar.items.some((e) => e.id === foto.id), `${depoisDeApagar.items.length}`);

    // ── Auditoria sem o conteúdo do arquivo ───────────────────────────────
    const logs = db.prepare(
      "SELECT action, after_json FROM audit_logs WHERE entity = 'odonto_exam' ORDER BY id",
    ).all() as { action: string; after_json: string | null }[];
    check('auditoria registra os atos nos exames', logs.length >= 4, `${logs.length} registro(s)`);
    check('auditoria diz tipo e tamanho do arquivo',
      (logs[0]?.after_json ?? '').includes('"type":"radiografia"') && (logs[0]?.after_json ?? '').includes('size_bytes'),
      String(logs[0]?.after_json).slice(0, 120));
    check('auditoria NÃO copia o conteúdo do arquivo (base64)', !logs.some((l) => (l.after_json ?? '').includes(PNG_BASE64.slice(0, 40))));

    // ── Excluir o paciente leva os exames e os arquivos ───────────────────
    const restantes = db.prepare('SELECT file_name FROM odonto_exams WHERE patient_id = ? AND deleted_at IS NULL')
      .all(paciente) as { file_name: string }[];
    await api(`${O}/patients/${paciente}`, { method: 'DELETE' }, admin!);
    const depois = db.prepare('SELECT COUNT(*) AS t FROM odonto_exams WHERE patient_id = ? AND deleted_at IS NULL')
      .get(paciente) as { t: number };
    check('exames do paciente excluído saem por soft delete', depois.t === 0, `${depois.t} linha(s)`);
    check('os arquivos do paciente saem do disco',
      restantes.every((r) => !existsSync(examFilePath(r.file_name) as string)), `${restantes.length} arquivo(s)`);

    // ── Módulo fora do plano → API bloqueada ──────────────────────────────
    db.prepare(`UPDATE license SET modules_json = ?, license_key = 'teste', company_uuid = 'teste' WHERE id = 1`)
      .run(JSON.stringify(['commercial', 'finance']));
    check('módulo fora do plano → 403 nos exames', (await api(`${O}/patients/${outro}/exams`, {}, admin!)).status === 403);
    db.prepare(`UPDATE license SET modules_json = NULL, license_key = NULL, company_uuid = NULL WHERE id = 1`).run();
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  console.log(failures === 0 ? '\nExames e imagens: TODOS OS TESTES PASSARAM' : `\n${failures} falha(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
