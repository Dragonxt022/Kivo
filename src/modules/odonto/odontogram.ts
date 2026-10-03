import type { Request } from 'express';
import { audit } from '../../core/audit/service';
import { assertAuth } from '../../shared/auth';
import { patientRepository } from './repositories/PatientRepository';
import { professionalRepository } from './repositories/ProfessionalRepository';
import {
  FDI_TEETH, SURFACES, odontogramRepository,
  type StateKind, type Surface, type ToothConditionRow, type ToothStateDetailRow,
} from './repositories/OdontogramRepository';
import { treatmentPlanRepository } from './repositories/TreatmentPlanRepository';
import { canEditClinical, canViewClinical, type Result } from './permissions';

/**
 * Odontograma (PR §9) e situações odontológicas (PR §10).
 *
 * A PR §10 é explícita: "a arquitetura não deve limitar o sistema a uma lista fixa impossível
 * de expandir". Por isso a situação é TABELA (a clínica cria a sua, com cor), e as nove
 * iniciais da PR são semeadas no boot.
 *
 * O estado do dente/superfície é HISTÓRICO APPEND-ONLY: registrar de novo não sobrescreve —
 * grava uma linha nova com data/hora e quem registrou. O estado atual é a linha mais recente
 * que não foi desfeita, e "desfazer" revela o estado anterior sem apagar o registro errado
 * (mesma filosofia do prontuário: registro clínico não desaparece).
 */

/** As nove situações iniciais da PR §10. */
export const DEFAULT_CONDITIONS: {
  code: string; name: string; color: string; applies_to: 'dente' | 'superficie' | 'ambos';
  sort_order: number; is_neutral?: boolean;
}[] = [
  // `integro` é a situação NEUTRA: registrá-la significa "nada a apontar" e o desenho não pinta.
  { code: 'integro', name: 'Íntegro', color: '#ffffff', applies_to: 'ambos', sort_order: 10, is_neutral: true },
  { code: 'carie', name: 'Cárie', color: '#ef4444', applies_to: 'ambos', sort_order: 20 },
  { code: 'restaurado', name: 'Restaurado', color: '#3b82f6', applies_to: 'ambos', sort_order: 30 },
  { code: 'endodontia', name: 'Tratamento endodôntico', color: '#a855f7', applies_to: 'dente', sort_order: 40 },
  { code: 'ausente', name: 'Ausente', color: '#6b7280', applies_to: 'dente', sort_order: 50 },
  { code: 'extracao_indicada', name: 'Extração indicada', color: '#b91c1c', applies_to: 'dente', sort_order: 60 },
  { code: 'fratura', name: 'Fratura', color: '#f97316', applies_to: 'ambos', sort_order: 70 },
  { code: 'implante', name: 'Implante', color: '#14b8a6', applies_to: 'dente', sort_order: 80 },
  { code: 'coroa', name: 'Coroa', color: '#eab308', applies_to: 'dente', sort_order: 90 },
];

/** Semeia as situações iniciais uma única vez (só quando o catálogo está vazio). */
export function ensureDefaultConditions(): void {
  if (odontogramRepository.listConditions({ activeOnly: false }).length) return;
  for (const c of DEFAULT_CONDITIONS) {
    odontogramRepository.createCondition({ ...c, active: 1, is_neutral: c.is_neutral ? 1 : 0 });
  }
}

export interface ToothConditionOutput {
  id: number;
  code: string;
  name: string;
  color: string;
  applies_to: 'dente' | 'superficie' | 'ambos';
  is_neutral: boolean;
  active: boolean;
}

function condicao(row: ToothConditionRow): ToothConditionOutput {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    color: row.color,
    applies_to: row.applies_to,
    is_neutral: Number(row.is_neutral) === 1,
    active: Number(row.active) === 1,
  };
}

export interface ToothStateOutput {
  id: number;
  tooth: string;
  surface: Surface | null;
  kind: StateKind;
  condition_id: number;
  condition_code: string;
  condition_name: string;
  condition_color: string;
  is_neutral: boolean;
  note: string | null;
  recorded_at: string;
  professional_name: string | null;
  professional_cro: string | null;
  created_by_name: string | null;
  undone_at: string | null;
  undone_by_name: string | null;
  undo_reason: string | null;
}

