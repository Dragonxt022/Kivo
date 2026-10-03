import type { Request } from 'express';
import { audit } from '../../core/audit/service';
import { assertAuth } from '../../shared/auth';
import { formatBRL } from '../../shared/money';
import { patientRepository } from './repositories/PatientRepository';
import { professionalRepository } from './repositories/ProfessionalRepository';
import { treatmentPlanRepository } from './repositories/TreatmentPlanRepository';
import { appointmentRepository } from './repositories/AppointmentRepository';
import {
  DOCUMENT_TYPES, DOCUMENT_TYPE_LABELS, documentRepository,
  type DocumentDetailRow, type DocumentTemplateRow, type DocumentType,
} from './repositories/DocumentRepository';
import type { Result } from './permissions';

/**
 * Documentos do paciente (PR §14) e modelos com variáveis (PR §15).
 *
 * A §15 pede que os documentos saiam de MODELOS com variáveis, "sem precisar programar cada
 * documento individualmente". Então o modelo é conteúdo em texto com `{{variavel}}` e este
 * serviço só substitui — os onze tipos da §14 são semeados como conteúdo, e a clínica cria os
 * seus pela tela.
 *
 * Duas decisões que protegem o consultório:
 *  - o documento guarda o texto JÁ RENDERIZADO (snapshot): editar o modelo depois não muda o
 *    documento que o paciente levou;
 *  - variável sem valor NÃO some: vira uma linha para preencher à mão e entra em
 *    `missing_variables_json`, para a tela avisar antes de emitir em vez de imprimir um
 *    documento furado.
 */

export const PERM_DOCUMENTS_VIEW = 'odonto.documents.view';
export const PERM_DOCUMENTS_MANAGE = 'odonto.documents.manage';
export const PERM_DOCUMENTS_TEMPLATES = 'odonto.documents.templates';

const VARIAVEL = /\{\{\s*([a-z0-9_.]+)\s*\}\}/gi;

/** Variáveis disponíveis, com exemplo — a tela mostra esta lista ao escrever o modelo. */
export const VARIABLES: { key: string; label: string; exemplo: string }[] = [
  { key: 'paciente.nome', label: 'Nome do paciente', exemplo: 'Maria Souza' },
  { key: 'paciente.cpf', label: 'CPF', exemplo: '123.456.789-00' },
  { key: 'paciente.rg', label: 'RG', exemplo: '1234567 SSP/MT' },
  { key: 'paciente.data_nascimento', label: 'Data de nascimento', exemplo: '14/06/1988' },
  { key: 'paciente.idade', label: 'Idade', exemplo: '37 anos' },
  { key: 'paciente.sexo', label: 'Sexo', exemplo: 'feminino' },
  { key: 'paciente.telefone', label: 'Telefone', exemplo: '(69) 99911-2233' },
  { key: 'paciente.email', label: 'E-mail', exemplo: 'maria@email.com' },
  { key: 'paciente.endereco', label: 'Endereço', exemplo: 'Rua das Flores, 120' },
  { key: 'profissional.nome', label: 'Nome do profissional', exemplo: 'Dra. Cláudia Menezes' },
  { key: 'profissional.cro', label: 'CRO', exemplo: '12345/MT' },
  { key: 'profissional.especialidade', label: 'Especialidade', exemplo: 'Dentística' },
  { key: 'data', label: 'Data de hoje', exemplo: '03/10/2026' },
  { key: 'hora', label: 'Hora agora', exemplo: '14:30' },
  { key: 'data_hora', label: 'Data e hora', exemplo: '03/10/2026 14:30' },
  { key: 'procedimento', label: 'Procedimento da consulta', exemplo: 'Restauração em resina' },
  { key: 'consulta.data', label: 'Data da consulta vinculada', exemplo: '10/11/2026' },
  { key: 'consulta.hora', label: 'Hora da consulta vinculada', exemplo: '09:00' },
  { key: 'plano.total', label: 'Total do plano vinculado', exemplo: 'R$ 2.400,00' },
  { key: 'plano.itens', label: 'Itens do plano vinculado', exemplo: '26 — Restauração (R$ 900,00)' },
];

export function extractVariables(body: string): string[] {
  const achadas = new Set<string>();
  for (const m of String(body ?? '').matchAll(VARIAVEL)) achadas.add(m[1].toLowerCase());
  return [...achadas];
}

function dataBr(iso: string | null | undefined): string {
  if (!iso) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso));
  return m ? `${m[3]}/${m[2]}/${m[1]}` : String(iso);
}

export function idadeDe(nascimento: string | null | undefined, hoje = new Date()): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(nascimento ?? ''));
  if (!m) return '';
  const ano = Number(m[1]); const mes = Number(m[2]); const dia = Number(m[3]);
  let idade = hoje.getFullYear() - ano;
  const passou = hoje.getMonth() + 1 > mes || (hoje.getMonth() + 1 === mes && hoje.getDate() >= dia);
  if (!passou) idade--;
  return idade >= 0 ? `${idade} anos` : '';
}

function agoraPartes(): { data: string; hora: string; dataHora: string } {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  const data = `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()}`;
  const hora = `${p(d.getHours())}:${p(d.getMinutes())}`;
  return { data, hora, dataHora: `${data} ${hora}` };
}

export type ContextoDocumento = Record<string, string>;

