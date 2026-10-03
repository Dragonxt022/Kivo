import type { Request } from 'express';
import { audit } from '../../core/audit/service';
import { assertAuth } from '../../shared/auth';
import { getService, hasService } from '../../core/services/registry';
import { patientRepository } from './repositories/PatientRepository';
import { professionalRepository } from './repositories/ProfessionalRepository';
import { procedureRepository } from './repositories/ProcedureRepository';
import {
  ITEM_STATUSES, PLAN_STATUSES, treatmentPlanRepository,
  type ItemStatus, type PlanStatus, type TreatmentItemDetailRow, type TreatmentPlanDetailRow,
} from './repositories/TreatmentPlanRepository';
import { FDI_TEETH } from './repositories/OdontogramRepository';
import type { Result } from './permissions';

/**
 * Plano de tratamento (PR §11) e a ponte para o financeiro (PR §12).
 *
 * A PR §12 proíbe financeiro paralelo: "não criar um segundo financeiro específico para
 * odontologia". Então este serviço NÃO grava dinheiro — quando o plano aprovado é cobrado, ele
 * chama `finance.receivables.create` (o serviço publicado pelo módulo financeiro, com
 * parcelamento) e guarda aqui apenas `charged_at` e o parcelamento escolhido, para a mesma
 * cobrança não ser gerada duas vezes.
 *
 * Se o módulo Financeiro não estiver ligado, a parte clínica do plano funciona normalmente e só
 * a cobrança é recusada, com a explicação — em vez de gravar dinheiro num lugar que ninguém lê.
 */

export interface PlanItemInput {
  id?: number;
  procedure_id?: number | null;
  tooth?: string | null;
  description?: string;
  amount_cents?: number;
  quantity?: number;
  professional_id?: number | null;
  status?: ItemStatus;
  sort_order?: number;
  notes?: string | null;
}

export interface PlanInput {
  title?: string | null;
  notes?: string | null;
  professional_id?: number | null;
  status?: PlanStatus;
  items?: PlanItemInput[];
}

// ─────────────────────────────── Saída ───────────────────────────────

export interface PlanItemOutput {
  id: number;
  procedure_id: number | null;
  procedure_name: string | null;
  tooth: string | null;
  description: string;
  amount_cents: number;
  quantity: number;
  total_cents: number;
  professional_id: number | null;
  professional_name: string | null;
  status: ItemStatus;
  notes: string | null;
}

export interface PlanOutput {
  id: number;
  patient_id: number;
  patient_name: string;
  professional_id: number | null;
  professional_name: string | null;
  professional_cro: string | null;
  title: string | null;
  status: PlanStatus;
  notes: string | null;
  total_cents: number;
  items_count: number;
  items?: PlanItemOutput[];
  presented_at: string | null;
  approved_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  cancelled_at: string | null;
  cancel_reason: string | null;
  charged_at: string | null;
  installments: number | null;
  first_due_date: string | null;
  created_by_name: string | null;
  created_at: string;
}

function item(row: TreatmentItemDetailRow): PlanItemOutput {
  return {
    id: row.id,
    procedure_id: row.procedure_id,
    procedure_name: row.procedure_name,
    tooth: row.tooth,
    description: row.description,
    amount_cents: row.amount_cents,
    quantity: row.quantity,
    total_cents: row.amount_cents * row.quantity,
    professional_id: row.professional_id,
    professional_name: row.professional_name,
    status: row.status,
    notes: row.notes,
  };
}

