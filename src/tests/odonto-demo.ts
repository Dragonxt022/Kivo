/**
 * Teste da clínica de exemplo do Odonto — os dados fictícios que a tela inicial (card "Ambiente de
 * teste") e o assistente de boas-vindas criam para o dentista conhecer o módulo.
 *
 * O que este teste protege, e por quê:
 *  - a demonstração COBRE o módulo (paciente, anamnese, agenda, odontograma, plano, documento,
 *    prontuário e exame com arquivo): sem isso o dentista abre telas vazias e conclui que o
 *    módulo não funciona — foi exatamente a lacuna que originou este gerador;
 *  - as imagens são PNG DE VERDADE (assinatura + IHDR + IDAT que infla no tamanho certo), não um
 *    arquivo qualquer com extensão `.png`: a galeria precisa mostrar a imagem;
 *  - rodar de novo NÃO duplica nada;
 *  - paciente que já existe como cliente REAL não é reaproveitado nem duplicado — o pior defeito
 *    possível seria anexar consulta e exame fictícios na ficha de um paciente de verdade;
 *  - o reset de fábrica (e o helper que ele usa) tira os arquivos de exame do disco.
 *
 * KIVO_DB_PATH TEM que vir do ambiente — rode com
 *   node scripts/test-isolated.js src/tests/odonto-demo.ts
 */
import { existsSync, readdirSync } from 'node:fs';
import zlib from 'node:zlib';
import { migrateUp } from '../core/database/migrator';
import { runSeeds } from '../core/database/seeds';
import { getSqlite } from '../core/database/connection';
import { createServer } from '../core/server';
import { resetTestDb, activateTestLicense } from './resetTestDb';
import { unwrap } from './testUtils';
import {
  DEMO_MARK, createOdontoDemoData, odontoDemoDisponivel, odontoDemoResumo,
} from '../modules/odonto/demoData';
import { EXAM_URL_PREFIX, clearExamFilesDir, examFilePath, examFilesDir } from '../modules/odonto/examFiles';
import { createCustomer } from '../modules/commercial/customers';
import { createDemoCatalog } from '../core/onboarding/demoCatalog';

const PORT = Number(process.env.KIVO_PORT ?? 3861);
const base = `http://localhost:${PORT}`;
const O = '/api/odonto';

/** Nome que já existe como cliente REAL antes da demonstração (é o último da lista do gerador). */
const CLIENTE_REAL = 'Marcos Vinícius Araújo';

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

/** Lê o PNG como o navegador leria: assinatura, tamanho do IHDR e IDAT que descomprime inteiro. */
function pngInfo(buf: Buffer): { w: number; h: number; pixelsOk: boolean } | null {
  if (buf.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') return null;
  let off = 8;
  let w = 0;
  let h = 0;
  let pixelsOk = false;
  const idat: Buffer[] = [];
  while (off + 12 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.subarray(off + 4, off + 8).toString('latin1');
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); }
    if (type === 'IDAT') idat.push(data);
    off += 12 + len;
    if (type === 'IEND') break;
  }
  if (w > 0 && h > 0 && idat.length) {
    try {
      pixelsOk = zlib.inflateSync(Buffer.concat(idat)).length === (w * 3 + 1) * h;
    } catch {
      pixelsOk = false;
    }
  }
  return { w, h, pixelsOk };
}

