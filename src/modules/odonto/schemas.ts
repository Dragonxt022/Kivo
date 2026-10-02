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