function plano(row: TreatmentPlanDetailRow, comItens = false): PlanOutput {
  const saida: PlanOutput = {
    id: row.id,
    patient_id: row.patient_id,
    patient_name: row.patient_name,
    professional_id: row.professional_id,
    professional_name: row.professional_name_snapshot,
    professional_cro: row.professional_cro_snapshot,
    title: row.title,
    status: row.status,
    notes: row.notes,
    total_cents: Number(row.total_cents ?? 0),
    items_count: Number(row.items_count ?? 0),
    presented_at: row.presented_at,
    approved_at: row.approved_at,
    started_at: row.started_at,
    finished_at: row.finished_at,
    cancelled_at: row.cancelled_at,
    cancel_reason: row.cancel_reason,
    charged_at: row.charged_at,
    installments: row.installments,
    first_due_date: row.first_due_date,
    created_by_name: row.created_by_name,
    created_at: row.created_at,
  };
  if (comItens) saida.items = treatmentPlanRepository.listItems(row.id).map(item);
  return saida;
}

// ─────────────────────────── Transições de situação ───────────────────────────

const TRANSICOES_PLANO: Record<PlanStatus, PlanStatus[]> = {
  planejado: ['apresentado', 'aprovado', 'cancelado'],
  apresentado: ['aprovado', 'cancelado'],
  aprovado: ['em_andamento', 'cancelado'],
  em_andamento: ['concluido', 'cancelado'],
  concluido: [],
  cancelado: ['planejado'],
};

const TRANSICOES_ITEM: Record<ItemStatus, ItemStatus[]> = {
  planejado: ['aprovado', 'em_andamento', 'cancelado'],
  aprovado: ['em_andamento', 'cancelado'],
  em_andamento: ['concluido', 'cancelado'],
  concluido: [],
  cancelado: ['planejado'],
};

const CARIMBO: Partial<Record<PlanStatus, string>> = {
  apresentado: 'presented_at',
  aprovado: 'approved_at',
  em_andamento: 'started_at',
  concluido: 'finished_at',
  cancelado: 'cancelled_at',
};

