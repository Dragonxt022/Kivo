import { z } from 'zod';

/**
 * Schemas de entrada do módulo odonto. Ficam no módulo (e não em `src/shared/schemas.ts`)
 * pelo mesmo motivo do módulo labels: são contrato interno do domínio clínico.
 */

/** Texto opcional com teto — aceita `null` (limpar campo) e string vazia. */
const optionalText = (max: number) => z.string().max(max).nullable().optional();

/** `active` chega como booleano do formulário e como 0/1 quando a linha é reeditada. */
const optionalActive = z.union([z.boolean(), z.number().int()]).optional();

export const clinicalSchema = z.object({
  medical_history: optionalText(4000),
  dental_history: optionalText(4000),
  allergies: optionalText(2000),
  medications: optionalText(2000),
  conditions: optionalText(2000),
  clinical_notes: optionalText(4000),
});

export const createPatientSchema = z.object({
  // Dados do cliente (`customers`) — a fonte única de nome, documento, contato e nascimento.
  name: z.string().min(1, 'Campo obrigatório: name'),
  document: optionalText(20),
  phone: optionalText(20),
  email: optionalText(120),
  birthday: optionalText(10),
  address: optionalText(200),
  cep: optionalText(9),
  // Dados do paciente (ficha odontológica).
  sex: z.enum(['feminino', 'masculino', 'outro', 'nao_informado']).nullable().optional(),
  rg: optionalText(20),
  photo_file: optionalText(120),
  notes: optionalText(1000),
  active: optionalActive,
  // Bloco clínico (dado sensível): exige `odonto.clinical.edit` — o serviço recusa sem ela.
  clinical: clinicalSchema.optional(),
});

export const updatePatientSchema = createPatientSchema.partial();

export const createProfessionalSchema = z.object({
  name: z.string().min(1, 'Campo obrigatório: name'),
  user_id: z.number().int().positive().nullable().optional(),
  cro: optionalText(20),
  cro_state: z.string().max(2).nullable().optional(),
  specialties: optionalText(200),
  phone: optionalText(20),
  email: optionalText(120),
  active: optionalActive,
});

export const updateProfessionalSchema = createProfessionalSchema.partial();

export const createProcedureSchema = z.object({
  name: z.string().min(1, 'Campo obrigatório: name'),
  product_id: z.number().int().positive().nullable().optional(),
  code: optionalText(40),
  category: optionalText(60),
  description: optionalText(1000),
  default_price_cents: z.number().int().min(0).optional(),
  duration_min: z.number().int().min(0).nullable().optional(),
  active: optionalActive,
});

export const updateProcedureSchema = createProcedureSchema.partial();

// ─────────────────────────────── Anamnese (PR §5) ───────────────────────────────

/** Uma pergunta do formulário. A estrutura é flexível de propósito: pergunta nova não exige migration. */
export const anamnesisFieldSchema = z.object({
  key: z.string().min(2).max(41),
  label: z.string().min(1).max(120),
  type: z.enum(['texto', 'texto_longo', 'sim_nao', 'selecao', 'multipla', 'data', 'numero']),
  required: z.union([z.boolean(), z.number().int()]).optional(),
  options: z.array(z.string().max(60)).max(30).optional(),
  help: optionalText(200),
});

/** Publicar o formulário = criar uma versão nova (a anterior fica, com as respostas dela). */
export const createAnamnesisTemplateSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  fields: z.array(anamnesisFieldSchema).min(1).max(100),
  notes: optionalText(1000),
  is_default: z.union([z.boolean(), z.number().int()]).optional(),
});

/** Responder = gravar uma revisão nova. As chaves são conferidas contra o formulário no serviço. */
export const saveAnamnesisSchema = z.object({
  template_id: z.number().int().positive().nullable().optional(),
  answers: z.record(z.string(), z.unknown()),
  professional_id: z.number().int().positive().nullable().optional(),
  notes: optionalText(1000),
});

// ─────────────────────────────── Agenda (PR §6) ───────────────────────────────

/** Data e hora do atendimento: o input datetime-local manda 'YYYY-MM-DDTHH:MM'. */
const dataHora = z.string().min(16).max(16);

export const createAppointmentSchema = z.object({
  patient_id: z.number().int().positive(),
  professional_id: z.number().int().positive(),
  procedure_id: z.number().int().positive().nullable().optional(),
  starts_at: dataHora,
  duration_min: z.number().int().min(5).max(480).optional(),
  room: optionalText(40),
  notes: optionalText(1000),
  /** Encaixe: pode sobrepor outro atendimento do mesmo profissional. */
  is_fit_in: z.union([z.boolean(), z.number().int()]).optional(),
});

/** Reagendar/editar: tudo opcional — o serviço só mexe no que veio. */
export const updateAppointmentSchema = createAppointmentSchema.partial();

export const appointmentStatusSchema = z.object({
  status: z.enum(['agendado', 'confirmado', 'em_atendimento', 'atendido', 'faltou', 'cancelado']),
  motivo: optionalText(200),
});

// ──────────────────────── Prontuário / evolução (PR §7 e §8) ────────────────────────

/** Procedimento realizado dentro de uma evolução: o nome vem do catálogo, não do formulário. */
export const noteProcedureSchema = z.object({
  procedure_id: z.number().int().positive().nullable().optional(),
  tooth: optionalText(8),
  note: optionalText(300),
});