function estado(row: ToothStateDetailRow): ToothStateOutput {
  return {
    id: row.id,
    tooth: row.tooth,
    surface: row.surface,
    kind: row.kind,
    condition_id: row.condition_id,
    condition_code: row.condition_code,
    condition_name: row.condition_name,
    condition_color: row.condition_color,
    is_neutral: Number(row.is_neutral) === 1,
    note: row.note,
    recorded_at: row.recorded_at,
    professional_name: row.professional_name_snapshot,
    professional_cro: row.professional_cro_snapshot,
    created_by_name: row.created_by_name,
    undone_at: row.undone_at,
    undone_by_name: row.undone_by_name,
    undo_reason: row.undo_reason,
  };
}

export interface OdontogramOutput {
  conditions: ToothConditionOutput[];
  /** Histórico completo (mais recente primeiro). O estado ATUAL é `current`. */
  states: ToothStateOutput[];
  /**
   * Estado atual por dente, já calculado aqui (a regra "mais recente não desfeita" fica num
   * lugar só): `{ '26': { whole: estado|null, surfaces: {M: estado,...}, planned: [estados] } }`.
   */
  current: Record<string, {
    whole: ToothStateOutput | null;
    surfaces: Partial<Record<Surface, ToothStateOutput>>;
    planned: ToothStateOutput[];
  }>;
  /**
   * Tratamento PLANEJADO vem do plano de tratamento (fase 6), não do odontograma: o plano é a
   * fonte única do que está previsto (com valor e aprovação). O desenho marca "P" no dente.
   */
  planned: { tooth: string; description: string; plan_id: number; status: string }[];
  resumo: { dentes_com_situacao: number; planejados: number; registros: number };
}

/** Calcula o estado atual a partir do histórico: a linha mais recente não desfeita. */
export function calcularAtual(estados: ToothStateOutput[]): OdontogramOutput['current'] {
  const atual: OdontogramOutput['current'] = {};
  // `states` vem em ordem cronológica crescente; a última linha vence.
  for (const e of estados) {
    if (e.undone_at) continue;
    const dente = (atual[e.tooth] ??= { whole: null, surfaces: {}, planned: [] });
    if (e.kind === 'planejado') {
      // Planejado é lista: pode haver mais de um tratamento previsto para o mesmo dente.
      const jaTem = dente.planned.findIndex((p) => p.id === e.id);
      if (jaTem < 0) dente.planned.push(e);
      continue;
    }
    if (e.surface) dente.surfaces[e.surface] = e;
    else dente.whole = e;
  }
  return atual;
}

// ─────────────────────────────── Consultas ───────────────────────────────

export function listConditions(req: Request, opts: { activeOnly?: boolean } = {}): Result<ToothConditionOutput[]> {
  if (!canViewClinical(req)) {
    return { ok: false, error: 'Permissão negada: odonto.clinical.view', status: 403 };
  }
  return { ok: true, data: odontogramRepository.listConditions({ activeOnly: opts.activeOnly !== false }).map(condicao) };
}

export function getOdontogram(req: Request, patientId: number): Result<OdontogramOutput> {
  if (!canViewClinical(req)) {
    return { ok: false, error: 'Permissão negada: odonto.clinical.view', status: 403 };
  }
  if (!patientRepository.findById(patientId)) {
    return { ok: false, error: 'Paciente não encontrado.', status: 404 };
  }
  const estados = odontogramRepository.listPatientStates(patientId).map(estado);
  return {
    ok: true,
    data: {
      conditions: odontogramRepository.listConditions({ activeOnly: true }).map(condicao),
      // Mais recente primeiro é o que a tela de histórico espera.
      states: [...estados].reverse(),
      current: calcularAtual(estados),
      // Planejado: vem do plano de tratamento (fase 6) — uma fonte só para "o que está previsto".
      planned: treatmentPlanRepository.plannedByTooth(patientId),
      resumo: odontogramRepository.resumo(patientId),
    },
  };
}