/** Junta os valores do paciente, do profissional, da consulta e do plano. */
export function contexto(
  patientId: number,
  opts: { professionalId?: number | null; appointmentId?: number | null; planId?: number | null } = {},
): Result<ContextoDocumento> {
  // `findDetail` já junta o cliente: nome, documento, telefone, e-mail, endereço e nascimento.
  const paciente = patientRepository.findDetail(patientId);
  if (!paciente) return { ok: false, error: 'Paciente não encontrado.', status: 404 };
  const agora = agoraPartes();

  const ctx: ContextoDocumento = {
    'paciente.nome': paciente.name,
    'paciente.cpf': paciente.document ?? '',
    'paciente.data_nascimento': dataBr(paciente.birthday),
    'paciente.idade': idadeDe(paciente.birthday),
    'paciente.sexo': paciente.sex ?? '',
    'paciente.rg': paciente.rg ?? '',
    'paciente.telefone': paciente.phone ?? '',
    'paciente.email': paciente.email ?? '',
    'paciente.endereco': paciente.address ?? '',
    data: agora.data,
    hora: agora.hora,
    'data_hora': agora.dataHora,
    hoje: agora.data,
  };

  if (opts.professionalId) {
    const p = professionalRepository.findById(Number(opts.professionalId));
    if (p) {
      ctx['profissional.nome'] = p.name;
      ctx['profissional.cro'] = p.cro ? `${p.cro}${p.cro_state ? '/' + p.cro_state : ''}` : '';
      ctx['profissional.especialidade'] = p.specialties ?? '';
    }
  }

  if (opts.appointmentId) {
    const a = appointmentRepository.findDetail(Number(opts.appointmentId));
    if (a) {
      ctx['consulta.data'] = dataBr(a.starts_at);
      ctx['consulta.hora'] = String(a.starts_at).slice(11, 16);
      if (!ctx['procedimento'] && a.procedure_name) ctx['procedimento'] = a.procedure_name;
    }
  }

  if (opts.planId) {
    const plano = treatmentPlanRepository.findDetail(Number(opts.planId));
    if (plano) {
      ctx['plano.total'] = formatBRL(Number(plano.total_cents ?? 0));
      const itens = treatmentPlanRepository.listItems(Number(opts.planId))
        .filter((i) => i.status !== 'cancelado')
        .map((i) => `${i.tooth ? i.tooth + ' — ' : ''}${i.description} (${formatBRL(i.amount_cents * i.quantity)})`);
      ctx['plano.itens'] = itens.join('\n');
    }
  }

  return { ok: true, data: ctx };
}

/**
 * Substitui as variáveis. O que não tem valor vira linha para preencher à mão e é devolvido em
 * `missing` — documento com buraco silencioso é pior do que documento com linha para assinar.
 */
export function render(body: string, ctx: ContextoDocumento): { text: string; missing: string[] } {
  const faltando = new Set<string>();
  const text = String(body ?? '').replace(VARIAVEL, (_todo, nome: string) => {
    const chave = nome.toLowerCase();
    const valor = ctx[chave];
    if (valor === undefined) { faltando.add(chave); return '{{' + nome + '}}'; }
    if (!String(valor).trim()) { faltando.add(chave); return '____________________'; }
    return String(valor);
  });
  return { text, missing: [...faltando] };
}

// ─────────────────────────────── Modelos ───────────────────────────────

export interface TemplateOutput {
  id: number;
  code: string | null;
  name: string;
  type: DocumentType;
  type_label: string;
  body: string;
  variables: string[];
  requires_professional: boolean;
  active: boolean;
  is_system: boolean;
  sort_order: number;
}

function modelo(row: DocumentTemplateRow): TemplateOutput {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    type: row.type,
    type_label: DOCUMENT_TYPE_LABELS[row.type] ?? row.type,
    body: row.body,
    variables: extractVariables(row.body),
    requires_professional: Number(row.requires_professional) === 1,
    active: Number(row.active) === 1,
    is_system: Number(row.is_system) === 1,
    sort_order: row.sort_order,
  };
}

export function listTemplates(req: Request, opts: { type?: string; activeOnly?: boolean } = {}): Result<TemplateOutput[]> {
  if (!req.user?.permissions.has(PERM_DOCUMENTS_VIEW)) {
    return { ok: false, error: `Permissão negada: ${PERM_DOCUMENTS_VIEW}`, status: 403 };
  }
  return { ok: true, data: documentRepository.listTemplates(opts).map(modelo) };
}

export interface TemplateInput {
  code?: string | null;
  name?: string;
  type?: string;
  body?: string;
  requires_professional?: boolean | number;
  active?: boolean | number;
  sort_order?: number;
}

export function createTemplate(req: Request, input: TemplateInput): Result<TemplateOutput> {
  assertAuth(req);
  if (!req.user?.permissions.has(PERM_DOCUMENTS_TEMPLATES)) {
    return { ok: false, error: `Permissão negada: ${PERM_DOCUMENTS_TEMPLATES}`, status: 403 };
  }
  const nome = String(input.name ?? '').trim();
  if (!nome || nome.length > 120) return { ok: false, error: 'Informe o nome do modelo (até 120 caracteres).', status: 400 };
  const tipo = String(input.type ?? 'outro');
  if (!(DOCUMENT_TYPES as readonly string[]).includes(tipo)) {
    return { ok: false, error: `Tipo inválido: use ${DOCUMENT_TYPES.join(', ')}.`, status: 400 };
  }
  const corpo = String(input.body ?? '').trim();
  if (!corpo) return { ok: false, error: 'O modelo precisa de conteúdo.', status: 400 };
  const code = input.code ? String(input.code).trim().toLowerCase().replace(/[^a-z0-9_]/g, '_') : null;
  if (code && documentRepository.findTemplateByCode(code)) {
    return { ok: false, error: `Já existe um modelo com o código "${code}".`, status: 409 };
  }

  let id = 0;
  documentRepository.transaction(() => {
    id = documentRepository.createTemplate({
      code,
      name: nome,
      type: tipo,
      body: corpo,
      variables_json: JSON.stringify(extractVariables(corpo)),
      requires_professional: input.requires_professional ? 1 : 0,
      active: input.active === false || input.active === 0 ? 0 : 1,
      sort_order: Number(input.sort_order ?? 100),
      is_system: 0,
    });
  });
  audit(req, 'criar', 'odonto_document_template', id, null, {
    name: nome, type: tipo, variaveis: extractVariables(corpo).length,
  });
  return { ok: true, data: modelo(documentRepository.findTemplate(id)!) };
}