function agora(): string {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

// ─────────────────────────────── Validação ───────────────────────────────

function validaItem(input: PlanItemInput): Result<Record<string, unknown>> {
  const descricao = String(input.description ?? '').trim();
  if (!descricao || descricao.length > 200) {
    return { ok: false, error: 'Cada item do plano precisa de uma descrição (até 200 caracteres).', status: 400 };
  }
  const valor = Number(input.amount_cents ?? 0);
  if (!Number.isInteger(valor) || valor < 0) {
    return { ok: false, error: 'O valor do item deve ser em centavos (número inteiro).', status: 400 };
  }
  const qtd = Number(input.quantity ?? 1);
  if (!Number.isInteger(qtd) || qtd < 1 || qtd > 999) {
    return { ok: false, error: 'A quantidade do item deve estar entre 1 e 999.', status: 400 };
  }
  const tooth = input.tooth ? String(input.tooth).trim() : null;
  if (tooth && !(FDI_TEETH as readonly string[]).includes(tooth)) {
    return { ok: false, error: `Dente inválido no item "${descricao}": use a numeração FDI.`, status: 400 };
  }
  if (input.procedure_id) {
    const proc = procedureRepository.findById(Number(input.procedure_id));
    if (!proc) return { ok: false, error: `Procedimento ${input.procedure_id} não existe no catálogo.`, status: 400 };
  }
  if (input.professional_id) {
    if (!professionalRepository.findById(Number(input.professional_id))) {
      return { ok: false, error: 'Profissional do item não encontrado.', status: 400 };
    }
  }
  if (input.status && !ITEM_STATUSES.includes(input.status)) {
    return { ok: false, error: `Situação de item inválida: use ${ITEM_STATUSES.join(', ')}.`, status: 400 };
  }
  return {
    ok: true,
    data: {
      procedure_id: input.procedure_id ? Number(input.procedure_id) : null,
      tooth,
      description: descricao,
      amount_cents: valor,
      quantity: qtd,
      professional_id: input.professional_id ? Number(input.professional_id) : null,
      status: input.status ?? 'planejado',
      sort_order: Number(input.sort_order ?? 100),
      notes: String(input.notes ?? '').trim().slice(0, 500) || null,
    },
  };
}

function assinatura(professionalId: number | null): { nome: string | null; cro: string | null } {
  if (!professionalId) return { nome: null, cro: null };
  const p = professionalRepository.findById(professionalId);
  if (!p) return { nome: null, cro: null };
  return { nome: p.name, cro: p.cro ? `${p.cro}${p.cro_state ? '/' + p.cro_state : ''}` : null };
}

// ─────────────────────────────── Consultas ───────────────────────────────

export function listPlans(req: Request, patientId: number): Result<{
  items: PlanOutput[];
  resumo: { planos_abertos: number; itens_pendentes: number; total_aberto_cents: number };
}> {
  if (!req.user?.permissions.has('odonto.plans.view')) {
    return { ok: false, error: 'Permissão negada: odonto.plans.view', status: 403 };
  }
  if (!patientRepository.findById(patientId)) {
    return { ok: false, error: 'Paciente não encontrado.', status: 404 };
  }
  return {
    ok: true,
    data: {
      items: treatmentPlanRepository.listByPatient(patientId).map((p) => plano(p)),
      resumo: treatmentPlanRepository.resumo(patientId),
    },
  };
}

export function getPlan(req: Request, id: number): Result<PlanOutput> {
  if (!req.user?.permissions.has('odonto.plans.view')) {
    return { ok: false, error: 'Permissão negada: odonto.plans.view', status: 403 };
  }
  const row = treatmentPlanRepository.findDetail(id);
  if (!row) return { ok: false, error: 'Plano de tratamento não encontrado.', status: 404 };
  return { ok: true, data: plano(row, true) };
}

// ─────────────────────────────── Criação ───────────────────────────────

export function createPlan(req: Request, patientId: number, input: PlanInput): Result<PlanOutput> {
  assertAuth(req);
  if (!req.user?.permissions.has('odonto.plans.manage')) {
    return { ok: false, error: 'Permissão negada: odonto.plans.manage', status: 403 };
  }
  if (!patientRepository.findById(patientId)) {
    return { ok: false, error: 'Paciente não encontrado.', status: 404 };
  }
  const itens = input.items ?? [];
  if (!itens.length) return { ok: false, error: 'Um plano precisa de pelo menos um item.', status: 400 };
  const validados: Record<string, unknown>[] = [];
  for (const bruto of itens) {
    const v = validaItem(bruto);
    if (!v.ok) return v;
    validados.push(v.data);
  }

  const profissionalId = input.professional_id ? Number(input.professional_id) : null;
  if (profissionalId && !professionalRepository.findById(profissionalId)) {
    return { ok: false, error: 'Profissional responsável não encontrado.', status: 400 };
  }
  const assina = assinatura(profissionalId);

  let id = 0;
  treatmentPlanRepository.transaction(() => {
    id = treatmentPlanRepository.createPlan({
      patient_id: patientId,
      professional_id: profissionalId,
      title: String(input.title ?? '').trim().slice(0, 120) || null,
      status: 'planejado',
      notes: String(input.notes ?? '').trim().slice(0, 1000) || null,
      professional_name_snapshot: assina.nome,
      professional_cro_snapshot: assina.cro,
      created_by: req.user?.id ?? null,
    });
    validados.forEach((dados, i) => {
      treatmentPlanRepository.createItem({ plan_id: id, sort_order: i * 10, ...dados });
    });
  });

  const row = treatmentPlanRepository.findDetail(id)!;
  audit(req, 'criar', 'odonto_treatment_plan', id, null, {
    patient_id: patientId, professional_id: profissionalId,
    itens: validados.length, total_cents: Number(row.total_cents ?? 0),
  });
  return { ok: true, data: plano(row, true) };
}

/**
 * Atualiza o plano. Os itens vêm COMPLETOS (como num documento): o que não veio é excluído
 * (soft delete) e o que veio com `id` é atualizado.
 *
 * Depois de cobrado, os itens não mudam: a cobrança no financeiro já foi gerada com aquele
 * valor, e mexer aqui deixaria os dois lados contando histórias diferentes.
 */
export function updatePlan(req: Request, id: number, input: PlanInput): Result<PlanOutput> {
  assertAuth(req);
  if (!req.user?.permissions.has('odonto.plans.manage')) {
    return { ok: false, error: 'Permissão negada: odonto.plans.manage', status: 403 };
  }
  const atual = treatmentPlanRepository.findDetail(id);
  if (!atual) return { ok: false, error: 'Plano de tratamento não encontrado.', status: 404 };
  if (atual.status === 'concluido' || atual.status === 'cancelado') {
    return { ok: false, error: `Plano ${atual.status}: não é mais editável.`, status: 400 };
  }

  if (input.items !== undefined && atual.charged_at) {
    return {
      ok: false,
      status: 400,
      error: 'Este plano já foi cobrado: os itens não mudam mais. Cancele o plano e crie outro (a cobrança já gerada continua no Financeiro).',
    };
  }

  const validados: { dados: Record<string, unknown>; id?: number }[] = [];
  for (const bruto of input.items ?? []) {
    const v = validaItem(bruto);
    if (!v.ok) return v;
    validados.push({ dados: v.data, id: bruto.id });
  }

  const profissionalId = input.professional_id !== undefined
    ? (input.professional_id ? Number(input.professional_id) : null)
    : atual.professional_id;
  if (profissionalId !== atual.professional_id && profissionalId && !professionalRepository.findById(profissionalId)) {
    return { ok: false, error: 'Profissional responsável não encontrado.', status: 400 };
  }
  const assina = assinatura(profissionalId);

  treatmentPlanRepository.transaction(() => {
    treatmentPlanRepository.updatePlan(id, {
      ...(input.title !== undefined ? { title: String(input.title ?? '').trim().slice(0, 120) || null } : {}),
      ...(input.notes !== undefined ? { notes: String(input.notes ?? '').trim().slice(0, 1000) || null } : {}),
      professional_id: profissionalId,
      professional_name_snapshot: assina.nome,
      professional_cro_snapshot: assina.cro,
    });
    if (input.items !== undefined) {
      const mantidos = new Set(validados.map((v) => v.id).filter(Boolean) as number[]);
      for (const existente of treatmentPlanRepository.listItems(id)) {
        if (!mantidos.has(existente.id)) treatmentPlanRepository.softDeleteItem(existente.id);
      }
      validados.forEach((v, i) => {
        const dados = { ...v.dados, sort_order: i * 10 };
        if (v.id) treatmentPlanRepository.updateItem(v.id, dados);
        else treatmentPlanRepository.createItem({ plan_id: id, ...dados });
      });
    }
  });

  const row = treatmentPlanRepository.findDetail(id)!;
  audit(req, 'editar', 'odonto_treatment_plan', id,
    { itens: atual.items_count, total_cents: Number(atual.total_cents ?? 0) },
    { itens: Number(row.items_count ?? 0), total_cents: Number(row.total_cents ?? 0) });
  return { ok: true, data: plano(row, true) };
}

// ─────────────────────────────── Situação ───────────────────────────────

export function changePlanStatus(req: Request, id: number, novo: unknown, motivo?: unknown): Result<PlanOutput> {
  assertAuth(req);
  if (!req.user?.permissions.has('odonto.plans.manage')) {
    return { ok: false, error: 'Permissão negada: odonto.plans.manage', status: 403 };
  }
  const atual = treatmentPlanRepository.findDetail(id);
  if (!atual) return { ok: false, error: 'Plano de tratamento não encontrado.', status: 404 };

  const status = String(novo ?? '') as PlanStatus;
  if (!PLAN_STATUSES.includes(status)) {
    return { ok: false, error: `Situação inválida: use ${PLAN_STATUSES.join(', ')}.`, status: 400 };
  }
  if (status === atual.status) return { ok: false, error: `O plano já está como ${status}.`, status: 400 };
  if (!TRANSICOES_PLANO[atual.status].includes(status)) {
    return { ok: false, error: `De "${atual.status}" não dá para ir para "${status}".`, status: 400 };
  }
  // Aprovar um plano sem valor não gera cobrança nenhuma depois: barra aqui.
  if (status === 'aprovado' && Number(atual.total_cents ?? 0) <= 0) {
    return { ok: false, error: 'Plano sem valor: informe o valor dos itens antes de aprovar.', status: 400 };
  }

  treatmentPlanRepository.transaction(() => {
    treatmentPlanRepository.updatePlan(id, {
      status,
      [CARIMBO[status] as string]: agora(),
      ...(status === 'cancelado' ? { cancel_reason: String(motivo ?? '').trim().slice(0, 300) || null } : {}),
    });
    // Aprovar o plano aprova os itens; concluir conclui — assim o item não fica para trás.
    if (status === 'aprovado') {
      for (const i of treatmentPlanRepository.listItems(id)) {
        if (i.status === 'planejado') treatmentPlanRepository.updateItem(i.id, { status: 'aprovado' });
      }
    }
    if (status === 'concluido') {
      for (const i of treatmentPlanRepository.listItems(id)) {
        if (i.status !== 'cancelado') treatmentPlanRepository.updateItem(i.id, { status: 'concluido' });
      }
    }
  });

  const row = treatmentPlanRepository.findDetail(id)!;
  audit(req, 'editar', 'odonto_treatment_plan', id, { status: atual.status }, {
    status: row.status, motivo: String(motivo ?? '') || null,
  });
  return { ok: true, data: plano(row, true) };
}

export function changeItemStatus(
  req: Request,
  planId: number,
  itemId: number,
  novo: unknown,
): Result<PlanItemOutput> {
  assertAuth(req);
  if (!req.user?.permissions.has('odonto.plans.manage')) {
    return { ok: false, error: 'Permissão negada: odonto.plans.manage', status: 403 };
  }
  const planoRow = treatmentPlanRepository.findDetail(planId);
  if (!planoRow) return { ok: false, error: 'Plano de tratamento não encontrado.', status: 404 };
  const atual = treatmentPlanRepository.findItem(itemId);
  if (!atual || atual.plan_id !== planId) return { ok: false, error: 'Item do plano não encontrado.', status: 404 };

  const status = String(novo ?? '') as ItemStatus;
  if (!ITEM_STATUSES.includes(status)) {
    return { ok: false, error: `Situação de item inválida: use ${ITEM_STATUSES.join(', ')}.`, status: 400 };
  }
  if (status === atual.status) return { ok: false, error: `O item já está como ${status}.`, status: 400 };
  if (!TRANSICOES_ITEM[atual.status].includes(status)) {
    return { ok: false, error: `De "${atual.status}" não dá para ir para "${status}".`, status: 400 };
  }

  treatmentPlanRepository.updateItem(itemId, { status });
  audit(req, 'editar', 'odonto_treatment_item', itemId, { status: atual.status }, { status, plan_id: planId });
  return { ok: true, data: item(treatmentPlanRepository.findItem(itemId)!) };
}

/**
 * Apaga o plano por engano. Depois de cobrado (ou com item concluído) não apaga: o caminho é
 * cancelar — o histórico financeiro não pode ficar apontando para algo que sumiu.
 */
export function removePlan(req: Request, id: number): Result<{ removido: boolean }> {
  assertAuth(req);
  if (!req.user?.permissions.has('odonto.plans.manage')) {
    return { ok: false, error: 'Permissão negada: odonto.plans.manage', status: 403 };
  }
  const atual = treatmentPlanRepository.findDetail(id);
  if (!atual) return { ok: false, error: 'Plano de tratamento não encontrado.', status: 404 };
  if (atual.charged_at) {
    return { ok: false, status: 400, error: 'Plano já cobrado não é apagado: cancele o plano (a cobrança continua no Financeiro).' };
  }
  if (treatmentPlanRepository.listItems(id).some((i) => i.status === 'concluido')) {
    return { ok: false, status: 400, error: 'Plano com item concluído não é apagado: cancele o plano.' };
  }

  treatmentPlanRepository.transaction(() => {
    for (const i of treatmentPlanRepository.listItems(id)) treatmentPlanRepository.softDeleteItem(i.id);
    treatmentPlanRepository.softDeletePlan(id);
  });
  audit(req, 'excluir', 'odonto_treatment_plan', id, { status: atual.status, itens: atual.items_count }, null);
  return { ok: true, data: { removido: true } };
}

// ─────────────────────── Cobrança no financeiro (PR §12) ───────────────────────

/** Vencimentos das parcelas: mensais a partir da primeira, no mesmo dia (dia 31 cai no fim do mês). */
export function vencimentosParcelas(primeiroVencimento: string, parcelas: number): string[] {
  const [ano0, mes0, dia0] = primeiroVencimento.split('-').map(Number);
  const datas: string[] = [];
  for (let i = 0; i < parcelas; i++) {
    const ano = ano0 + Math.floor((mes0 - 1 + i) / 12);
    const mes = ((mes0 - 1 + i) % 12) + 1;
    const ultimoDia = new Date(Date.UTC(ano, mes, 0)).getUTCDate();
    datas.push(`${ano}-${String(mes).padStart(2, '0')}-${String(Math.min(dia0, ultimoDia)).padStart(2, '0')}`);
  }
  return datas;
}

interface FinanceReceivablesService {
  create(input: {
    description: string; amountCents: number; dueDate: string; customerId?: number; notes?: string;
    saleId?: number; installmentNo?: number; installmentCount?: number;
  }): number;
}

export interface ChargePlanInput {
  installments?: number;
  first_due_date?: string;
}

export interface ChargePlanOutput {
  plan_id: number;
  total_cents: number;
  installments: number;
  installment_cents: number;
  due_dates: string[];
  receivable_ids: number[];
  /** Diferença de centavos jogada na última parcela (divisão inteira). */
  ajuste_ultima_parcela_cents: number;
}

const DATA = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Gera a cobrança do plano aprovado no FINANCEIRO do Kivo (PR §12). Uma parcela vira uma conta
 * a receber, do cliente que ancora o paciente — nada de tabela de cobrança paralela aqui.
 */
export function chargePlan(req: Request, id: number, input: ChargePlanInput): Result<ChargePlanOutput> {
  assertAuth(req);
  if (!req.user?.permissions.has('odonto.plans.charge')) {
    return { ok: false, error: 'Permissão negada: odonto.plans.charge', status: 403 };
  }
  const atual = treatmentPlanRepository.findDetail(id);
  if (!atual) return { ok: false, error: 'Plano de tratamento não encontrado.', status: 404 };
  if (atual.charged_at) {
    return {
      ok: false, status: 400,
      error: `Este plano já foi cobrado em ${String(atual.charged_at).slice(0, 10).split('-').reverse().join('/')} (${atual.installments}x).`,
    };
  }
  if (atual.status !== 'aprovado' && atual.status !== 'em_andamento' && atual.status !== 'concluido') {
    return { ok: false, error: 'Só plano aprovado gera cobrança. Aprove o plano primeiro.', status: 400 };
  }
  const total = Number(atual.total_cents ?? 0);
  if (total <= 0) return { ok: false, error: 'Plano sem valor: não há o que cobrar.', status: 400 };

  const parcelas = Math.max(1, Math.min(36, Math.round(Number(input.installments ?? 1))));
  if (parcelas > total) {
    return { ok: false, error: `Não dá para dividir ${total} centavos em ${parcelas} parcelas.`, status: 400 };
  }
  const primeiro = String(input.first_due_date ?? '').trim();
  if (!DATA.test(primeiro)) {
    return { ok: false, error: 'Informe a data do primeiro vencimento (AAAA-MM-DD).', status: 400 };
  }

  if (!hasService('finance.receivables')) {
    return {
      ok: false, status: 400,
      error: 'O módulo Financeiro não está ligado nesta empresa: sem ele o plano não gera cobrança (o Kivo não tem financeiro próprio do Odonto).',
    };
  }
  const finance = getService<FinanceReceivablesService>('finance.receivables');
  // A conta entra no nome do CLIENTE que ancora o paciente: é o que faz a cobrança aparecer no
  // extrato e no "Financeiro do paciente" que já existem.
  const paciente = patientRepository.findById(atual.patient_id);
  if (!paciente) return { ok: false, error: 'Paciente do plano não encontrado.', status: 404 };

  // Divisão em centavos: o resto vai para a última parcela (soma tem de fechar exatamente).
  const base = Math.floor(total / parcelas);
  const resto = total - base * parcelas;
  const datas = vencimentosParcelas(primeiro, parcelas);
  const ids: number[] = [];

  treatmentPlanRepository.transaction(() => {
    for (let i = 0; i < parcelas; i++) {
      const valor = i === parcelas - 1 ? base + resto : base;
      ids.push(finance.create({
        description: `Plano de tratamento #${id}${atual.title ? ' — ' + atual.title : ''}`
          + (parcelas > 1 ? ` (parcela ${i + 1}/${parcelas})` : ''),
        amountCents: valor,
        dueDate: datas[i],
        customerId: paciente.customer_id,
        notes: `Gerado pelo Kivo Odonto (plano #${id}).`,
        installmentNo: parcelas > 1 ? i + 1 : undefined,
        installmentCount: parcelas > 1 ? parcelas : undefined,
      }));
    }
    treatmentPlanRepository.updatePlan(id, {
      charged_at: agora(), installments: parcelas, first_due_date: primeiro,
    });
  });

  audit(req, 'criar', 'odonto_treatment_plan_charge', id, null, {
    total_cents: total, parcelas, primeiro_vencimento: primeiro, contas: ids.length,
  });
  return {
    ok: true,
    data: {
      plan_id: id, total_cents: total, installments: parcelas, installment_cents: base,
      due_dates: datas, receivable_ids: ids, ajuste_ultima_parcela_cents: resto,
    },
  };
}

/** Excluir o paciente leva planos e itens junto (o chamador já garante a transação). */
export function removePlansByPatient(patientId: number): void {
  treatmentPlanRepository.softDeleteByPatient(patientId);
}

/** Resumo para a ficha do paciente. */
export function patientPlansSummary(patientId: number): { planos_abertos: number; itens_pendentes: number; total_aberto_cents: number } {
  return treatmentPlanRepository.resumo(patientId);
}

/** Dentes com tratamento planejado (o odontograma marca "P" com isto). */
export function plannedTeeth(patientId: number): { tooth: string; description: string; plan_id: number; status: string }[] {
  return treatmentPlanRepository.plannedByTooth(patientId);
}

/**
 * Contrato exposto a outros módulos: os documentos (fase 7) vão montar o orçamento a partir
 * do plano, e o painel usa os totais.
 */
export interface OdontoPlansService {
  listByPatient(patientId: number): PlanOutput[];
  getPlan(id: number): PlanOutput | null;
  plannedTeeth(patientId: number): { tooth: string; description: string; plan_id: number; status: string }[];
  summary(patientId: number): { planos_abertos: number; itens_pendentes: number; total_aberto_cents: number };
}

export const odontoPlansService: OdontoPlansService = {
  listByPatient: (patientId) => treatmentPlanRepository.listByPatient(patientId).map((p) => plano(p)),
  getPlan: (id) => {
    const row = treatmentPlanRepository.findDetail(id);
    return row ? plano(row, true) : null;
  },
  plannedTeeth: (patientId) => plannedTeeth(patientId),
  summary: (patientId) => patientPlansSummary(patientId),
};