/** Detalhe de um dente: histórico, tratamentos realizados (do prontuário) e planejados. */
export function getTooth(req: Request, patientId: number, tooth: string): Result<{
  tooth: string;
  history: ToothStateOutput[];
  planned: ToothStateOutput[];
  procedures: { id: number; happened_at: string; name: string; note: string | null }[];
}> {
  if (!canViewClinical(req)) {
    return { ok: false, error: 'Permissão negada: odonto.clinical.view', status: 403 };
  }
  if (!(FDI_TEETH as readonly string[]).includes(tooth)) {
    return { ok: false, error: `Dente inválido: use a numeração FDI (${FDI_TEETH.join(', ')}).`, status: 400 };
  }
  if (!patientRepository.findById(patientId)) {
    return { ok: false, error: 'Paciente não encontrado.', status: 404 };
  }
  const historico = odontogramRepository.listToothHistory(patientId, tooth).map(estado);
  return {
    ok: true,
    data: {
      tooth,
      history: historico,
      planned: historico.filter((h) => h.kind === 'planejado' && !h.undone_at),
      procedures: odontogramRepository.proceduresForTooth(patientId, tooth),
    },
  };
}

// ─────────────────────────────── Registro ───────────────────────────────

export interface ToothStateInput {
  tooth?: string;
  surface?: string | null;
  kind?: string;
  condition_id?: number;
  note?: string | null;
  recorded_at?: string | null;
  professional_id?: number | null;
}

const DATA_HORA = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/;

function nowStamp(): string {
  return new Date().toISOString().slice(0, 16).replace('T', ' ');
}

export function setToothState(req: Request, patientId: number, input: ToothStateInput): Result<ToothStateOutput> {
  assertAuth(req);
  if (!canEditClinical(req)) {
    return { ok: false, error: 'Permissão negada: odonto.clinical.edit', status: 403 };
  }
  if (!patientRepository.findById(patientId)) {
    return { ok: false, error: 'Paciente não encontrado.', status: 404 };
  }

  const tooth = String(input.tooth ?? '').trim();
  if (!(FDI_TEETH as readonly string[]).includes(tooth)) {
    return { ok: false, error: `Dente inválido: use a numeração FDI (${FDI_TEETH.join(', ')}).`, status: 400 };
  }

  const condicaoRow = input.condition_id ? odontogramRepository.findCondition(Number(input.condition_id)) : undefined;
  if (!condicaoRow) return { ok: false, error: 'Situação odontológica não encontrada.', status: 400 };
  if (Number(condicaoRow.active) !== 1) return { ok: false, error: 'Esta situação está desativada.', status: 400 };

  const surfaceRaw = input.surface === undefined || input.surface === null || input.surface === ''
    ? null : String(input.surface).toUpperCase();
  if (surfaceRaw && !(SURFACES as readonly string[]).includes(surfaceRaw)) {
    return { ok: false, error: `Superfície inválida: use ${SURFACES.join(', ')}.`, status: 400 };
  }
  // A situação diz para que serve: registrar "ausente" numa superfície não faz sentido.
  if (surfaceRaw && condicaoRow.applies_to === 'dente') {
    return { ok: false, error: `A situação "${condicaoRow.name}" vale para o dente inteiro, não para uma superfície.`, status: 400 };
  }
  if (!surfaceRaw && condicaoRow.applies_to === 'superficie') {
    return { ok: false, error: `A situação "${condicaoRow.name}" vale para uma superfície — escolha qual.`, status: 400 };
  }

  const kind: StateKind = input.kind === 'planejado' ? 'planejado' : 'situacao';
  const recordedAt = input.recorded_at ? String(input.recorded_at).slice(0, 16).trim() : nowStamp();
  if (!DATA_HORA.test(recordedAt)) {
    return { ok: false, error: 'Informe data e hora no formato AAAA-MM-DD HH:MM.', status: 400 };
  }

  const profissionalId = input.professional_id ? Number(input.professional_id) : null;
  let nomeSnapshot: string | null = null;
  let croSnapshot: string | null = null;
  if (profissionalId) {
    const p = professionalRepository.findById(profissionalId);
    if (!p) return { ok: false, error: 'Profissional não encontrado.', status: 400 };
    nomeSnapshot = p.name;
    croSnapshot = p.cro ? `${p.cro}${p.cro_state ? '/' + p.cro_state : ''}` : null;
  }

  let id = 0;
  odontogramRepository.transaction(() => {
    id = odontogramRepository.createState({
      patient_id: patientId,
      tooth,
      surface: surfaceRaw,
      kind,
      condition_id: condicaoRow.id,
      note: String(input.note ?? '').trim().slice(0, 500) || null,
      recorded_at: recordedAt,
      professional_id: profissionalId,
      professional_name_snapshot: nomeSnapshot,
      professional_cro_snapshot: croSnapshot,
      created_by: req.user?.id ?? null,
    });
  });

  const row = odontogramRepository.findState(id)!;
  // Auditoria sem o texto clínico: dente, superfície, tipo e a situação aplicada.
  audit(req, 'criar', 'odonto_tooth_state', id, null, {
    patient_id: patientId,
    tooth,
    surface: surfaceRaw,
    kind,
    situacao: condicaoRow.code,
    recorded_at: recordedAt,
  });
  return { ok: true, data: estado(row) };
}