export function updateTemplate(req: Request, id: number, input: TemplateInput): Result<TemplateOutput> {
  assertAuth(req);
  if (!req.user?.permissions.has(PERM_DOCUMENTS_TEMPLATES)) {
    return { ok: false, error: `Permissão negada: ${PERM_DOCUMENTS_TEMPLATES}`, status: 403 };
  }
  const atual = documentRepository.findTemplate(id);
  if (!atual) return { ok: false, error: 'Modelo de documento não encontrado.', status: 404 };

  const patch: Record<string, unknown> = {};
  if (input.name !== undefined) {
    const nome = String(input.name).trim();
    if (!nome || nome.length > 120) return { ok: false, error: 'Informe o nome do modelo (até 120 caracteres).', status: 400 };
    patch.name = nome;
  }
  if (input.type !== undefined) {
    if (!(DOCUMENT_TYPES as readonly string[]).includes(String(input.type))) {
      return { ok: false, error: `Tipo inválido: use ${DOCUMENT_TYPES.join(', ')}.`, status: 400 };
    }
    patch.type = String(input.type);
  }
  if (input.body !== undefined) {
    const corpo = String(input.body).trim();
    if (!corpo) return { ok: false, error: 'O modelo precisa de conteúdo.', status: 400 };
    patch.body = corpo;
    patch.variables_json = JSON.stringify(extractVariables(corpo));
  }
  if (input.requires_professional !== undefined) patch.requires_professional = input.requires_professional ? 1 : 0;
  if (input.active !== undefined) patch.active = input.active === false || input.active === 0 ? 0 : 1;
  if (input.sort_order !== undefined) patch.sort_order = Number(input.sort_order);

  documentRepository.updateTemplate(id, patch);
  audit(req, 'editar', 'odonto_document_template', id, { name: atual.name }, {
    name: (patch.name as string) ?? atual.name,
    variaveis: patch.body ? extractVariables(String(patch.body)).length : undefined,
  });
  return { ok: true, data: modelo(documentRepository.findTemplate(id)!) };
}

/** Modelo em uso não é apagado: desativa (os documentos apontam para ele). */
export function removeTemplate(req: Request, id: number): Result<{ desativado: boolean }> {
  assertAuth(req);
  if (!req.user?.permissions.has(PERM_DOCUMENTS_TEMPLATES)) {
    return { ok: false, error: `Permissão negada: ${PERM_DOCUMENTS_TEMPLATES}`, status: 403 };
  }
  const atual = documentRepository.findTemplate(id);
  if (!atual) return { ok: false, error: 'Modelo de documento não encontrado.', status: 404 };
  const uso = documentRepository.templateUsage(id);
  if (uso > 0) {
    documentRepository.updateTemplate(id, { active: 0 });
    audit(req, 'editar', 'odonto_document_template', id, { active: atual.active }, { active: 0, documentos: uso });
    return { ok: true, data: { desativado: true } };
  }
  documentRepository.softDeleteTemplate(id);
  audit(req, 'excluir', 'odonto_document_template', id, { name: atual.name }, null);
  return { ok: true, data: { desativado: false } };
}

// ─────────────────────────────── Documentos ───────────────────────────────

export interface DocumentOutput {
  id: number;
  patient_id: number;
  patient_name: string;
  appointment_id: number | null;
  appointment_at: string | null;
  plan_id: number | null;
  plan_title: string | null;
  template_id: number | null;
  template_name: string | null;
  type: DocumentType;
  type_label: string;
  title: string;
  body: string;
  status: 'rascunho' | 'emitido' | 'cancelado';
  version: number;
  replaces_id: number | null;
  replaced_by_id: number | null;
  missing_variables: string[];
  professional_id: number | null;
  professional_name: string | null;
  professional_cro: string | null;
  issued_at: string | null;
  cancelled_at: string | null;
  cancel_reason: string | null;
  created_by_name: string | null;
  created_at: string;
}

function documento(row: DocumentDetailRow, comCorpo = true): DocumentOutput {
  let faltando: string[] = [];
  try {
    faltando = row.missing_variables_json ? JSON.parse(row.missing_variables_json) as string[] : [];
  } catch {
    faltando = [];
  }
  return {
    id: row.id,
    patient_id: row.patient_id,
    patient_name: row.patient_name,
    appointment_id: row.appointment_id,
    appointment_at: row.appointment_at,
    plan_id: row.plan_id,
    plan_title: row.plan_title,
    template_id: row.template_id,
    template_name: row.template_name,
    type: row.type,
    type_label: DOCUMENT_TYPE_LABELS[row.type] ?? row.type,
    title: row.title,
    body: comCorpo ? row.body : '',
    status: row.status,
    version: row.version,
    replaces_id: row.replaces_id,
    replaced_by_id: row.replaced_by_id,
    missing_variables: faltando,
    professional_id: row.professional_id,
    professional_name: row.professional_name_snapshot,
    professional_cro: row.professional_cro_snapshot,
    issued_at: row.issued_at,
    cancelled_at: row.cancelled_at,
    cancel_reason: row.cancel_reason,
    created_by_name: row.created_by_name,
    created_at: row.created_at,
  };
}

