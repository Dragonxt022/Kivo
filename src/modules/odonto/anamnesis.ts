import type { Request } from 'express';
import { audit } from '../../core/audit/service';
import { assertAuth } from '../../shared/auth';
import { patientRepository } from './repositories/PatientRepository';
import {
  anamnesisRepository,
  type AnamnesisField,
  type AnamnesisFieldType,
  type AnamnesisFormDetail,
  type AnamnesisTemplateRow,
} from './repositories/AnamnesisRepository';
import { canEditClinical, canViewClinical, type Result } from './permissions';

/**
 * Anamnese odontológica (PR §5).
 *
 * A PR pede um formulário flexível, com respostas vinculadas ao paciente (data, hora e
 * responsável) e **histórico preservado**: atualizar o formulário não pode apagar o que já
 * foi respondido. Por isso tudo aqui é versionado dos dois lados:
 *
 *  - mudar as perguntas cria uma VERSÃO NOVA do formulário (a antiga fica, e quem respondeu
 *    nela continua apontando para ela);
 *  - salvar as respostas cria uma REVISÃO NOVA (nunca sobrescreve — a revisão anterior é o
 *    histórico clínico e não se reescreve: PR §24.3).
 *
 * Dado sensível: ler exige `odonto.clinical.view`, gravar exige `odonto.clinical.edit`, e a
 * auditoria registra QUEM respondeu e QUANTOS campos — nunca o conteúdo das respostas.
 */

const TIPOS: AnamnesisFieldType[] = ['texto', 'texto_longo', 'sim_nao', 'selecao', 'multipla', 'data', 'numero'];
const SIM_NAO = ['sim', 'nao', 'nao_sei'];
const MAX_CAMPOS = 100;
const MAX_TEXTO = 200;
const MAX_TEXTO_LONGO = 4000;
const MAX_OPCOES = 30;

/** Formulário padrão do consultório: o que a PR §5 lista como exemplo, mais a triagem usual. */
export const DEFAULT_TEMPLATE_NAME = 'Anamnese odontológica';

export const DEFAULT_TEMPLATE_FIELDS: AnamnesisField[] = [
  { key: 'queixa_principal', label: 'Queixa principal', type: 'texto_longo', required: true, help: 'O que trouxe o paciente hoje, nas palavras dele.' },
  { key: 'historico_medico', label: 'Histórico médico', type: 'texto_longo', help: 'Doenças, cirurgias, internações.' },
  { key: 'doencas', label: 'Doenças em tratamento', type: 'texto', help: 'Ex.: diabetes, hipertensão, cardiopatia.' },
  { key: 'alergias', label: 'Alergias', type: 'texto', help: 'Medicamentos, látex, anestésicos.' },
  { key: 'medicamentos', label: 'Medicamentos em uso', type: 'texto' },
  { key: 'habitos', label: 'Hábitos', type: 'multipla', options: ['Fumo', 'Álcool', 'Bruxismo', 'Roer unha', 'Mascar chiclete', 'Nenhum'] },
  { key: 'historico_odontologico', label: 'Histórico odontológico', type: 'texto_longo', help: 'Tratamentos anteriores, próteses, ortodontia.' },
  { key: 'gestante', label: 'Gestante', type: 'selecao', options: ['Sim', 'Não', 'Não se aplica'] },
  { key: 'pressao_alta', label: 'Pressão alta', type: 'sim_nao' },
  { key: 'diabetes', label: 'Diabetes', type: 'sim_nao' },
  { key: 'cardiopatia', label: 'Problema cardíaco', type: 'sim_nao' },
  { key: 'anticoagulante', label: 'Usa anticoagulante', type: 'sim_nao' },
  { key: 'cirurgia_recente', label: 'Cirurgia recente', type: 'sim_nao' },
  { key: 'ultima_consulta', label: 'Última consulta odontológica', type: 'data' },
  { key: 'observacoes', label: 'Observações', type: 'texto_longo', help: 'Qualquer informação que ajude no atendimento.' },
];

// ─────────────────────────────── Validação ───────────────────────────────

function textoOuNull(v: unknown, max: number): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
}

