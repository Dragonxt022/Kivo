/**
 * Teste de integração dos documentos (PR §14) e dos modelos com variáveis (PR §15).
 *
 * O que a PR exige e este teste prova:
 *  §15 — documento nasce de MODELO com variáveis: {{paciente.nome}}, {{profissional.cro}},
 *        {{data}}, {{plano.total}}... trocadas pelos dados reais. A clínica cria modelos novos
 *        pela API, sem código.
 *  §14 — documento gerado, visualizado, impresso (a tela de impressão é o "PDF" do sistema),
 *        vinculado ao paciente E à consulta.
 *
 * Regras que o teste protege:
 *  - o corpo é gravado JÁ RENDERIZADO (snapshot): mudar o modelo depois não altera o documento;
 *  - variável sem valor não desaparece: vira linha para preencher e é reportada;
 *  - emitido não é editado nem apagado: corrige-se com a VERSÃO SEGUINTE, ligada à anterior;
 *  - receita/atestado não emitem sem profissional com CRO;
 *  - auditoria registra o ato SEM copiar o texto do documento.
 *
 * KIVO_DB_PATH TEM que vir do ambiente — rode com
 *   node scripts/test-isolated.js src/tests/odonto-documentos.ts
 */
import { migrateUp } from '../core/database/migrator';
import { runSeeds } from '../core/database/seeds';
import { getSqlite } from '../core/database/connection';
import { createServer } from '../core/server';
import { resetTestDb, activateTestLicense } from './resetTestDb';
import { unwrap } from './testUtils';
import { extractVariables, idadeDe, render } from '../modules/odonto/documents';

const PORT = Number(process.env.KIVO_PORT ?? 3850);
const base = `http://localhost:${PORT}`;
const O = '/api/odonto';
const TEXTO = 'Declaro que recebi as orientações de cuidado pós-operatório (teste).';

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

interface Template {
  id: number; code: string | null; name: string; type: string; type_label: string;
  body: string; variables: string[]; requires_professional: boolean; active: boolean; is_system: boolean;
}
interface Doc {
  id: number; patient_id: number; patient_name: string; appointment_id: number | null;
  plan_id: number | null; template_id: number | null; template_name: string | null;
  type: string; type_label: string; title: string; body: string;
  status: string; version: number; replaces_id: number | null; replaced_by_id: number | null;
  missing_variables: string[]; professional_name: string | null; professional_cro: string | null;
  issued_at: string | null; cancelled_at: string | null; cancel_reason: string | null;
  revision_chain?: { id: number; version: number; status: string }[];
}
interface DocList {
  items: Doc[];
  resumo: { total: number; emitidos: number; rascunhos: number; ultimo_em: string | null };
  types: { type: string; label: string }[];
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
    check('sem login → 401', (await api(`${O}/patients/1/documents`)).status === 401);

    // ── Unidade: motor de variáveis (PR §15) ──────────────────────────────
    check('extrai as variáveis do corpo',
      extractVariables('Oi {{paciente.nome}}, CRO {{profissional.cro}} e {{data}}').join(',') === 'paciente.nome,profissional.cro,data');
    check('variável desconhecida fica no texto e é reportada', (() => {
      const r = render('Nome: {{paciente.nome}} / {{nao.existe}}', { 'paciente.nome': 'Ana' });
      return r.text.includes('{{nao.existe}}') && r.missing.includes('nao.existe');
    })());
    check('variável sem valor vira linha para preencher', (() => {
      const r = render('RG: {{paciente.rg}}', { 'paciente.rg': '' });
      return r.text.includes('____') && r.missing.includes('paciente.rg');
    })());
    check('idade calculada a partir do nascimento', idadeDe('2000-01-01', new Date('2026-06-15')) === '26 anos',
      idadeDe('2000-01-01', new Date('2026-06-15')));
    check('idade de quem ainda não fez aniversário', idadeDe('2000-12-31', new Date('2026-06-15')) === '25 anos',
      idadeDe('2000-12-31', new Date('2026-06-15')));