export function listDocuments(req: Request, patientId: number, opts: { type?: string } = {}): Result<{
  items: DocumentOutput[];
  resumo: { total: number; emitidos: number; rascunhos: number; ultimo_em: string | null };
  types: { type: DocumentType; label: string }[];
}> {
  if (!req.user?.permissions.has(PERM_DOCUMENTS_VIEW)) {
    return { ok: false, error: `Permissão negada: ${PERM_DOCUMENTS_VIEW}`, status: 403 };
  }
  if (!patientRepository.findById(patientId)) return { ok: false, error: 'Paciente não encontrado.', status: 404 };
  return {
    ok: true,
    data: {
      // Sem o corpo na lista: a lista não precisa carregar texto de documento.
      items: documentRepository.listByPatient(patientId, opts).map((d) => documento(d, false)),
      resumo: documentRepository.resumo(patientId),
      types: DOCUMENT_TYPES.map((t) => ({ type: t, label: DOCUMENT_TYPE_LABELS[t] })),
    },
  };
}

export function getDocument(
  req: Request,
  id: number,
): Result<DocumentOutput & { revision_chain: { id: number; version: number; status: string; created_at: string }[] }> {
  if (!req.user?.permissions.has(PERM_DOCUMENTS_VIEW)) {
    return { ok: false, error: `Permissão negada: ${PERM_DOCUMENTS_VIEW}`, status: 403 };
  }
  const row = documentRepository.findDocument(id);
  if (!row) return { ok: false, error: 'Documento não encontrado.', status: 404 };
  const cadeia = documentRepository.revisionChain(id)
    .map((d) => ({ id: d.id, version: d.version, status: d.status, created_at: d.created_at }));
  return { ok: true, data: { ...documento(row), revision_chain: cadeia } };
}

export interface DocumentInput {
  template_id?: number | null;
  type?: string;
  title?: string;
  body?: string;
  appointment_id?: number | null;
  plan_id?: number | null;
  professional_id?: number | null;
}

/**
 * Gera o documento: pega o corpo (do modelo ou digitado), substitui as variáveis do paciente e
 * grava o RESULTADO. Nasce como rascunho.
 */
export function createDocument(req: Request, patientId: number, input: DocumentInput): Result<DocumentOutput> {
  assertAuth(req);
  if (!req.user?.permissions.has(PERM_DOCUMENTS_MANAGE)) {
    return { ok: false, error: `Permissão negada: ${PERM_DOCUMENTS_MANAGE}`, status: 403 };
  }
  if (!patientRepository.findById(patientId)) return { ok: false, error: 'Paciente não encontrado.', status: 404 };

  const template = input.template_id ? documentRepository.findTemplate(Number(input.template_id)) : undefined;
  if (input.template_id && !template) return { ok: false, error: 'Modelo de documento não encontrado.', status: 404 };

  const tipo = String(input.type ?? template?.type ?? 'outro');
  if (!(DOCUMENT_TYPES as readonly string[]).includes(tipo)) {
    return { ok: false, error: `Tipo inválido: use ${DOCUMENT_TYPES.join(', ')}.`, status: 400 };
  }
  const corpoBase = String(input.body ?? template?.body ?? '').trim();
  if (!corpoBase) return { ok: false, error: 'O documento precisa de conteúdo (ou escolha um modelo).', status: 400 };

  const profissionalId = input.professional_id ? Number(input.professional_id) : null;
  if (profissionalId && !professionalRepository.findById(profissionalId)) {
    return { ok: false, error: 'Profissional não encontrado.', status: 400 };
  }
  // Consulta e plano vinculados têm de ser do MESMO paciente (PR §24.2).
  if (input.appointment_id) {
    const a = appointmentRepository.findDetail(Number(input.appointment_id));
    if (!a || a.patient_id !== patientId) return { ok: false, error: 'Consulta vinculada não é deste paciente.', status: 400 };
  }
  if (input.plan_id) {
    const plano = treatmentPlanRepository.findDetail(Number(input.plan_id));
    if (!plano || plano.patient_id !== patientId) return { ok: false, error: 'Plano vinculado não é deste paciente.', status: 400 };
  }

  const ctx = contexto(patientId, {
    professionalId: profissionalId,
    appointmentId: input.appointment_id ? Number(input.appointment_id) : null,
    planId: input.plan_id ? Number(input.plan_id) : null,
  });
  if (!ctx.ok) return ctx;
  const { text, missing } = render(corpoBase, ctx.data);

  const titulo = String(input.title ?? template?.name ?? DOCUMENT_TYPE_LABELS[tipo as DocumentType] ?? 'Documento')
    .trim().slice(0, 160);
  const profissional = profissionalId ? professionalRepository.findById(profissionalId) : undefined;

  let id = 0;
  documentRepository.transaction(() => {
    id = documentRepository.createDocument({
      patient_id: patientId,
      appointment_id: input.appointment_id ? Number(input.appointment_id) : null,
      plan_id: input.plan_id ? Number(input.plan_id) : null,
      template_id: template?.id ?? null,
      type: tipo,
      title: titulo,
      body: text,
      status: 'rascunho',
      version: 1,
      missing_variables_json: JSON.stringify(missing),
      professional_id: profissionalId,
      professional_name_snapshot: profissional?.name ?? null,
      professional_cro_snapshot: profissional?.cro
        ? `${profissional.cro}${profissional.cro_state ? '/' + profissional.cro_state : ''}` : null,
      created_by: req.user?.id ?? null,
    });
  });

  audit(req, 'criar', 'odonto_document', id, null, {
    patient_id: patientId, type: tipo, template_id: template?.id ?? null,
    versao: 1, variaveis_sem_valor: missing.length,
  });
  return { ok: true, data: documento(documentRepository.findDocument(id)!) };
}