/** Desfaz um registro errado sem apagar: marca quem desfez, quando e por quê. */
export function undoToothState(req: Request, stateId: number, reason: unknown): Result<ToothStateOutput> {
  assertAuth(req);
  if (!canEditClinical(req)) {
    return { ok: false, error: 'Permissão negada: odonto.clinical.edit', status: 403 };
  }
  const atual = odontogramRepository.findState(stateId);
  if (!atual) return { ok: false, error: 'Registro do odontograma não encontrado.', status: 404 };
  if (atual.undone_at) return { ok: false, error: 'Este registro já foi desfeito.', status: 400 };

  const razao = String(reason ?? '').trim().slice(0, 200) || null;
  odontogramRepository.undoState(stateId, req.user?.id ?? null, razao);
  const row = odontogramRepository.findState(stateId)!;
  audit(req, 'editar', 'odonto_tooth_state', stateId, { desfeito: false }, {
    desfeito: true, motivo: razao, tooth: row.tooth, surface: row.surface,
  });
  return { ok: true, data: estado(row) };
}

// ─────────────────────── Catálogo de situações (PR §10) ───────────────────────

export interface ConditionInput {
  code?: string;
  name?: string;
  color?: string;
  applies_to?: string;
  sort_order?: number;
  active?: boolean | number;
}