/** Corpo de criação e de retificação — na retificação tudo é opcional (o que não vem, fica). */
export const clinicalNoteSchema = z.object({
  professional_id: z.number().int().positive().nullable().optional(),
  appointment_id: z.number().int().positive().nullable().optional(),
  happened_at: optionalText(16),
  title: optionalText(120),
  procedures: z.array(noteProcedureSchema).max(40).optional(),
  observations: optionalText(8000),
  diagnosis: optionalText(2000),
  conduct: optionalText(4000),
  next_steps: optionalText(2000),
  documents: z.array(z.number().int().positive()).max(50).optional(),
  exams: z.array(z.number().int().positive()).max(50).optional(),
});

export const retifyClinicalNoteSchema = clinicalNoteSchema.extend({
  motivo: z.string().min(5, 'Explique o motivo da retificação.').max(500),
});

// ──────────────────── Odontograma e situações (PR §9 e §10) ────────────────────

export const toothStateSchema = z.object({
  tooth: z.string().min(2).max(2),
  surface: z.enum(['M', 'D', 'O', 'V', 'L']).nullable().optional(),
  kind: z.enum(['situacao', 'planejado']).optional(),
  condition_id: z.number().int().positive(),
  note: optionalText(500),
  recorded_at: optionalText(16),
  professional_id: z.number().int().positive().nullable().optional(),
});

export const undoToothStateSchema = z.object({
  motivo: optionalText(200),
});

export const toothConditionSchema = z.object({
  code: z.string().min(2).max(31).optional(),
  name: z.string().min(1).max(60).optional(),
  color: optionalText(7),
  applies_to: z.enum(['dente', 'superficie', 'ambos']).optional(),
  sort_order: z.number().int().min(0).max(9999).optional(),
  active: z.union([z.boolean(), z.number().int()]).optional(),
});

// ─────────────────── Plano de tratamento (PR §11 e §12) ───────────────────

const itemStatus = z.enum(['planejado', 'aprovado', 'em_andamento', 'concluido', 'cancelado']);
const planStatus = z.enum(['planejado', 'apresentado', 'aprovado', 'em_andamento', 'concluido', 'cancelado']);

export const planItemSchema = z.object({
  /** Presente quando o item já existe (a edição manda a lista completa). */
  id: z.number().int().positive().optional(),
  procedure_id: z.number().int().positive().nullable().optional(),
  tooth: optionalText(2),
  description: z.string().min(1).max(200),
  amount_cents: z.number().int().min(0).max(100000000).optional(),
  quantity: z.number().int().min(1).max(999).optional(),
  professional_id: z.number().int().positive().nullable().optional(),
  status: itemStatus.optional(),
  sort_order: z.number().int().min(0).max(9999).optional(),
  notes: optionalText(500),
});

export const createPlanSchema = z.object({
  title: optionalText(120),
  notes: optionalText(1000),
  professional_id: z.number().int().positive().nullable().optional(),
  items: z.array(planItemSchema).min(1).max(100),
});

export const updatePlanSchema = z.object({
  title: optionalText(120),
  notes: optionalText(1000),
  professional_id: z.number().int().positive().nullable().optional(),
  items: z.array(planItemSchema).max(100).optional(),
});

export const planStatusSchema = z.object({ status: planStatus, motivo: optionalText(300) });
export const itemStatusSchema = z.object({ status: itemStatus });

/** Cobrança do plano: parcelamento e primeiro vencimento (o valor vem do plano). */
export const chargePlanSchema = z.object({
  installments: z.number().int().min(1).max(36).optional(),
  first_due_date: optionalText(10),
});

// ─────────────────── Documentos e modelos (PR §14 e §15) ───────────────────

const documentType = z.enum([
  'anamnese', 'plano_tratamento', 'tcle', 'contrato', 'atestado', 'declaracao',
  'encaminhamento', 'receita', 'termo_responsabilidade', 'termo_recusa', 'alta', 'outro',
]);

export const documentTemplateSchema = z.object({
  code: optionalText(40),
  name: optionalText(120),
  type: documentType.optional(),
  body: optionalText(20000),
  requires_professional: z.union([z.boolean(), z.number().int()]).optional(),
  active: z.union([z.boolean(), z.number().int()]).optional(),
  sort_order: z.number().int().min(0).max(9999).optional(),
});

export const createDocumentSchema = z.object({
  template_id: z.number().int().positive().nullable().optional(),
  type: documentType.optional(),
  title: optionalText(160),
  body: optionalText(20000),
  appointment_id: z.number().int().positive().nullable().optional(),
  plan_id: z.number().int().positive().nullable().optional(),
  professional_id: z.number().int().positive().nullable().optional(),
});

/** Editar rascunho: os mesmos campos, todos opcionais. */
export const updateDocumentSchema = createDocumentSchema.partial();

export const issueDocumentSchema = z.object({
  professional_id: z.number().int().positive().nullable().optional(),
});

export const cancelDocumentSchema = z.object({
  motivo: z.string().min(3, 'Informe o motivo do cancelamento.').max(300),
});

// ─────────────────── Exames e imagens (PR §16 e §17) ───────────────────

const examType = z.enum(['radiografia', 'tomografia', 'fotografia', 'documento', 'outro']);
const examPhase = z.enum(['antes', 'durante', 'depois']).nullable().optional();

export const createExamSchema = z.object({
  type: examType,
  phase: examPhase,
  exam_date: optionalText(10),
  tooth: optionalText(2),
  title: z.string().min(1).max(160),
  description: optionalText(1000),
  appointment_id: z.number().int().positive().nullable().optional(),
  plan_id: z.number().int().positive().nullable().optional(),
  professional_id: z.number().int().positive().nullable().optional(),
  // O arquivo chega em base64 no corpo JSON, como os demais uploads do sistema.
  file_base64: z.string().min(1),
  file_name: optionalText(180),
  file_mime: optionalText(80),
});

export const updateExamSchema = createExamSchema.partial();