/** Edita só RASCUNHO: emitido não muda em silêncio (gera-se a versão seguinte). */
export function updateDocument(req: Request, id: number, input: DocumentInput): Result<DocumentOutput> {
  assertAuth(req);
  if (!req.user?.permissions.has(PERM_DOCUMENTS_MANAGE)) {
    return { ok: false, error: `Permissão negada: ${PERM_DOCUMENTS_MANAGE}`, status: 403 };
  }
  const atual = documentRepository.findDocument(id);
  if (!atual) return { ok: false, error: 'Documento não encontrado.', status: 404 };
  if (atual.status !== 'rascunho') {
    return {
      ok: false, status: 400,
      error: atual.status === 'emitido'
        ? 'Documento emitido não é editado: gere a versão seguinte (o emitido fica no histórico).'
        : 'Documento cancelado não é editado.',
    };
  }

  const patch: Record<string, unknown> = {};
  if (input.title !== undefined) {
    const titulo = String(input.title).trim();
    if (!titulo) return { ok: false, error: 'Informe o título do documento.', status: 400 };
    patch.title = titulo.slice(0, 160);
  }
  if (input.body !== undefined) {
    const corpo = String(input.body).trim();
    if (!corpo) return { ok: false, error: 'O documento precisa de conteúdo.', status: 400 };
    // Ao editar, as variáveis são substituídas de novo com os dados atuais.
    const ctx = contexto(atual.patient_id, {
      professionalId: input.professional_id !== undefined
        ? (input.professional_id ? Number(input.professional_id) : null) : atual.professional_id,
      appointmentId: atual.appointment_id,
      planId: atual.plan_id,
    });
    if (!ctx.ok) return ctx;
    const { text, missing } = render(corpo, ctx.data);
    patch.body = text;
    patch.missing_variables_json = JSON.stringify(missing);
  }
  if (input.professional_id !== undefined) {
    const profissionalId = input.professional_id ? Number(input.professional_id) : null;
    const p = profissionalId ? professionalRepository.findById(profissionalId) : undefined;
    if (profissionalId && !p) return { ok: false, error: 'Profissional não encontrado.', status: 400 };
    patch.professional_id = profissionalId;
    patch.professional_name_snapshot = p?.name ?? null;
    patch.professional_cro_snapshot = p?.cro ? `${p.cro}${p.cro_state ? '/' + p.cro_state : ''}` : null;
  }
  if (input.appointment_id !== undefined) {
    if (input.appointment_id) {
      const a = appointmentRepository.findDetail(Number(input.appointment_id));
      if (!a || a.patient_id !== atual.patient_id) return { ok: false, error: 'Consulta vinculada não é deste paciente.', status: 400 };
    }
    patch.appointment_id = input.appointment_id ? Number(input.appointment_id) : null;
  }
  if (input.plan_id !== undefined) {
    if (input.plan_id) {
      const plano = treatmentPlanRepository.findDetail(Number(input.plan_id));
      if (!plano || plano.patient_id !== atual.patient_id) return { ok: false, error: 'Plano vinculado não é deste paciente.', status: 400 };
    }
    patch.plan_id = input.plan_id ? Number(input.plan_id) : null;
  }

  documentRepository.updateDocument(id, patch);
  audit(req, 'editar', 'odonto_document', id, { status: atual.status }, { status: atual.status, campos: Object.keys(patch).length });
  return { ok: true, data: documento(documentRepository.findDocument(id)!) };
}

/** Emite o documento: sai do rascunho e vira o que o paciente leva. */
export function issueDocument(req: Request, id: number, professionalId?: number | null): Result<DocumentOutput> {
  assertAuth(req);
  if (!req.user?.permissions.has(PERM_DOCUMENTS_MANAGE)) {
    return { ok: false, error: `Permissão negada: ${PERM_DOCUMENTS_MANAGE}`, status: 403 };
  }
  const atual = documentRepository.findDocument(id);
  if (!atual) return { ok: false, error: 'Documento não encontrado.', status: 404 };
  if (atual.status !== 'rascunho') {
    return { ok: false, status: 400, error: `Documento já está ${atual.status === 'emitido' ? 'emitido' : 'cancelado'}.` };
  }

  const modelo = atual.template_id ? documentRepository.findTemplate(atual.template_id) : undefined;
  const profissionalId = professionalId !== undefined && professionalId !== null
    ? Number(professionalId) : atual.professional_id;
  if (modelo && Number(modelo.requires_professional) === 1 && !profissionalId) {
    return {
      ok: false, status: 400,
      error: `"${DOCUMENT_TYPE_LABELS[atual.type]}" precisa do profissional responsável (com CRO) antes de emitir.`,
    };
  }
  const p = profissionalId ? professionalRepository.findById(profissionalId) : undefined;
  if (profissionalId && !p) return { ok: false, error: 'Profissional não encontrado.', status: 400 };
  if (p && !p.cro) {
    return { ok: false, status: 400, error: `O profissional ${p.name} está sem CRO cadastrado — documento clínico exige CRO.` };
  }

  documentRepository.updateDocument(id, {
    status: 'emitido',
    issued_at: new Date().toISOString().slice(0, 19).replace('T', ' '),
    professional_id: profissionalId ?? null,
    professional_name_snapshot: p?.name ?? atual.professional_name_snapshot,
    professional_cro_snapshot: p?.cro
      ? `${p.cro}${p.cro_state ? '/' + p.cro_state : ''}` : atual.professional_cro_snapshot,
  });
  audit(req, 'editar', 'odonto_document', id, { status: 'rascunho' }, { status: 'emitido', type: atual.type });
  return { ok: true, data: documento(documentRepository.findDocument(id)!) };
}