function contar(db: ReturnType<typeof getSqlite>, sql: string): number {
  return Number((db.prepare(sql).get() as { n: number }).n);
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

    check('módulo na instalação: demonstração disponível', odontoDemoDisponivel());
    check('consultório começa vazio', odontoDemoResumo().pacientes === 0);

    // ── O paciente real vem ANTES: é a única ordem que prova a proteção ───
    // Depois de criar a demonstração, o nome já existiria com a nossa marca e o caminho do
    // "cliente real existente" nunca seria exercitado.
    const clienteRealId = createCustomer({ name: CLIENTE_REAL, phone: '(11) 90000-0000' });
    check('cliente real cadastrado antes da demonstração', clienteRealId > 0);

    // A ORDEM do assistente de boas-vindas: primeiro o catálogo de produtos/serviços do ramo
    // (demoCatalog), depois a clínica. Rodar assim — e não com a clínica sozinha — é o que prova
    // que o procedimento odontológico reaproveita o preço do serviço já cadastrado, em vez de
    // criar um segundo preço para a mesma coisa.
    const catalogo = createDemoCatalog('odontologia', {
      complementos: false, kits: true, variantes: false, producao: false, kitchen: false,
    });
    check('o catálogo do ramo cria os serviços odontológicos',
      catalogo.productsCreated >= 6, `${catalogo.productsCreated} produto(s)`);

    const criados = createOdontoDemoData();
    check('a demonstração foi criada', criados.pacientes > 0, JSON.stringify(criados));

    // ── Proteção do paciente real ─────────────────────────────────────────
    check('paciente homônimo de cliente REAL não é reaproveitado nem duplicado',
      criados.pacientesIgnorados === 1, `${criados.pacientesIgnorados} ignorado(s)`);
    check('nenhuma ficha de paciente foi criada para o cliente real',
      contar(db, `SELECT COUNT(*) AS n FROM odonto_patients WHERE customer_id = ${clienteRealId}`) === 0);
    check('nenhum atendimento fictício foi anexado ao cliente real',
      contar(db, `SELECT COUNT(*) AS n FROM odonto_appointments WHERE patient_id IN (
        SELECT id FROM odonto_patients WHERE customer_id = ${clienteRealId})`) === 0);
    check('o nome do cliente real continua existindo uma única vez',
      contar(db, `SELECT COUNT(*) AS n FROM customers WHERE name = '${CLIENTE_REAL}' AND deleted_at IS NULL`) === 1);

    // ── Cobertura do módulo (os números são a fixture: 10 pacientes, 1 pulado) ──
    check('4 profissionais', criados.profissionais === 4, String(criados.profissionais));
    check('10 procedimentos no catálogo', criados.procedimentos === 10, String(criados.procedimentos));
    check('9 pacientes de exemplo', criados.pacientes === 9, String(criados.pacientes));
    check('9 anamneses preenchidas', criados.anamneses === 9, String(criados.anamneses));
    check('17 atendimentos na agenda', criados.agendamentos === 17, String(criados.agendamentos));
    check('11 registros no odontograma', criados.estadosOdontograma === 11, String(criados.estadosOdontograma));
    check('4 planos de tratamento', criados.planos === 4, String(criados.planos));
    check('9 itens de plano', criados.itensPlano === 9, String(criados.itensPlano));
    check('7 documentos', criados.documentos === 7, String(criados.documentos));
    check('6 exames com arquivo', criados.exames === 6, String(criados.exames));
    check('todos os pacientes de exemplo estão MARCADOS como fictícios',
      contar(db, `SELECT COUNT(*) AS n FROM odonto_patients WHERE notes = '${DEMO_MARK}' AND deleted_at IS NULL`) === 9);

    // ── A agenda cobre os estados que a tela precisa mostrar ──────────────
    const porStatus = db.prepare(
      'SELECT status, COUNT(*) AS n FROM odonto_appointments WHERE deleted_at IS NULL GROUP BY status',
    ).all() as { status: string; n: number }[];
    const status = new Map(porStatus.map((s) => [s.status, Number(s.n)]));
    check('agenda com atendidos, confirmados, agendados e falta',
      (status.get('atendido') ?? 0) === 6 && (status.get('confirmado') ?? 0) === 4
      && (status.get('agendado') ?? 0) === 5 && (status.get('faltou') ?? 0) === 1
      && (status.get('em_atendimento') ?? 0) === 1,
      JSON.stringify(Object.fromEntries(status)));
    check('o atendimento cancelado do paciente pulado não foi criado', !status.has('cancelado'));
    check('cada atendimento tem histórico de evento (criado + transição)',
      contar(db, 'SELECT COUNT(*) AS n FROM odonto_appointment_events') === 29,
      String(contar(db, 'SELECT COUNT(*) AS n FROM odonto_appointment_events')));
    const agendaVazia = db.prepare(
      `SELECT COUNT(*) AS n FROM odonto_appointments
        WHERE status = 'atendido' AND (started_at IS NULL OR finished_at IS NULL)`,
    ).get() as { n: number };
    check('atendimento concluído tem início e fim gravados', Number(agendaVazia.n) === 0);

    // ── Prontuário: a retificação é a regra central (PR §8) ───────────────
    const corrigido = db.prepare(
      `SELECT id, status, version, replaced_by_id, retifica_id, retification_reason
         FROM odonto_clinical_notes WHERE title LIKE '%corrigido%' AND deleted_at IS NULL`,
    ).get() as { id: number; status: string; version: number; replaced_by_id: number | null; retifica_id: number | null; retification_reason: string | null } | undefined;
    check('existe a versão corrigida da evolução', !!corrigido, JSON.stringify(corrigido));
    const original = corrigido
      ? db.prepare('SELECT id, status, replaced_by_id FROM odonto_clinical_notes WHERE id = ?')
        .get(corrigido.retifica_id) as { id: number; status: string; replaced_by_id: number | null }
      : undefined;
    check('a versão nova aponta para a anterior (retifica_id)',
      !!corrigido && corrigido.retifica_id === original?.id);
    check('a versão anterior fica marcada como retificada, não apagada',
      original?.status === 'retificado' && original?.replaced_by_id === corrigido?.id,
      JSON.stringify(original));
    check('a retificação tem motivo registrado', !!corrigido?.retification_reason);
    check('o histórico tem as duas versões (nada foi apagado)',
      contar(db, "SELECT COUNT(*) AS n FROM odonto_clinical_notes WHERE title LIKE '%levantamento inicial%' AND deleted_at IS NULL") === 2);

    // ── Planos: os quatro estados, com as datas coerentes ─────────────────
    const planosPorStatus = db.prepare(
      'SELECT status, COUNT(*) AS n FROM odonto_treatment_plans WHERE deleted_at IS NULL GROUP BY status',
    ).all() as { status: string; n: number }[];
    check('planos cobrem planejado, aprovado, em andamento e concluído',
      planosPorStatus.length === 4, JSON.stringify(planosPorStatus));
    check('plano aprovado tem data de aprovação',
      contar(db, "SELECT COUNT(*) AS n FROM odonto_treatment_plans WHERE status IN ('aprovado','em_andamento','concluido') AND approved_at IS NOT NULL") === 3);
    check('plano concluído tem data de término',
      contar(db, "SELECT COUNT(*) AS n FROM odonto_treatment_plans WHERE status = 'concluido' AND finished_at IS NOT NULL") === 1);
    const itensSemProcedimento = db.prepare(
      `SELECT COUNT(*) AS n FROM odonto_treatment_items i
        LEFT JOIN odonto_procedures p ON p.id = i.procedure_id
        WHERE i.deleted_at IS NULL AND (i.procedure_id IS NULL OR p.id IS NULL)`,
    ).get() as { n: number };
    check('todo item de plano aponta para um procedimento do catálogo', Number(itensSemProcedimento.n) === 0);

    // ── Procedimentos ligados ao catálogo comercial (sem preço duplicado) ─
    check('os procedimentos que também são produto aproveitam o preço do catálogo',
      contar(db, `SELECT COUNT(*) AS n FROM odonto_procedures WHERE product_id IS NOT NULL AND deleted_at IS NULL`) === 6,
      String(contar(db, 'SELECT COUNT(*) AS n FROM odonto_procedures WHERE product_id IS NOT NULL')));

    // ── Documentos: emitido tem data, rascunho não ────────────────────────
    check('6 documentos emitidos com data de emissão',
      contar(db, "SELECT COUNT(*) AS n FROM odonto_documents WHERE status = 'emitido' AND issued_at IS NOT NULL AND deleted_at IS NULL") === 6);
    check('1 documento em rascunho (sem data de emissão)',
      contar(db, "SELECT COUNT(*) AS n FROM odonto_documents WHERE status = 'rascunho' AND issued_at IS NULL AND deleted_at IS NULL") === 1);
    check('documento de plano aponta para o plano do MESMO paciente',
      contar(db, `SELECT COUNT(*) AS n FROM odonto_documents d JOIN odonto_treatment_plans p ON p.id = d.plan_id
                   WHERE d.plan_id IS NOT NULL AND p.patient_id != d.patient_id`) === 0);
    check('documentos nascem de modelos de verdade (template_id preenchido)',
      contar(db, 'SELECT COUNT(*) AS n FROM odonto_documents WHERE template_id IS NOT NULL AND deleted_at IS NULL') === 7);

    // ── Odontograma: situação e planejado ─────────────────────────────────
    check('odontograma tem registros de situação e de planejado',
      contar(db, "SELECT COUNT(*) AS n FROM odonto_tooth_states WHERE kind = 'planejado' AND deleted_at IS NULL") === 2
      && contar(db, "SELECT COUNT(*) AS n FROM odonto_tooth_states WHERE kind = 'situacao' AND deleted_at IS NULL") === 9);
    check('os dentes usados são FDI válidos (nenhum registro órfão de situação)',
      contar(db, `SELECT COUNT(*) AS n FROM odonto_tooth_states s
                   LEFT JOIN odonto_tooth_conditions c ON c.id = s.condition_id
                   WHERE s.deleted_at IS NULL AND c.id IS NULL`) === 0);

    // ── Exames: arquivo de verdade no disco ───────────────────────────────
    const exames = db.prepare(
      'SELECT id, title, type, file_name, original_name, mime, size_bytes FROM odonto_exams WHERE deleted_at IS NULL ORDER BY id',
    ).all() as { id: number; title: string; type: string; file_name: string; original_name: string; mime: string; size_bytes: number }[];
    check('6 exames gravados', exames.length === 6, String(exames.length));
    check('todo exame tem arquivo no disco e tamanho > 0',
      exames.every((e) => existsSync(examFilePath(e.file_name) as string) && e.size_bytes > 0));
    check('o nome no disco é UUID (não o nome do consultório)',
      exames.every((e) => /^[0-9a-f-]{36}\.\w+$/.test(e.file_name)));

    const panoramica = exames.find((e) => e.type === 'radiografia');
    const tomografia = exames.find((e) => e.type === 'tomografia');
    const fotos = exames.filter((e) => e.type === 'fotografia');
    const laudo = exames.find((e) => e.type === 'documento');
    check('há radiografia, tomografia, fotografia e documento',
      !!panoramica && !!tomografia && fotos.length === 2 && !!laudo);

    for (const exame of exames.filter((e) => e.type !== 'documento')) {
      // A URL vem da CONSTANTE do módulo (e não escrita à mão): o prefixo real é
      // `/uploads/odonto-exams/`, e uma versão anterior deste teste pediu
      // `/uploads/odonto-exames/` — o teste acusava PNG quebrado onde havia URL errada.
      const buf = Buffer.from(await (await fetch(`${base}${EXAM_URL_PREFIX}${exame.file_name}`)).arrayBuffer());
      const info = pngInfo(buf);
      check(`"${exame.title.slice(0, 32)}…" é um PNG íntegro e servido pela URL do módulo`,
        !!info && info.w > 100 && info.h > 100 && info.pixelsOk,
        info ? `${info.w}x${info.h}${info.pixelsOk ? '' : ' pixels quebrados'}` : 'não é PNG');
    }
    const pdfBuf = Buffer.from(await (await fetch(`${base}${EXAM_URL_PREFIX}${laudo!.file_name}`)).arrayBuffer());
    check('o laudo é um PDF de verdade (cabeçalho e fim de arquivo)',
      pdfBuf.subarray(0, 5).toString('latin1') === '%PDF-' && pdfBuf.toString('latin1').trimEnd().endsWith('%%EOF'));
    const fotosAntes = db.prepare(
      "SELECT COUNT(*) AS n FROM odonto_exams WHERE type = 'fotografia' AND phase = 'antes' AND deleted_at IS NULL",
    ).get() as { n: number };
    check('a comparação antes/depois existe (PR §17)', Number(fotosAntes.n) === 1);

    // ── Idempotência ──────────────────────────────────────────────────────
    const antes = {
      pacientes: contar(db, 'SELECT COUNT(*) AS n FROM odonto_patients'),
      agendamentos: contar(db, 'SELECT COUNT(*) AS n FROM odonto_appointments'),
      exames: contar(db, 'SELECT COUNT(*) AS n FROM odonto_exams'),
      arquivos: readdirSync(examFilesDir()).length,
    };
    const segunda = createOdontoDemoData();
    check('rodar de novo não cria nada',
      segunda.pacientes === 0 && segunda.profissionais === 0 && segunda.procedimentos === 0
      && segunda.agendamentos === 0 && segunda.evolucoes === 0 && segunda.estadosOdontograma === 0
      && segunda.planos === 0 && segunda.documentos === 0 && segunda.exames === 0
      && segunda.anamneses === 0,
      JSON.stringify(segunda));
    check('rodar de novo não duplica linhas nem arquivos',
      contar(db, 'SELECT COUNT(*) AS n FROM odonto_patients') === antes.pacientes
      && contar(db, 'SELECT COUNT(*) AS n FROM odonto_appointments') === antes.agendamentos
      && contar(db, 'SELECT COUNT(*) AS n FROM odonto_exams') === antes.exames
      && readdirSync(examFilesDir()).length === antes.arquivos,
      `${antes.pacientes} pacientes, ${antes.arquivos} arquivos`);
    check('o cliente real continua intocado depois de rodar duas vezes',
      contar(db, `SELECT COUNT(*) AS n FROM customers WHERE name = '${CLIENTE_REAL}' AND deleted_at IS NULL`) === 1
      && contar(db, `SELECT COUNT(*) AS n FROM odonto_patients WHERE customer_id = ${clienteRealId}`) === 0);

    // ── A rota da tela inicial ────────────────────────────────────────────
    // O envelope padrão do Core embala a resposta em `{ success, data }` — daí o `unwrap`.
    const statusRota = await api(`${O}/demo-data`, {}, admin!);
    const statusCorpo = await unwrap<{ disponivel: boolean; resumo: { pacientes: number; exames: number } }>(statusRota);
    check('GET /demo-data responde disponível com o resumo',
      statusRota.status === 200 && statusCorpo.disponivel && statusCorpo.resumo.pacientes === 9
      && statusCorpo.resumo.exames === 6, JSON.stringify(statusCorpo));

    // O card da tela inicial lê `json.data.*` (o Core embrulha tudo em `{ success, data }`). Esta
    // checagem é o contrato dessa leitura: o dia em que o envelope mudar de forma — ou alguém
    // "simplificar" a extração no EJS para `json.disponivel` — o card para de aparecer sem erro
    // nenhum no console, e é aqui que isso vira falha de teste em vez de tela vazia.
    const cru = await (await api(`${O}/demo-data`, {}, admin!)).json() as
      { success: boolean; data?: { disponivel: boolean }; disponivel?: boolean };
    check('o envelope é o que a tela inicial lê (data.disponivel, não disponivel)',
      cru.success === true && cru.data?.disponivel === true && cru.disponivel === undefined,
      JSON.stringify(cru).slice(0, 80));

    const criadoPelaRota = await api(`${O}/demo-data`, { method: 'POST' }, admin!);
    const corpoRota = await unwrap<{ criados: { pacientes: number }; resumo: { pacientes: number } }>(criadoPelaRota);
    check('POST /demo-data pela tela inicial responde 200', criadoPelaRota.status === 200, String(criadoPelaRota.status));
    check('POST idempotente pela rota não duplica', corpoRota.criados.pacientes === 0, JSON.stringify(corpoRota.criados));
    check('a criação da demonstração fica na auditoria',
      contar(db, "SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'odonto_demo_dados'") === 1);

    // A tela inicial é onde o card mora: renderizá-la de verdade é o que prova que o EJS novo
    // compila e que o convite aparece para quem tem permissão.
    const home = await api('/', {}, admin!);
    const homeHtml = await home.text();
    check('a tela inicial renderiza com o card do ambiente de teste',
      home.status === 200 && homeHtml.includes('Ambiente de teste do Odonto')
      && homeHtml.includes('odontoDemoData()'), `status ${home.status}`);

    // ── Permissão e plano ─────────────────────────────────────────────────
    const roleComum = await unwrap<{ id: number; slug: string }>(
      await api('/api/roles', { method: 'POST', body: JSON.stringify({ name: 'Recepção demo' }) }, admin!));
    await api(`/api/roles/${roleComum.id}/permissions`, {
      method: 'PUT', body: JSON.stringify({ permissions: ['odonto.patients.view'] }),
    }, admin!);
    await api('/api/users', {
      method: 'POST', body: JSON.stringify({ username: 'demo_recepcao', name: 'Recepção', password: 'Teste1234', roleSlug: roleComum.slug }),
    }, admin!);
    const recepcao = await loginAs('demo_recepcao', 'Teste1234');
    check('sem settings.edit o card não tem o que chamar (403)',
      (await api(`${O}/demo-data`, {}, recepcao!)).status === 403
      && (await api(`${O}/demo-data`, { method: 'POST' }, recepcao!)).status === 403);

    db.prepare(`UPDATE license SET modules_json = ?, license_key = 'teste', company_uuid = 'teste' WHERE id = 1`)
      .run(JSON.stringify(['commercial', 'finance']));
    check('módulo fora do plano → 403 na demonstração',
      (await api(`${O}/demo-data`, {}, admin!)).status === 403);
    db.prepare(`UPDATE license SET modules_json = NULL, license_key = NULL, company_uuid = NULL WHERE id = 1`).run();

    // ── Limpeza dos arquivos (o que o reset de fábrica chama) ─────────────
    const arquivosAntes = readdirSync(examFilesDir()).length;
    const removidos = clearExamFilesDir();
    check('o reset tira os arquivos de exame do disco',
      removidos === arquivosAntes && readdirSync(examFilesDir()).length === 0,
      `${removidos} de ${arquivosAntes}`);
    check('a limpeza de arquivos não mexe nas linhas do banco',
      contar(db, 'SELECT COUNT(*) AS n FROM odonto_exams') === 6);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  console.log(failures === 0 ? '\nClínica de exemplo do Odonto: TODOS OS TESTES PASSARAM' : `\n${failures} falha(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