/** Valida a definição dos campos (é o que o admin escreve na tela de formulários). */
export function validateFields(raw: unknown): Result<AnamnesisField[]> {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { ok: false, error: 'O formulário precisa de pelo menos uma pergunta.', status: 400 };
  }
  if (raw.length > MAX_CAMPOS) {
    return { ok: false, error: `Limite de ${MAX_CAMPOS} perguntas por formulário.`, status: 400 };
  }
  const vistos = new Set<string>();
  const campos: AnamnesisField[] = [];
  for (const item of raw as Record<string, unknown>[]) {
    const key = String(item?.key ?? '').trim().toLowerCase();
    if (!/^[a-z][a-z0-9_]{1,40}$/.test(key)) {
      return { ok: false, error: `Chave inválida: "${key}". Use letras minúsculas, números e _ (ex.: historico_medico).`, status: 400 };
    }
    if (vistos.has(key)) return { ok: false, error: `Pergunta repetida: ${key}.`, status: 400 };
    vistos.add(key);
    const label = String(item?.label ?? '').trim();
    if (!label || label.length > 120) {
      return { ok: false, error: `A pergunta "${key}" precisa de um rótulo de até 120 caracteres.`, status: 400 };
    }
    const tipo = String(item?.type ?? 'texto') as AnamnesisFieldType;
    if (!TIPOS.includes(tipo)) {
      return { ok: false, error: `Tipo inválido em "${label}": use ${TIPOS.join(', ')}.`, status: 400 };
    }
    let options: string[] | undefined;
    if (tipo === 'selecao' || tipo === 'multipla') {
      const lista = Array.isArray(item?.options)
        ? (item.options as unknown[]).map((o) => String(o).trim()).filter(Boolean)
        : [];
      if (!lista.length) return { ok: false, error: `A pergunta "${label}" precisa de pelo menos uma opção.`, status: 400 };
      if (lista.length > MAX_OPCOES) return { ok: false, error: `Limite de ${MAX_OPCOES} opções em "${label}".`, status: 400 };
      options = lista.map((o) => o.slice(0, 60));
    }
    campos.push({
      key,
      label,
      type: tipo,
      required: item?.required === true || item?.required === 1,
      ...(options ? { options } : {}),
      ...(textoOuNull(item?.help, 200) ? { help: textoOuNull(item?.help, 200)! } : {}),
    });
  }
  return { ok: true, data: campos };
}

function parseFields(template: AnamnesisTemplateRow): AnamnesisField[] {
  try {
    const parsed = JSON.parse(template.fields_json);
    return Array.isArray(parsed) ? (parsed as AnamnesisField[]) : [];
  } catch {
    return [];
  }
}