export function cancelDocument(req: Request, id: number, motivo: unknown): Result<DocumentOutput> {
  assertAuth(req);
  if (!req.user?.permissions.has(PERM_DOCUMENTS_MANAGE)) {
    return { ok: false, error: `Permissão negada: ${PERM_DOCUMENTS_MANAGE}`, status: 403 };
  }
  const atual = documentRepository.findDocument(id);
  if (!atual) return { ok: false, error: 'Documento não encontrado.', status: 404 };
  if (atual.status === 'cancelado') return { ok: false, error: 'Documento já está cancelado.', status: 400 };

  const razao = String(motivo ?? '').trim().slice(0, 300);
  if (razao.length < 3) return { ok: false, error: 'Informe o motivo do cancelamento.', status: 400 };

  documentRepository.updateDocument(id, {
    status: 'cancelado',
    cancelled_at: new Date().toISOString().slice(0, 19).replace('T', ' '),
    cancel_reason: razao,
  });
  audit(req, 'editar', 'odonto_document', id, { status: atual.status }, { status: 'cancelado', motivo: razao });
  return { ok: true, data: documento(documentRepository.findDocument(id)!) };
}

/**
 * Nova versão a partir de um documento: cria um RASCUNHO com o texto atual, ligado ao anterior.
 * O documento anterior continua no histórico (é o que foi entregue ao paciente).
 */
export function newVersion(req: Request, id: number): Result<DocumentOutput> {
  assertAuth(req);
  if (!req.user?.permissions.has(PERM_DOCUMENTS_MANAGE)) {
    return { ok: false, error: `Permissão negada: ${PERM_DOCUMENTS_MANAGE}`, status: 403 };
  }
  const atual = documentRepository.findDocument(id);
  if (!atual) return { ok: false, error: 'Documento não encontrado.', status: 404 };
  if (atual.status === 'cancelado') return { ok: false, error: 'Documento cancelado não gera nova versão.', status: 400 };
  if (documentRepository.listByPatient(atual.patient_id).some((d) => d.replaces_id === id && d.status === 'rascunho')) {
    return { ok: false, status: 400, error: 'Já existe uma versão em rascunho deste documento.' };
  }

  let novoId = 0;
  documentRepository.transaction(() => {
    novoId = documentRepository.createDocument({
      patient_id: atual.patient_id,
      appointment_id: atual.appointment_id,
      plan_id: atual.plan_id,
      template_id: atual.template_id,
      type: atual.type,
      title: atual.title,
      body: atual.body,
      status: 'rascunho',
      version: atual.version + 1,
      replaces_id: atual.id,
      missing_variables_json: atual.missing_variables_json,
      professional_id: atual.professional_id,
      professional_name_snapshot: atual.professional_name_snapshot,
      professional_cro_snapshot: atual.professional_cro_snapshot,
      created_by: req.user?.id ?? null,
    });
    documentRepository.updateDocument(atual.id, { replaced_by_id: novoId });
  });

  audit(req, 'criar', 'odonto_document', novoId, null, {
    versao: atual.version + 1, substitui: atual.id, type: atual.type,
  });
  return { ok: true, data: documento(documentRepository.findDocument(novoId)!) };
}

export function removeDocument(req: Request, id: number): Result<{ removido: boolean }> {
  assertAuth(req);
  if (!req.user?.permissions.has(PERM_DOCUMENTS_MANAGE)) {
    return { ok: false, error: `Permissão negada: ${PERM_DOCUMENTS_MANAGE}`, status: 403 };
  }
  const atual = documentRepository.findDocument(id);
  if (!atual) return { ok: false, error: 'Documento não encontrado.', status: 404 };
  if (atual.status !== 'rascunho') {
    return { ok: false, status: 400, error: 'Só rascunho é apagado: documento emitido fica no histórico (cancele, se for o caso).' };
  }
  documentRepository.softDeleteDocument(id);
  audit(req, 'excluir', 'odonto_document', id, { status: atual.status, type: atual.type }, null);
  return { ok: true, data: { removido: true } };
}

/** Excluir o paciente leva os documentos junto (o chamador já garante a transação). */
export function removeDocumentsByPatient(patientId: number): void {
  documentRepository.softDeleteByPatient(patientId);
}

// ─────────────────────── Modelos que vêm com o sistema ───────────────────────

/**
 * Conteúdo inicial de cada tipo da PR §14. É ponto de partida: a clínica edita pela tela.
 * (Não é parecer jurídico — quem assina é o cirurgião-dentista; os textos trazem os campos que
 * a prática costuma exigir.)
 */
