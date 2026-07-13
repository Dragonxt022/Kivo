import { z } from 'zod';

export const createProductSchema = z.object({
  name: z.string().min(1, 'Campo obrigatório: name'),
  description: z.string().optional(),
  sku: z.string().optional(),
  barcode: z.string().optional(),
  categoryId: z.number().int().positive().optional(),
  unit: z.string().optional(),
  priceCents: z.number().int().optional(),
  costCents: z.number().int().optional(),
  trackStock: z.boolean().optional(),
  minStock: z.number().int().min(0).optional(),
  productType: z.enum(['fisico', 'servico', 'digital', 'variante']).optional(),
  initialStock: z.number().int().positive().optional(),
  imageBase64: z.string().optional(),
  imageUrl: z.string().optional(),
  removeImage: z.boolean().optional(),
  submitToCatalog: z.boolean().optional(),
});

export const updateProductSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  sku: z.string().optional(),
  barcode: z.string().optional(),
  categoryId: z.number().int().positive().optional(),
  unit: z.string().optional(),
  priceCents: z.number().int().optional(),
  costCents: z.number().int().optional(),
  trackStock: z.boolean().optional(),
  minStock: z.number().int().min(0).optional(),
  active: z.boolean().optional(),
  productType: z.enum(['fisico', 'servico', 'digital', 'variante']).optional(),
  imageBase64: z.string().optional(),
  imageUrl: z.string().optional(),
  removeImage: z.boolean().optional(),
  submitToCatalog: z.boolean().optional(),
});

export const stockMoveSchema = z.object({
  productId: z.number().int().positive('ID do produto inválido.'),
  type: z.enum(['entrada', 'saida', 'ajuste'], { error: 'Tipo deve ser entrada, saida ou ajuste.' }),
  qty: z.number().positive('Quantidade deve ser positiva.'),
  reason: z.string().optional(),
});

const saleItemSchema = z.object({
  productId: z.number().int().positive('ID do produto inválido.'),
  qty: z.number().positive('Quantidade deve ser positiva.'),
  unitPriceCents: z.number().int().optional(),
  notes: z.string().optional(),
  lineGroupUuid: z.string().optional(),
});

const salePaymentSchema = z.object({
  methodId: z.number().int().positive('ID da forma de pagamento inválido.'),
  amountCents: z.number().int().positive('Valor do pagamento deve ser positivo.'),
  receivedCents: z.number().int().optional(),
  installmentCount: z.number().int().positive().optional(),
});

export const createSaleSchema = z.object({
  items: z.array(saleItemSchema).min(1, 'Venda sem itens.'),
  payments: z.array(salePaymentSchema).min(1, 'Venda sem pagamentos.'),
  customerId: z.number().int().positive().optional(),
  discountCents: z.number().int().min(0).optional().default(0),
  surchargeCents: z.number().int().min(0).optional().default(0),
  clientRequestId: z.string().optional(),
});

const quoteItemSchema = z.object({
  productId: z.number().int().positive('ID do produto inválido.'),
  qty: z.number().positive('Quantidade deve ser positiva.'),
});

export const createQuoteSchema = z.object({
  items: z.array(quoteItemSchema).min(1, 'Orçamento sem itens.'),
  customerId: z.number().int().positive().optional(),
  customerName: z.string().optional(),
  discountCents: z.number().int().min(0).optional().default(0),
  validUntil: z.string().optional(),
  notes: z.string().optional(),
});

export const updateQuoteSchema = z.object({
  customerId: z.number().int().positive().optional(),
  customerName: z.string().optional(),
  validUntil: z.string().optional(),
  notes: z.string().optional(),
  discountCents: z.number().int().min(0).optional(),
});

export const loginSchema = z.object({
  username: z.string().min(1, 'Informe o usuário.'),
  password: z.string().min(1, 'Informe a senha.'),
  remember: z.boolean().optional().default(false),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Informe a senha atual.'),
  newPassword: z
    .string()
    .min(8, 'A senha deve ter no mínimo 8 caracteres.')
    .regex(/[A-Z]/, 'A senha deve conter pelo menos 1 letra maiúscula.')
    .regex(/[a-z]/, 'A senha deve conter pelo menos 1 letra minúscula.')
    .regex(/[0-9]/, 'A senha deve conter pelo menos 1 dígito.'),
});

export const openRegisterSchema = z.object({
  openingCents: z.number().int('Valor de abertura deve ser inteiro.').min(0, 'Valor de abertura não pode ser negativo.'),
});

export const closeRegisterSchema = z.object({
  countedCents: z.number().int('Valor contado deve ser inteiro.').min(0, 'Valor contado não pode ser negativo.'),
  notes: z.string().optional(),
  countBreakdown: z.record(z.string(), z.number()).optional(),
});