/** Lê as respostas gravadas de volta para objeto (a tela trabalha com objeto, não com JSON). */
function parseAnswers(json: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Valida as respostas contra o formulário: chave desconhecida é erro (não guardamos lixo),
 * pergunta obrigatória vazia é erro, e cada tipo é conferido como o formulário pede.
 * Resposta vazia de pergunta opcional simplesmente não é gravada.
 */
export function validateAnswers(
  fields: AnamnesisField[],
  raw: unknown,
): Result<Record<string, unknown>> {
  if (raw === null || raw === undefined) return { ok: false, error: 'Informe as respostas da anamnese.', status: 400 };
  if (typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'Respostas em formato inválido.', status: 400 };

  const respostas = raw as Record<string, unknown>;
  const porChave = new Map(fields.map((f) => [f.key, f]));
  const desconhecidas = Object.keys(respostas).filter((k) => !porChave.has(k));
  if (desconhecidas.length) {
    return { ok: false, error: `Pergunta não existe neste formulário: ${desconhecidas.join(', ')}.`, status: 400 };
  }

  const saida: Record<string, unknown> = {};
  for (const campo of fields) {
    const valor = respostas[campo.key];
    const vazio = valor === null || valor === undefined || valor === '' || (Array.isArray(valor) && valor.length === 0);
    if (vazio) {
      if (campo.required) return { ok: false, error: `Responda: ${campo.label}.`, status: 400 };
      continue;
    }
    switch (campo.type) {
      case 'texto':
      case 'texto_longo': {
        const max = campo.type === 'texto' ? MAX_TEXTO : MAX_TEXTO_LONGO;
        const s = String(valor).trim();
        if (s.length > max) return { ok: false, error: `"${campo.label}" passa de ${max} caracteres.`, status: 400 };
        saida[campo.key] = s;
        break;
      }
      case 'sim_nao': {
        const s = String(valor).trim().toLowerCase();
        if (!SIM_NAO.includes(s)) return { ok: false, error: `"${campo.label}": responda sim, não ou não sei.`, status: 400 };
        saida[campo.key] = s;
        break;
      }
      case 'selecao': {
        const s = String(valor).trim();
        if (!(campo.options ?? []).includes(s)) {
          return { ok: false, error: `"${campo.label}": escolha uma das opções (${(campo.options ?? []).join(', ')}).`, status: 400 };
        }
        saida[campo.key] = s;
        break;
      }
      case 'multipla': {
        const lista = (Array.isArray(valor) ? valor : [valor]).map((v) => String(v).trim()).filter(Boolean);
        const invalidas = lista.filter((v) => !(campo.options ?? []).includes(v));
        if (invalidas.length) {
          return { ok: false, error: `"${campo.label}": opção inválida (${invalidas.join(', ')}).`, status: 400 };
        }
        saida[campo.key] = [...new Set(lista)];
        break;
      }
      case 'data': {
        const s = String(valor).trim().slice(0, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(new Date(`${s}T00:00:00Z`).getTime())) {
          return { ok: false, error: `"${campo.label}": informe uma data válida.`, status: 400 };
        }
        saida[campo.key] = s;
        break;
      }
      case 'numero': {
        const n = Number(valor);
        if (!Number.isFinite(n)) return { ok: false, error: `"${campo.label}": informe um número.`, status: 400 };
        saida[campo.key] = n;
        break;
      }
    }
  }
  return { ok: true, data: saida };
}

// ─────────────────────────────── Formulários ───────────────────────────────

export interface AnamnesisTemplateOutput {
  id: number;
  name: string;
  version: number;
  fields: AnamnesisField[];
  notes: string | null;
  is_default: boolean;
  active: boolean;
  created_at: string;
}

function templateOutput(row: AnamnesisTemplateRow): AnamnesisTemplateOutput {
  return {
    id: row.id,
    name: row.name,
    version: row.version,
    fields: parseFields(row),
    notes: row.notes,
    is_default: Number(row.is_default) === 1,
    active: Number(row.active) === 1,
    created_at: row.created_at,
  };
}

/**
 * Garante o formulário padrão no boot. Roda uma vez: se já existe QUALQUER formulário, não
 * mexe em nada (o consultório pode ter apagado o padrão de propósito).
 */
export function ensureDefaultTemplate(): void {
  const existentes = anamnesisRepository.listLatestTemplates(false);
  if (existentes.length) return;
  anamnesisRepository.createTemplate({
    name: DEFAULT_TEMPLATE_NAME,
    version: 1,
    fields_json: JSON.stringify(DEFAULT_TEMPLATE_FIELDS),
    notes: 'Formulário criado automaticamente na instalação do módulo. Edite à vontade: cada alteração vira uma versão nova e não apaga respostas já dadas.',
    active: 1,
    is_default: 1,
  });
}

export function listTemplates(req: Request, opts: { activeOnly?: boolean } = {}): Result<AnamnesisTemplateOutput[]> {
  if (!canViewClinical(req)) {
    return { ok: false, error: 'Permissão negada: odonto.clinical.view', status: 403 };
  }
  return { ok: true, data: anamnesisRepository.listLatestTemplates(opts.activeOnly !== false).map(templateOutput) };
}

export function getTemplate(req: Request, id: number): Result<AnamnesisTemplateOutput> {
  if (!canViewClinical(req)) {
    return { ok: false, error: 'Permissão negada: odonto.clinical.view', status: 403 };
  }
  const row = anamnesisRepository.findTemplate(id);
  if (!row) return { ok: false, error: 'Formulário não encontrado.', status: 404 };
  return { ok: true, data: templateOutput(row) };
}

export interface TemplateInput {
  name?: string;
  fields?: unknown;
  notes?: string | null;
  is_default?: boolean;
}

/**
 * Publica uma VERSÃO NOVA do formulário. A versão anterior continua na tabela: as respostas
 * que já existem apontam para a versão em que foram dadas (PR §5).
 */
export function createTemplateVersion(req: Request, input: TemplateInput): Result<AnamnesisTemplateOutput> {
  assertAuth(req);
  if (!canEditClinical(req)) {
    return { ok: false, error: 'Permissão negada: odonto.clinical.edit', status: 403 };
  }
  const name = String(input.name ?? '').trim() || DEFAULT_TEMPLATE_NAME;
  if (name.length > 120) return { ok: false, error: 'Nome do formulário muito longo.', status: 400 };

  const campos = validateFields(input.fields);
  if (!campos.ok) return campos;

  const versao = anamnesisRepository.maxVersion(name) + 1;
  const primeiro = anamnesisRepository.listLatestTemplates(false).length === 0;
  const padrao = input.is_default || primeiro ? 1 : 0;

  let id = 0;
  anamnesisRepository.transaction(() => {
    if (padrao) anamnesisRepository.clearDefaultTemplates();
    id = anamnesisRepository.createTemplate({
      name,
      version: versao,
      fields_json: JSON.stringify(campos.data),
      notes: textoOuNull(input.notes, 1000),
      active: 1,
      is_default: padrao,
    });
  });

  audit(req, 'criar', 'odonto_anamnesis_template', id, null, {
    name, version: versao, campos: campos.data.length, padrao: padrao === 1,
  });
  const row = anamnesisRepository.findTemplate(id)!;
  return { ok: true, data: templateOutput(row) };
}

// ─────────────────────────────── Respostas ───────────────────────────────

export interface AnamnesisFormOutput {
  id: number;
  patient_id: number;
  template_id: number;
  template_name: string;
  template_version: number;
  revision: number;
  answers: Record<string, unknown>;
  filled_by: number | null;
  filled_by_name: string | null;
  professional_id: number | null;
  professional_name: string | null;
  filled_at: string;
  notes: string | null;
}

function formOutput(row: AnamnesisFormDetail): AnamnesisFormOutput {
  return {
    id: row.id,
    patient_id: row.patient_id,
    template_id: row.template_id,
    template_name: row.template_name,
    template_version: row.template_version,
    revision: row.revision,
    answers: parseAnswers(row.answers_json),
    filled_by: row.filled_by,
    filled_by_name: row.filled_by_name,
    professional_id: row.professional_id,
    professional_name: row.professional_name,
    filled_at: row.filled_at,
    notes: row.notes,
  };
}

export interface PatientAnamnesis {
  summary: { revisions: number; last_filled_at: string | null; last_revision: number | null; last_template_name: string | null };
  current: AnamnesisFormOutput | null;
  /** Revisões anteriores, da mais nova para a mais antiga (inclui a atual). */
  history: AnamnesisFormOutput[];
  /** Formulário sugerido para uma nova revisão (o padrão do consultório). */
  template: AnamnesisTemplateOutput | null;
  /** Todas as versões ativas, para escolher outro formulário. */
  templates: AnamnesisTemplateOutput[];
  has_anamnesis: boolean;
}

export function getPatientAnamnesis(req: Request, patientId: number): Result<PatientAnamnesis> {
  if (!canViewClinical(req)) {
    return { ok: false, error: 'Permissão negada: odonto.clinical.view', status: 403 };
  }
  if (!patientRepository.findById(patientId)) {
    return { ok: false, error: 'Paciente não encontrado.', status: 404 };
  }
  const history = anamnesisRepository.listForms(patientId).map(formOutput);
  const padrao = anamnesisRepository.defaultTemplate();
  const templates = anamnesisRepository.listLatestTemplates(true).map(templateOutput);
  return {
    ok: true,
    data: {
      summary: anamnesisRepository.summary(patientId),
      current: history[0] ?? null,
      history,
      template: padrao ? templateOutput(padrao) : (templates[0] ?? null),
      templates,
      has_anamnesis: history.length > 0,
    },
  };
}

export function getForm(req: Request, id: number): Result<AnamnesisFormOutput> {
  if (!canViewClinical(req)) {
    return { ok: false, error: 'Permissão negada: odonto.clinical.view', status: 403 };
  }
  const row = anamnesisRepository.findForm(id);
  if (!row) return { ok: false, error: 'Anamnese não encontrada.', status: 404 };
  return { ok: true, data: formOutput(row) };
}

export interface SaveAnamnesisInput {
  template_id?: number | null;
  answers?: unknown;
  professional_id?: number | null;
  notes?: string | null;
}

/**
 * Grava uma REVISÃO NOVA da anamnese do paciente. Nunca sobrescreve: a revisão anterior é o
 * histórico clínico (PR §5 e §24.3).
 */
export function savePatientAnamnesis(
  req: Request,
  patientId: number,
  input: SaveAnamnesisInput,
): Result<AnamnesisFormOutput> {
  assertAuth(req);
  if (!canEditClinical(req)) {
    return { ok: false, error: 'Permissão negada: odonto.clinical.edit', status: 403 };
  }
  if (!patientRepository.findById(patientId)) {
    return { ok: false, error: 'Paciente não encontrado.', status: 404 };
  }

  const template = input.template_id
    ? anamnesisRepository.findTemplate(Number(input.template_id))
    : anamnesisRepository.defaultTemplate();
  if (!template) return { ok: false, error: 'Formulário de anamnese não encontrado.', status: 404 };
  if (Number(template.active) !== 1) return { ok: false, error: 'Este formulário está inativo.', status: 400 };

  const fields = parseFields(template);
  if (!fields.length) {
    return { ok: false, error: 'O formulário não tem perguntas válidas.', status: 400 };
  }

  const respostas = validateAnswers(fields, input.answers);
  if (!respostas.ok) return respostas;

  const professionalId = input.professional_id ? Number(input.professional_id) : null;

  let id = 0;
  let revision = 0;
  anamnesisRepository.transaction(() => {
    revision = anamnesisRepository.maxRevision(patientId) + 1;
    id = anamnesisRepository.createForm({
      patient_id: patientId,
      template_id: template.id,
      template_version: template.version,
      revision,
      answers_json: JSON.stringify(respostas.data),
      professional_id: professionalId,
      filled_by: req.user?.id ?? null,
      notes: textoOuNull(input.notes, 1000),
    });
  });

  // Auditoria sem conteúdo clínico: quem respondeu, qual formulário/versão/revisão e quantas
  // perguntas foram respondidas (o "o quê" é dado de saúde e fica só na tabela clínica).
  audit(req, 'criar', 'odonto_anamnesis', id, null, {
    patient_id: patientId,
    template_id: template.id,
    template_version: template.version,
    revision,
    perguntas_respondidas: Object.keys(respostas.data).length,
    professional_id: professionalId,
  });

  const row = anamnesisRepository.findForm(id)!;
  return { ok: true, data: formOutput(row) };
}

/** Resumo para a ficha do paciente (sem conteúdo clínico). */
export function patientAnamnesisSummary(patientId: number): {
  revisions: number;
  last_filled_at: string | null;
  last_revision: number | null;
  last_template_name: string | null;
} {
  return anamnesisRepository.summary(patientId);
}

/** Excluir o paciente leva junto a anamnese (o chamador já garante a transação). */
export function removeAnamnesisByPatient(patientId: number): void {
  anamnesisRepository.softDeleteByPatient(patientId);
}

/**
 * Contrato exposto a outros módulos. O prontuário (Fase 4) e o plano de tratamento vão
 * consultar a anamnese por aqui, sem importar o repositório nem o serviço deste arquivo.
 */
export interface OdontoAnamnesisService {
  summary(patientId: number): {
    revisions: number;
    last_filled_at: string | null;
    last_revision: number | null;
    last_template_name: string | null;
  };
  listForms(patientId: number): AnamnesisFormOutput[];
  defaultTemplate(): AnamnesisTemplateOutput | null;
}

export const odontoAnamnesisService: OdontoAnamnesisService = {
  summary: (patientId) => patientAnamnesisSummary(patientId),
  listForms: (patientId) => anamnesisRepository.listForms(patientId).map(formOutput),
  defaultTemplate: () => {
    const row = anamnesisRepository.defaultTemplate();
    return row ? templateOutput(row) : null;
  },
};