export const DEFAULT_TEMPLATES: {
  code: string; name: string; type: DocumentType; requires_professional: boolean; body: string;
}[] = [
  {
    code: 'tcle_padrao', name: 'TCLE — consentimento livre e esclarecido', type: 'tcle', requires_professional: true,
    body: [
      'TERMO DE CONSENTIMENTO LIVRE E ESCLARECIDO',
      '',
      'Paciente: {{paciente.nome}}',
      'CPF: {{paciente.cpf}}          Nascimento: {{paciente.data_nascimento}} ({{paciente.idade}})',
      'Profissional: {{profissional.nome}} — CRO {{profissional.cro}}',
      'Data: {{data}}',
      '',
      'Declaro que fui informado(a), em linguagem clara, sobre o meu diagnóstico, o tratamento',
      'proposto, os procedimentos necessários, os riscos e as complicações possíveis, as',
      'alternativas de tratamento existentes e as consequências da não realização do tratamento.',
      '',
      'Fui informado(a) também sobre os cuidados pós-operatórios, a necessidade de comparecer aos',
      'retornos e de comunicar qualquer sintoma fora do esperado.',
      '',
      'Estou ciente de que o resultado depende de fatores individuais, do meu comparecimento às',
      'consultas e da execução correta das orientações recebidas.',
      '',
      'Autorizo a realização do tratamento proposto e o registro dos meus dados clínicos no',
      'prontuário, nos termos da LGPD (Lei 13.709/2018), para fins de atendimento e guarda do',
      'histórico odontológico.',
      '',
      'Procedimento(s): {{procedimento}}',
      '',
      '____________________________, ____ de __________________ de __________',
      '',
      '________________________________________',
      'Assinatura do paciente ou responsável legal',
      '',
      '________________________________________',
      '{{profissional.nome}} — CRO {{profissional.cro}}',
    ].join('\n'),
  },
  {
    code: 'contrato_padrao', name: 'Contrato de prestação de serviços odontológicos', type: 'contrato', requires_professional: true,
    body: [
      'CONTRATO DE PRESTAÇÃO DE SERVIÇOS ODONTOLÓGICOS',
      '',
      'CONTRATADO: ____________________________________ (clínica), CNPJ __________________.',
      'CONTRATANTE: {{paciente.nome}}, CPF {{paciente.cpf}}, nascido(a) em {{paciente.data_nascimento}},',
      'residente em {{paciente.endereco}}, telefone {{paciente.telefone}}.',
      '',
      '1. OBJETO — prestação de serviços odontológicos conforme o plano de tratamento aprovado:',
      '',
      '{{plano.itens}}',
      '',
      'Valor total: {{plano.total}}',
      '',
      '2. FORMA DE PAGAMENTO — conforme parcelamento acordado e registrado no financeiro da clínica.',
      '3. OBRIGAÇÕES DO CONTRATANTE — comparecer às consultas agendadas, seguir as orientações e',
      '   comunicar alterações de saúde e de contato.',
      '4. OBRIGAÇÕES DO CONTRATADO — executar os procedimentos com técnica e materiais adequados,',
      '   manter prontuário e sigilo dos dados do paciente.',
      '5. RESCISÃO — o contrato pode ser encerrado por qualquer das partes, respondendo o',
      '   contratante pelos serviços já executados.',
      '6. LGPD — os dados do paciente são tratados para a finalidade de atendimento odontológico e',
      '   guarda de prontuário.',
      '',
      '{{data}}',
      '',
      '____________________________                ____________________________',
      'CONTRATANTE                                 CONTRATADO',
    ].join('\n'),
  },
  {
    code: 'receita_padrao', name: 'Receita', type: 'receita', requires_professional: true,
    body: [
      'RECEITUÁRIO ODONTOLÓGICO',
      '',
      'Paciente: {{paciente.nome}}          Data: {{data}}',
      '',
      'Uso oral:',
      '',
      '1) ____________________________________  ______ comprimidos — tomar de ____/____h por ____ dias.',
      '2) ____________________________________  ______ comprimidos — tomar de ____/____h por ____ dias.',
      '',
      'Orientações:',
      '- Não interromper o uso antes do prazo indicado.',
      '- Em caso de alergia ou reação, suspender e procurar atendimento.',
      '',
      '{{data}}',
      '',
      '________________________________________',
      '{{profissional.nome}} — CRO {{profissional.cro}}',
    ].join('\n'),
  },
  {
    code: 'atestado_padrao', name: 'Atestado odontológico', type: 'atestado', requires_professional: true,
    body: [
      'ATESTADO ODONTOLÓGICO',
      '',
      'Atesto, na qualidade de cirurgião(ã)-dentista, que o(a) paciente {{paciente.nome}},',
      'CPF {{paciente.cpf}}, esteve sob meus cuidados profissionais nesta data,',
      'necessitando de ______ dia(s) de afastamento de suas atividades a partir de {{data}}.',
      '',
      'CID (quando autorizado pelo paciente): ________',
      '',
      '{{data}}',
      '',
      '________________________________________',
      '{{profissional.nome}} — CRO {{profissional.cro}}',
    ].join('\n'),
  },
  {
    code: 'declaracao_comparecimento', name: 'Declaração de comparecimento', type: 'declaracao', requires_professional: true,
    body: [
      'DECLARAÇÃO DE COMPARECIMENTO',
      '',
      'Declaro que {{paciente.nome}}, CPF {{paciente.cpf}}, compareceu a esta clínica no dia',
      '{{data}}, no período de ____h às ____h, para atendimento odontológico.',
      '',
      '{{data}}',
      '',
      '________________________________________',
      '{{profissional.nome}} — CRO {{profissional.cro}}',
    ].join('\n'),
  },
  {
    code: 'encaminhamento_padrao', name: 'Encaminhamento', type: 'encaminhamento', requires_professional: true,
    body: [
      'ENCAMINHAMENTO',
      '',
      'Encaminho o(a) paciente {{paciente.nome}}, CPF {{paciente.cpf}}, nascido(a) em',
      '{{paciente.data_nascimento}}, para avaliação e conduta em:',
      '',
      'Especialidade / profissional de destino: ____________________________________',
      '',
      'Motivo do encaminhamento:',
      '______________________________________________________________',
      '',
      'Dados clínicos relevantes:',
      '______________________________________________________________',
      '',
      'Agradeço a colaboração e coloco-me à disposição.',
      '',
      '{{data}}',
      '',
      '________________________________________',
      '{{profissional.nome}} — CRO {{profissional.cro}}',
    ].join('\n'),
  },
  {
    code: 'termo_recusa_padrao', name: 'Termo de recusa de tratamento', type: 'termo_recusa', requires_professional: true,
    body: [
      'TERMO DE RECUSA DE TRATAMENTO',
      '',
      'Paciente: {{paciente.nome}} — CPF {{paciente.cpf}}',
      '',
      'Fui informado(a) da necessidade do seguinte tratamento:',
      '______________________________________________________________',
      '',
      'Fui informado(a) dos riscos de não realizar o tratamento indicado, incluindo a evolução do',
      'quadro, a perda da possibilidade de tratamento mais simples e a necessidade de',
      'procedimentos mais complexos no futuro.',
      '',
      'Mesmo assim, declaro que RECUSO a realização do tratamento proposto nesta data, por decisão',
      'própria e consciente.',
      '',
      '{{data}}',
      '',
      '________________________________________',
      'Assinatura do paciente ou responsável legal',
      '',
      '________________________________________',
      '{{profissional.nome}} — CRO {{profissional.cro}}',
    ].join('\n'),
  },
  {
    code: 'termo_responsabilidade_padrao', name: 'Termo de responsabilidade', type: 'termo_responsabilidade', requires_professional: false,
    body: [
      'TERMO DE RESPONSABILIDADE',
      '',
      'Paciente: {{paciente.nome}} — CPF {{paciente.cpf}}',
      '',
      'Declaro que recebi as orientações sobre os cuidados necessários e me comprometo a:',
      '',
      '- seguir as orientações de higiene e de cuidado pós-procedimento;',
      '- comparecer aos retornos agendados;',
      '- comunicar qualquer alteração de saúde ou uso de medicação;',
      '- informar o aparecimento de sintomas como dor persistente, sangramento ou mobilidade.',
      '',
      'Estou ciente de que o descumprimento dessas orientações pode comprometer o resultado do',
      'tratamento.',
      '',
      '{{data}}',
      '',
      '________________________________________',
      'Assinatura do paciente ou responsável legal',
    ].join('\n'),
  },
  {
    code: 'alta_padrao', name: 'Termo de alta do tratamento', type: 'alta', requires_professional: true,
    body: [
      'ALTA ODONTOLÓGICA',
      '',
      'Paciente: {{paciente.nome}} — CPF {{paciente.cpf}}',
      '',
      'Declaro que o tratamento proposto foi concluído nesta data, com as seguintes considerações:',
      '______________________________________________________________',
      '',
      'Orientações de manutenção:',
      '- retornar a cada ______ meses para controle preventivo;',
      '- manter escovação e uso de fio dental;',
      '- procurar a clínica em caso de dor, sangramento ou fratura.',
      '',
      '{{data}}',
      '',
      '________________________________________',
      '{{profissional.nome}} — CRO {{profissional.cro}}',
    ].join('\n'),
  },
  {
    code: 'resumo_anamnese', name: 'Resumo de anamnese', type: 'anamnese', requires_professional: false,
    body: [
      'RESUMO DE ANAMNESE',
      '',
      'Paciente: {{paciente.nome}}',
      'CPF: {{paciente.cpf}}          Telefone: {{paciente.telefone}}',
      'Nascimento: {{paciente.data_nascimento}} ({{paciente.idade}})',
      'Data do registro: {{data_hora}}',
      '',
      'A anamnese respondida está arquivada no prontuário do paciente, com as revisões e a data de',
      'cada uma. Este resumo serve para anexar a um pedido de exame ou a um encaminhamento.',
      '',
      'Profissional responsável: {{profissional.nome}} — CRO {{profissional.cro}}',
    ].join('\n'),
  },
  {
    code: 'orcamento_plano', name: 'Orçamento do plano de tratamento', type: 'plano_tratamento', requires_professional: false,
    body: [
      'ORÇAMENTO — PLANO DE TRATAMENTO',
      '',
      'Paciente: {{paciente.nome}} — CPF {{paciente.cpf}}',
      'Data: {{data}}',
      '',
      'Itens:',
      '{{plano.itens}}',
      '',
      'VALOR TOTAL: {{plano.total}}',
      '',
      'Validade da proposta: 30 dias. Os valores podem ser alterados se houver mudança no',
      'diagnóstico durante a execução do tratamento.',
      '',
      '________________________________________',
      '{{paciente.nome}} (ciência do orçamento)',
    ].join('\n'),
  },
];