export function createCondition(req: Request, input: ConditionInput): Result<ToothConditionOutput> {
  assertAuth(req);
  if (!canEditClinical(req)) {
    return { ok: false, error: 'Permissão negada: odonto.clinical.edit', status: 403 };
  }
  const code = String(input.code ?? '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '_');
  if (!/^[a-z][a-z0-9_]{1,30}$/.test(code)) {
    return { ok: false, error: 'Código inválido: use letras minúsculas, números e _ (ex.: selante).', status: 400 };
  }
  if (odontogramRepository.findConditionByCode(code)) {
    return { ok: false, error: `Já existe uma situação com o código "${code}".`, status: 409 };
  }
  const name = String(input.name ?? '').trim();
  if (!name || name.length > 60) {
    return { ok: false, error: 'Informe o nome da situação (até 60 caracteres).', status: 400 };
  }
  const color = /^#[0-9a-fA-F]{6}$/.test(String(input.color ?? '')) ? String(input.color) : '#9ca3af';
  const appliesTo = ['dente', 'superficie', 'ambos'].includes(String(input.applies_to)) ? String(input.applies_to) : 'ambos';

  let id = 0;
  odontogramRepository.transaction(() => {
    id = odontogramRepository.createCondition({
      code,
      name,
      color,
      applies_to: appliesTo,
      sort_order: Number(input.sort_order ?? 100),
      active: input.active === false || input.active === 0 ? 0 : 1,
    });
  });
  audit(req, 'criar', 'odonto_tooth_condition', id, null, { code, name, applies_to: appliesTo });
  return { ok: true, data: condicao(odontogramRepository.findCondition(id)!) };
}

export function updateCondition(req: Request, id: number, input: ConditionInput): Result<ToothConditionOutput> {
  assertAuth(req);
  if (!canEditClinical(req)) {
    return { ok: false, error: 'Permissão negada: odonto.clinical.edit', status: 403 };
  }
  const atual = odontogramRepository.findCondition(id);
  if (!atual) return { ok: false, error: 'Situação não encontrada.', status: 404 };

  const patch: Record<string, unknown> = {};
  if (input.name !== undefined) {
    const nome = String(input.name).trim();
    if (!nome || nome.length > 60) return { ok: false, error: 'Informe o nome da situação (até 60 caracteres).', status: 400 };
    patch.name = nome;
  }
  if (input.color !== undefined) {
    patch.color = /^#[0-9a-fA-F]{6}$/.test(String(input.color)) ? String(input.color) : atual.color;
  }
  if (input.applies_to !== undefined && ['dente', 'superficie', 'ambos'].includes(String(input.applies_to))) {
    patch.applies_to = String(input.applies_to);
  }
  if (input.sort_order !== undefined) patch.sort_order = Number(input.sort_order);
  if (input.active !== undefined) patch.active = input.active === false || input.active === 0 ? 0 : 1;

  odontogramRepository.updateCondition(id, patch);
  audit(req, 'editar', 'odonto_tooth_condition', id, { name: atual.name, active: atual.active }, patch);
  return { ok: true, data: condicao(odontogramRepository.findCondition(id)!) };
}

/**
 * Situação em uso não é apagada: desativa (o histórico do odontograma aponta para ela).
 * Sem uso, sai por soft delete.
 *
 * A resposta NÃO usa a chave `ok` dentro do dado: o envelope do Core trata `{ ok: true, X }`
 * como Result e devolveria só `X` (ver `shared/responseEnvelope.ts`).
 */
export function removeCondition(req: Request, id: number): Result<{ desativada: boolean }> {
  assertAuth(req);
  if (!canEditClinical(req)) {
    return { ok: false, error: 'Permissão negada: odonto.clinical.edit', status: 403 };
  }
  const atual = odontogramRepository.findCondition(id);
  if (!atual) return { ok: false, error: 'Situação não encontrada.', status: 404 };

  const uso = odontogramRepository.conditionUsage(id);
  if (uso > 0) {
    odontogramRepository.updateCondition(id, { active: 0 });
    audit(req, 'editar', 'odonto_tooth_condition', id, { active: atual.active }, { active: 0, usos: uso });
    return { ok: true, data: { desativada: true } };
  }
  odontogramRepository.softDeleteCondition(id);
  audit(req, 'excluir', 'odonto_tooth_condition', id, { code: atual.code }, null);
  return { ok: true, data: { desativada: false } };
}

/** Excluir o paciente leva o odontograma junto (o chamador já garante a transação). */
export function removeOdontogramByPatient(patientId: number): void {
  odontogramRepository.softDeleteByPatient(patientId);
}

/**
 * Contrato exposto a outros módulos: o plano de tratamento (fase 6) vai ler o odontograma
 * para sugerir os dentes com pendência.
 */
export interface OdontoOdontogramService {
  current(patientId: number): OdontogramOutput['current'];
  conditions(): ToothConditionOutput[];
  summary(patientId: number): { dentes_com_situacao: number; planejados: number; registros: number };
}

export const odontoOdontogramService: OdontoOdontogramService = {
  current: (patientId) => calcularAtual(odontogramRepository.listPatientStates(patientId).map(estado)),
  conditions: () => odontogramRepository.listConditions({ activeOnly: true }).map(condicao),
  summary: (patientId) => odontogramRepository.resumo(patientId),
};