    // ── Base ──────────────────────────────────────────────────────────────
    const paciente = (await unwrap<{ id: number }>(await api(`${O}/patients`, {
      method: 'POST',
      body: JSON.stringify({
        name: 'Joana Documentos (teste)', phone: '(69) 97777-0000', document: '111.444.777-35',
        birthday: '1988-06-14', email: 'joana@teste.com', address: 'Rua das Flores, 120',
      }),
    }, admin!))).id;
    const outro = (await unwrap<{ id: number }>(await api(`${O}/patients`, {
      method: 'POST', body: JSON.stringify({ name: 'Outro Paciente (teste)' }),
    }, admin!))).id;
    const dentista = (await unwrap<{ id: number }>(await api(`${O}/professionals`, {
      method: 'POST', body: JSON.stringify({ name: 'Dr. Marcos (teste)', cro: '55667', cro_state: 'MT', specialties: 'Endodontia' }),
    }, admin!))).id;
    const restauracao = (await unwrap<{ id: number }>(await api(`${O}/procedures`, {
      method: 'POST', body: JSON.stringify({ name: 'Restauração (teste docs)', duration_min: 60, default_price_cents: 25000 }),
    }, admin!))).id;
    const atendimento = (await unwrap<{ id: number }>(await api(`${O}/appointments`, {
      method: 'POST',
      body: JSON.stringify({ patient_id: paciente, professional_id: dentista, procedure_id: restauracao, starts_at: '2026-11-10 09:00', duration_min: 60 }),
    }, admin!))).id;
    const planoCriado = await unwrap<{ id: number; total_cents: number }>(await api(`${O}/patients/${paciente}/treatment-plans`, {
      method: 'POST',
      body: JSON.stringify({ professional_id: dentista, items: [{ procedure_id: restauracao, tooth: '26', description: 'Restauração', amount_cents: 25000, quantity: 2 }] }),
    }, admin!));
    check('base criada', paciente > 0 && dentista > 0 && atendimento > 0 && planoCriado.total_cents === 50000);

    // ── Modelos semeados (PR §14) ─────────────────────────────────────────
    const modelos = await unwrap<Template[]>(await api(`${O}/document-templates`, {}, admin!));
    const codigos = modelos.map((m) => m.code);
    check('os modelos iniciais da PR §14 foram semeados',
      ['tcle_padrao', 'contrato_padrao', 'receita_padrao', 'atestado_padrao', 'declaracao_comparecimento',
        'encaminhamento_padrao', 'termo_recusa_padrao', 'termo_responsabilidade_padrao', 'alta_padrao',
        'resumo_anamnese', 'orcamento_plano'].every((c) => codigos.includes(c)),
      `${modelos.length} modelo(s)`);
    check('modelo lista as variáveis que usa', (modelos.find((m) => m.code === 'tcle_padrao')?.variables ?? []).includes('paciente.nome'));
    check('receita exige profissional com CRO', modelos.find((m) => m.code === 'receita_padrao')?.requires_professional === true);
    check('termo de responsabilidade não exige', modelos.find((m) => m.code === 'termo_responsabilidade_padrao')?.requires_professional === false);
    check('todos vêm do sistema', modelos.every((m) => m.is_system));

    const tcle = modelos.find((m) => m.code === 'tcle_padrao')!;
    const orcamento = modelos.find((m) => m.code === 'orcamento_plano')!;
    const receita = modelos.find((m) => m.code === 'receita_padrao')!;

    // ── Modelo novo pela API (a clínica não programa) ──────────────────────
    const novoModelo = await api(`${O}/document-templates`, {
      method: 'POST',
      body: JSON.stringify({
        code: 'termo_clareamento', name: 'Termo de clareamento (teste)', type: 'termo_responsabilidade',
        body: 'Eu, {{paciente.nome}}, autorizo o clareamento em {{data}}.\n\nObservação: ' + TEXTO,
      }),
    }, admin!);
    check('clínica cria modelo novo (201)', novoModelo.status === 201, String(novoModelo.status));
    const modeloNovo = await unwrap<Template>(novoModelo);
    check('modelo novo guarda as variáveis', modeloNovo.variables.join(',') === 'paciente.nome,data', modeloNovo.variables.join(','));
    check('modelo novo não é do sistema', modeloNovo.is_system === false);
    check('código repetido → 409', (await api(`${O}/document-templates`, {
      method: 'POST', body: JSON.stringify({ code: 'termo_clareamento', name: 'Outro', body: 'x' }),
    }, admin!)).status === 409);
    check('tipo inválido → 400', (await api(`${O}/document-templates`, {
      method: 'POST', body: JSON.stringify({ name: 'X', type: 'inventado', body: 'x' }),
    }, admin!)).status === 400);
    check('modelo sem conteúdo → 400', (await api(`${O}/document-templates`, {
      method: 'POST', body: JSON.stringify({ name: 'Vazio', type: 'outro', body: '   ' }),
    }, admin!)).status === 400);
    check('modelo sem nome → 400', (await api(`${O}/document-templates`, {
      method: 'POST', body: JSON.stringify({ type: 'outro', body: 'texto' }),
    }, admin!)).status === 400);