/**
 * Semeia os modelos iniciais. Cria só o que ainda não existe (pelo código): o que a clínica
 * apagou ou editou NÃO volta, e modelos novos entram nas próximas versões.
 */
export function ensureDefaultTemplates(): void {
  DEFAULT_TEMPLATES.forEach((t, i) => {
    if (documentRepository.findTemplateByCode(t.code)) return;
    documentRepository.createTemplate({
      code: t.code,
      name: t.name,
      type: t.type,
      body: t.body,
      variables_json: JSON.stringify(extractVariables(t.body)),
      requires_professional: t.requires_professional ? 1 : 0,
      active: 1,
      sort_order: i * 10,
      is_system: 1,
    });
  });
}

// ─────────────────────── Resumo e contrato para outros módulos ───────────────────────

export function patientDocumentsSummary(
  patientId: number,
): { total: number; emitidos: number; rascunhos: number; ultimo_em: string | null } {
  return documentRepository.resumo(patientId);
}

export function countDocumentsByType(from: string, to: string): { type: DocumentType; total: number; emitidos: number }[] {
  return documentRepository.countByType(from, to);
}

export function countIssuedBetween(from: string, to: string): number {
  return documentRepository.emitidosEntre(from, to);
}

export interface OdontoDocumentsService {
  list(patientId: number): DocumentOutput[];
  get(id: number): DocumentOutput | null;
  templates(): TemplateOutput[];
  summary(patientId: number): { total: number; emitidos: number; rascunhos: number; ultimo_em: string | null };
}

export const odontoDocumentsService: OdontoDocumentsService = {
  list: (patientId) => documentRepository.listByPatient(patientId).map((d) => documento(d, false)),
  get: (id) => {
    const row = documentRepository.findDocument(id);
    return row ? documento(row) : null;
  },
  templates: () => documentRepository.listTemplates({ activeOnly: true }).map(modelo),
  summary: (patientId) => patientDocumentsSummary(patientId),
};
