import { z } from 'zod';

export const createProductSchema = z.object({
  name: z.string().min(1, 'Campo obrigatório: name'),
  description: z.string().nullish(),
  sku: z.string().nullable().optional(),
  barcode: z.string().nullable().optional(),
  categoryId: z.number().int().positive().nullable().optional(),
  unit: z.string().optional(),
  priceCents: z.number().int().optional(),
  costCents: z.number().int().optional(),
  trackStock: z.boolean().optional(),
  minStock: z.number().int().min(0).optional(),
  productType: z.enum(['fisico', 'variante', 'fracionado', 'composto', 'kit', 'combo', 'produzido', 'servico', 'digital', 'assinatura', 'complemento']).optional(),
  initialStock: z.number().int().positive().optional(),
  imageBase64: z.string().optional(),
  imageUrl: z.string().optional(),
  removeImage: z.boolean().optional(),
  submitToCatalog: z.boolean().optional(),
});

export const updateProductSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().nullish(),
  sku: z.string().nullable().optional(),
  barcode: z.string().nullable().optional(),
  categoryId: z.number().int().positive().nullable().optional(),
  unit: z.string().optional(),
  priceCents: z.number().int().optional(),
  costCents: z.number().int().optional(),
  trackStock: z.boolean().optional(),
  minStock: z.number().int().min(0).optional(),
  active: z.boolean().optional(),
  productType: z.enum(['fisico', 'variante', 'fracionado', 'composto', 'kit', 'combo', 'produzido', 'servico', 'digital', 'assinatura', 'complemento']).optional(),
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
  methodId: z.number().int().positive('ID da forma de pagamento inválido.').optional(),
  paymentMethodId: z.number().int().positive('ID da forma de pagamento inválido.').optional(),
  amountCents: z.number().int().positive('Valor do pagamento deve ser positivo.'),
  receivedCents: z.number().int().optional(),
  customerId: z.number().int().positive().optional(),
  dueDate: z.string().optional(),
  pointsUsed: z.number().int().positive().optional(),
  installments: z.object({ count: z.number().int().positive(), firstDueDate: z.string().optional() }).optional(),
}).transform((data) => ({
  ...data,
  methodId: data.methodId ?? data.paymentMethodId,
}));

export const createSaleSchema = z.object({
  items: z.array(saleItemSchema).min(1, 'Venda sem itens.'),
  payments: z.array(salePaymentSchema).min(1, 'Venda sem pagamentos.').optional(),
  paymentMethod: z.enum(['dinheiro', 'cartao_debito', 'cartao_credito', 'pix', 'prazo']).optional(),
  paidCents: z.number().int().optional(),
  customerId: z.number().int().positive().optional(),
  dueDate: z.string().optional(),
  discountCents: z.number().int().min(0).optional().default(0),
  surchargeCents: z.number().int().min(0).optional().default(0),
  clientRequestId: z.string().optional(),
}).refine(
  (data) => data.payments?.length || data.paymentMethod,
  { message: 'Informe payments[] ou paymentMethod.', path: ['paymentMethod'] },
);

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

export const createCategorySchema = z.object({
  name: z.string().min(1, 'Campo obrigatório: name'),
  parentId: z.number().int().positive().nullable().optional(),
});

export const updateCategorySchema = z.object({
  name: z.string().min(1, 'Campo obrigatório: name'),
});

export const deleteCategorySchema = z.object({
  migrateToId: z.number().int().positive().optional(),
});

const purchaseItemSchema = z.object({
  productId: z.number().int().positive('ID do produto inválido.'),
  qty: z.number().positive('Quantidade deve ser positiva.'),
  unitCostCents: z.number().int('Custo unitário deve ser inteiro.'),
});

export const createPurchaseSchema = z.object({
  supplierId: z.number().int().positive('Fornecedor inválido.'),
  items: z.array(purchaseItemSchema).min(1, 'Informe ao menos um item.'),
  notes: z.string().optional(),
  status: z.enum(['rascunho', 'recebida']).optional(),
});

export const updatePurchaseSchema = z.object({
  supplierId: z.number().int().positive().optional(),
  notes: z.string().optional(),
  items: z.array(purchaseItemSchema).optional(),
});

export const grantStoreCreditSchema = z.object({
  amountCents: z.number().int().min(1, 'Valor deve ser positivo.'),
  reason: z.string().optional(),
});

export const createComplementGroupSchema = z.object({
  name: z.string().min(1, 'Campo obrigatório: name'),
  minSelect: z.number().int().min(0).optional().default(0),
  maxSelect: z.number().int().min(0).nullable().optional(),
});

export const updateComplementGroupSchema = z.object({
  name: z.string().min(1).optional(),
  minSelect: z.number().int().min(0).optional(),
  maxSelect: z.number().int().min(0).nullable().optional(),
});

export const createComplementItemSchema = z.object({
  productId: z.number().int().positive('ID do produto inválido.'),
  priceOverrideCents: z.number().int().min(0).nullable().optional(),
  sortOrder: z.number().int().min(0).optional().default(0),
});

export const updateComplementItemSchema = z.object({
  productId: z.number().int().positive().optional(),
  priceOverrideCents: z.number().int().min(0).nullable().optional(),
  sortOrder: z.number().int().min(0).optional(),
});