    // ── Geração do documento a partir do modelo ───────────────────────────
    const gerado = await api(`${O}/patients/${paciente}/documents`, {
      method: 'POST',
      body: JSON.stringify({ template_id: tcle.id, professional_id: dentista, appointment_id: atendimento }),
    }, admin!);
    check('documento gerado (201)', gerado.status === 201, String(gerado.status));
    const doc = await unwrap<Doc>(gerado);
    check('documento nasce como rascunho', doc.status === 'rascunho' && doc.version === 1, JSON.stringify({ s: doc.status, v: doc.version }));
    check('variáveis do paciente foram trocadas', doc.body.includes('Joana Documentos (teste)'), doc.body.slice(0, 60));
    check('CPF e nascimento do paciente entraram', doc.body.includes('111.444.777-35') && doc.body.includes('14/06/1988'));
    check('idade calculada no documento', /\(\d+ anos\)/.test(doc.body));
    check('profissional e CRO entraram', doc.body.includes('Dr. Marcos (teste)') && doc.body.includes('55667/MT'));
    check('procedimento da consulta vinculada entrou', doc.body.includes('Restauração (teste docs)'),
      doc.body.split('\n').find((l) => l.startsWith('Procedimento(s)')) ?? '');
    check('data de hoje entrou', /\d{2}\/\d{2}\/\d{4}/.test(doc.body));
    check('nenhuma variável ficou sobrando no texto', !/\{\{/.test(doc.body), (doc.body.match(/\{\{[^}]+\}\}/g) ?? []).join(','));
    check('documento vinculado à consulta', doc.appointment_id === atendimento);
    check('documento guarda o modelo de origem', doc.template_id === tcle.id && doc.template_name === tcle.name);

    // Variável sem valor: reportada e visível.
    const semRg = await unwrap<Doc>(await api(`${O}/patients/${paciente}/documents`, {
      method: 'POST',
      body: JSON.stringify({ template_id: tcle.id, professional_id: dentista, body: 'RG: {{paciente.rg}}\nNome: {{paciente.nome}}' }),
    }, admin!));
    check('variável vazia é reportada', semRg.missing_variables.includes('paciente.rg'), JSON.stringify(semRg.missing_variables));
    check('variável vazia vira linha para preencher', semRg.body.includes('____'));
    const comDesconhecida = await unwrap<Doc>(await api(`${O}/patients/${paciente}/documents`, {
      method: 'POST', body: JSON.stringify({ type: 'outro', body: 'X: {{paciente.apelido}}' }),
    }, admin!));
    check('variável inexistente é reportada e mantida', comDesconhecida.missing_variables.includes('paciente.apelido')
      && comDesconhecida.body.includes('{{paciente.apelido}}'));

    // Plano vinculado enche itens e total.
    const comPlano = await unwrap<Doc>(await api(`${O}/patients/${paciente}/documents`, {
      method: 'POST', body: JSON.stringify({ template_id: orcamento.id, plan_id: planoCriado.id }),
    }, admin!));
    check('orçamento traz os itens do plano', comPlano.body.includes('26 — Restauração (R$ 500,00)'),
      comPlano.body.split('\n').filter((l) => l.includes('R$'))[0] ?? '');
    check('orçamento traz o total do plano', comPlano.body.includes('500,00'), comPlano.body.split('\n').find((l) => l.startsWith('VALOR TOTAL')) ?? '');
    check('plano vinculado gravado', comPlano.plan_id === planoCriado.id);

    // ── Validações ────────────────────────────────────────────────────────
    check('consulta de outro paciente → 400', (await api(`${O}/patients/${paciente}/documents`, {
      method: 'POST', body: JSON.stringify({ type: 'outro', body: 'x', appointment_id: 99999 }),
    }, admin!)).status === 400);
    check('plano de outro paciente → 400', (await api(`${O}/patients/${outro}/documents`, {
      method: 'POST', body: JSON.stringify({ type: 'outro', body: 'x', plan_id: planoCriado.id }),
    }, admin!)).status === 400);
    check('documento sem conteúdo → 400', (await api(`${O}/patients/${paciente}/documents`, {
      method: 'POST', body: JSON.stringify({ type: 'outro' }),
    }, admin!)).status === 400);
    check('paciente inexistente → 404', (await api(`${O}/patients/9999/documents`, {
      method: 'POST', body: JSON.stringify({ type: 'outro', body: 'x' }),
    }, admin!)).status === 404);
    check('modelo inexistente → 404', (await api(`${O}/patients/${paciente}/documents`, {
      method: 'POST', body: JSON.stringify({ template_id: 9999 }),
    }, admin!)).status === 404);

    // ── Lista e resumo ────────────────────────────────────────────────────
    const lista = await unwrap<DocList>(await api(`${O}/patients/${paciente}/documents`, {}, admin!));
    check('lista traz os documentos do paciente', lista.items.length === 4, `${lista.items.length}`);
    check('o resumo conta emitidos e rascunhos',
      lista.resumo.total === 4 && lista.resumo.rascunhos === 4 && lista.resumo.emitidos === 0,
      JSON.stringify(lista.resumo));
    check('a lista NÃO traz o corpo do documento (é texto clínico)',
      lista.items.every((d) => d.body === ''), JSON.stringify(lista.items.map((d) => d.body.length)));
    check('a lista informa os tipos disponíveis', lista.types.length === 12, String(lista.types.length));
    const soContrato = await unwrap<DocList>(await api(`${O}/patients/${paciente}/documents?type=contrato`, {}, admin!));
    check('filtro por tipo funciona', soContrato.items.every((d) => d.type === 'contrato'), `${soContrato.items.length}`);

    // ── Edição: só rascunho ───────────────────────────────────────────────
    const editado = await api(`${O}/documents/${doc.id}`, {
      method: 'PUT', body: JSON.stringify({ body: 'Texto novo com {{paciente.nome}} e {{profissional.cro}}.' }),
    }, admin!);
    check('rascunho é editável (200)', editado.status === 200, String(editado.status));
    const docEditado = await unwrap<Doc>(editado);
    check('editar re-renderiza as variáveis',
      docEditado.body === 'Texto novo com Joana Documentos (teste) e 55667/MT.', docEditado.body);

    // ── Emissão ───────────────────────────────────────────────────────────
    const receitaSemProfissional = await unwrap<Doc>(await api(`${O}/patients/${paciente}/documents`, {
      method: 'POST', body: JSON.stringify({ template_id: receita.id }),
    }, admin!));
    check('receita sem profissional não emite (400)', (await api(`${O}/documents/${receitaSemProfissional.id}/issue`, {
      method: 'POST', body: JSON.stringify({}),
    }, admin!)).status === 400);

    const emitido = await api(`${O}/documents/${doc.id}/issue`, {
      method: 'POST', body: JSON.stringify({ professional_id: dentista }),
    }, admin!);
    check('documento emitido (200)', emitido.status === 200, String(emitido.status));
    const docEmitido = await unwrap<Doc>(emitido);
    check('emissão carimba a data', !!docEmitido.issued_at);
    check('emissão guarda quem assinou', docEmitido.professional_name === 'Dr. Marcos (teste)' && docEmitido.professional_cro === '55667/MT');
    check('emitir duas vezes → 400', (await api(`${O}/documents/${doc.id}/issue`, {
      method: 'POST', body: JSON.stringify({}),
    }, admin!)).status === 400);

    const editarEmitido = await api(`${O}/documents/${doc.id}`, {
      method: 'PUT', body: JSON.stringify({ body: 'mudando o que já foi entregue' }),
    }, admin!);
    const corpoEditar = (await editarEmitido.json()) as { error?: string };
    check('emitido não é editado (400)', editarEmitido.status === 400, String(editarEmitido.status));
    check('a resposta diz para gerar a versão seguinte', /versão seguinte/i.test(String(corpoEditar.error)), String(corpoEditar.error));
    check('emitido não é apagado (400)', (await api(`${O}/documents/${doc.id}`, { method: 'DELETE' }, admin!)).status === 400);

    // ── Versão seguinte ───────────────────────────────────────────────────
    const nova = await api(`${O}/documents/${doc.id}/new-version`, { method: 'POST' }, admin!);
    check('nova versão criada (201)', nova.status === 201, String(nova.status));
    const docV2 = await unwrap<Doc>(nova);
    check('nova versão é rascunho e versão 2', docV2.version === 2 && docV2.status === 'rascunho', JSON.stringify({ v: docV2.version, s: docV2.status }));
    check('nova versão aponta para a anterior', docV2.replaces_id === doc.id, String(docV2.replaces_id));
    const original = await unwrap<Doc>(await api(`${O}/documents/${doc.id}`, {}, admin!));
    check('documento anterior aponta para a versão nova', original.replaced_by_id === docV2.id, String(original.replaced_by_id));
    const docV2Detalhe = await unwrap<Doc>(await api(`${O}/documents/${docV2.id}`, {}, admin!));
    check('a cadeia de versões aparece no detalhe',
      (docV2Detalhe.revision_chain ?? []).length === 2 && (docV2Detalhe.revision_chain ?? []).map((v) => v.version).join(',') === '1,2',
      JSON.stringify(docV2Detalhe.revision_chain));
    check('não cria duas versões em rascunho ao mesmo tempo', (await api(`${O}/documents/${doc.id}/new-version`, {
      method: 'POST',
    }, admin!)).status === 400);

    // ── Cancelamento ──────────────────────────────────────────────────────
    check('cancelar sem motivo → 400', (await api(`${O}/documents/${docV2.id}/cancel`, {
      method: 'POST', body: JSON.stringify({}),
    }, admin!)).status === 400);
    const cancelado = await api(`${O}/documents/${docV2.id}/cancel`, {
      method: 'POST', body: JSON.stringify({ motivo: 'paciente desistiu do procedimento' }),
    }, admin!);
    check('cancelamento aceito (200)', cancelado.status === 200, String(cancelado.status));
    const docCancelado = await unwrap<Doc>(cancelado);
    check('cancelamento guarda data e motivo',
      !!docCancelado.cancelled_at && docCancelado.cancel_reason === 'paciente desistiu do procedimento',
      String(docCancelado.cancel_reason));
    check('cancelado não gera nova versão', (await api(`${O}/documents/${docV2.id}/new-version`, { method: 'POST' }, admin!)).status === 400);

    // ── Modelo em uso não é apagado ───────────────────────────────────────
    const apagarTcle = await api(`${O}/document-templates/${tcle.id}`, { method: 'DELETE' }, admin!);
    check('modelo em uso é desativado (não apagado)', (await unwrap<{ desativado: boolean }>(apagarTcle)).desativado === true);
    check('modelo em uso continua no catálogo, inativo',
      (await unwrap<Template[]>(await api(`${O}/document-templates?active=false`, {}, admin!))).some((m) => m.id === tcle.id && !m.active));
    const apagarNovo = await api(`${O}/document-templates/${modeloNovo.id}`, { method: 'DELETE' }, admin!);
    check('modelo sem uso é apagado', (await unwrap<{ desativado: boolean }>(apagarNovo)).desativado === false);

    // ── Permissões ────────────────────────────────────────────────────────
    const roleLeitura = await unwrap<{ id: number; slug: string }>(
      await api('/api/roles', { method: 'POST', body: JSON.stringify({ name: 'Documentos leitura' }) }, admin!),
    );
    await api(`/api/roles/${roleLeitura.id}/permissions`, {
      method: 'PUT', body: JSON.stringify({ permissions: ['odonto.patients.view', 'odonto.documents.view'] }),
    }, admin!);
    await api('/api/users', {
      method: 'POST', body: JSON.stringify({ username: 'doc_leitura', name: 'Leitura', password: 'Teste1234', roleSlug: roleLeitura.slug }),
    }, admin!);
    const leitura = await loginAs('doc_leitura', 'Teste1234');
    check('login do usuário de leitura', leitura !== null);
    check('com documents.view a lista é acessível', (await api(`${O}/patients/${paciente}/documents`, {}, leitura!)).status === 200);
    check('sem documents.manage não gera documento (403)', (await api(`${O}/patients/${paciente}/documents`, {
      method: 'POST', body: JSON.stringify({ type: 'outro', body: 'x' }),
    }, leitura!)).status === 403);
    check('sem documents.manage não emite (403)', (await api(`${O}/documents/${docV2.id}/issue`, {
      method: 'POST', body: JSON.stringify({}),
    }, leitura!)).status === 403);
    check('sem documents.templates não cria modelo (403)', (await api(`${O}/document-templates`, {
      method: 'POST', body: JSON.stringify({ name: 'X', type: 'outro', body: 'x' }),
    }, leitura!)).status === 403);

    const roleSemDocs = await unwrap<{ id: number; slug: string }>(
      await api('/api/roles', { method: 'POST', body: JSON.stringify({ name: 'Sem documentos' }) }, admin!),
    );
    await api(`/api/roles/${roleSemDocs.id}/permissions`, {
      method: 'PUT', body: JSON.stringify({ permissions: ['odonto.patients.view'] }),
    }, admin!);
    await api('/api/users', {
      method: 'POST', body: JSON.stringify({ username: 'sem_docs', name: 'Sem docs', password: 'Teste1234', roleSlug: roleSemDocs.slug }),
    }, admin!);
    const semDocs = await loginAs('sem_docs', 'Teste1234');
    check('sem permissão não vê documentos (403)',
      (await api(`${O}/patients/${paciente}/documents`, {}, semDocs!)).status === 403);
    check('sem permissão não vê o documento (403)', (await api(`${O}/documents/${doc.id}`, {}, semDocs!)).status === 403);

    // ── Auditoria sem o texto do documento ────────────────────────────────
    const logs = db.prepare(
      "SELECT action, entity, after_json FROM audit_logs WHERE entity IN ('odonto_document', 'odonto_document_template') ORDER BY id",
    ).all() as { action: string; entity: string; after_json: string | null }[];
    check('auditoria registrou documentos e modelos', logs.length >= 6, `${logs.length} registro(s)`);
    check('auditoria NÃO copia o texto do documento', !logs.some((l) => (l.after_json ?? '').includes(TEXTO)));
    check('auditoria diz o tipo e quantas variáveis ficaram sem valor',
      logs.some((l) => (l.after_json ?? '').includes('"type":"tcle"') && (l.after_json ?? '').includes('variaveis_sem_valor')));

    // ── Excluir o paciente leva os documentos junto ───────────────────────
    await api(`${O}/patients/${paciente}`, { method: 'DELETE' }, admin!);
    const restantes = db.prepare(
      'SELECT COUNT(*) AS t FROM odonto_documents WHERE patient_id = ? AND deleted_at IS NULL',
    ).get(paciente) as { t: number };
    check('documentos do paciente excluído saem por soft delete', restantes.t === 0, `${restantes.t} linha(s)`);

    // ── Módulo fora do plano → API bloqueada ──────────────────────────────
    db.prepare(`UPDATE license SET modules_json = ?, license_key = 'teste', company_uuid = 'teste' WHERE id = 1`)
      .run(JSON.stringify(['commercial', 'finance']));
    check('módulo fora do plano → 403 nos documentos',
      (await api(`${O}/document-templates`, {}, admin!)).status === 403);
    db.prepare(`UPDATE license SET modules_json = NULL, license_key = NULL, company_uuid = NULL WHERE id = 1`).run();
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  console.log(failures === 0 ? '\nDocumentos: TODOS OS TESTES PASSARAM' : `\n${failures} falha(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
