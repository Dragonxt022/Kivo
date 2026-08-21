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

export const saleItemSchema = z.object({
  productId: z.number().int().positive('ID do produto inválido.'),
  qty: z.number().positive('Quantidade deve ser positiva.'),
  unitPriceCents: z.number().int().optional(),
  notes: z.string().optional(),
  lineGroupUuid: z.string().optional(),
});

export const salePaymentSchema = z.object({
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
  // Cliente não cadastrado: identifica a venda no histórico sem obrigar o cadastro no
  // meio do atendimento. Ignorado quando vem customerId — aí o nome sai do cadastro.
  customerName: z.string().max(120, 'Nome do cliente muito longo.').optional(),
  dueDate: z.string().optional(),
  discountCents: z.number().int().min(0).optional().default(0),
  surchargeCents: z.number().int().min(0).optional().default(0),
  clientRequestId: z.string().optional(),
}).refine(
  (data) => data.payments?.length || data.paymentMethod,
  { message: 'Informe payments[] ou paymentMethod.', path: ['paymentMethod'] },
);

// O orçamento é montado no PDV, então o item dele é exatamente o item da venda:
// complemento (lineGroupUuid), observação e preço cotado (unitPriceCents).
const quoteItemSchema = saleItemSchema;

export const createQuoteSchema = z.object({
  items: z.array(quoteItemSchema).min(1, 'Orçamento sem itens.'),
  customerId: z.number().int().positive().optional(),
  customerName: z.string().max(120, 'Nome do cliente muito longo.').optional(),
  discountCents: z.number().int().min(0).optional().default(0),
  surchargeCents: z.number().int().min(0).optional().default(0),
  validUntil: z.string().optional(),
  notes: z.string().optional(),
});

// `null` limpa o campo, ausente preserva. Sem a distinção não havia como desvincular
// o cliente nem apagar a validade de um orçamento já salvo.
export const updateQuoteSchema = z.object({
  items: z.array(quoteItemSchema).min(1, 'Orçamento sem itens.').optional(),
  customerId: z.number().int().positive().nullable().optional(),
  customerName: z.string().max(120, 'Nome do cliente muito longo.').nullable().optional(),
  validUntil: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  discountCents: z.number().int().min(0).optional(),
  surchargeCents: z.number().int().min(0).optional(),
});

// Conversão em venda: o PDV manda o carrinho atual (o operador pode ter ajustado ao
// reabrir o orçamento). Sem `items`, valem os itens gravados no orçamento.
export const convertQuoteSchema = z.object({
  items: z.array(quoteItemSchema).min(1).optional(),
  payments: z.array(salePaymentSchema).min(1).optional(),
  paymentMethod: z.enum(['dinheiro', 'cartao_debito', 'cartao_credito', 'pix', 'prazo']).optional(),
  paidCents: z.number().int().optional(),
  customerId: z.number().int().positive().optional(),
  customerName: z.string().max(120, 'Nome do cliente muito longo.').optional(),
  dueDate: z.string().optional(),
  clientRequestId: z.string().optional(),
}).refine(
  (data) => data.payments?.length || data.paymentMethod,
  { message: 'Informe payments[] ou paymentMethod.', path: ['paymentMethod'] },
);

export const loginSchema = z.object({
  username: z.string().min(1, 'Informe o usuário.'),
  password: z.string().min(1, 'Informe a senha.'),
  remember: z.boolean().optional().default(false),
});

/**
 * Primeiro acesso: o dono cria a própria credencial no lugar do admin/admin de fábrica.
 * As regras de senha são as mesmas da troca de senha — o acesso nasce já no padrão
 * exigido do resto do sistema, sem uma senha fraca herdada.
 */
export const firstRunSetupSchema = z.object({
  name: z.string().trim().min(2, 'Informe seu nome.').max(80, 'Nome muito longo.'),
  username: z
    .string()
    .trim()
    .min(3, 'O usuário deve ter no mínimo 3 caracteres.')
    .max(32, 'Usuário muito longo.')
    .regex(/^[a-zA-Z0-9._-]+$/, 'Use apenas letras, números, ponto, hífen ou sublinhado.'),
  password: z
    .string()
    .min(8, 'A senha deve ter no mínimo 8 caracteres.')
    .regex(/[A-Z]/, 'A senha deve conter pelo menos 1 letra maiúscula.')
    .regex(/[a-z]/, 'A senha deve conter pelo menos 1 letra minúscula.')
    .regex(/[0-9]/, 'A senha deve conter pelo menos 1 dígito.'),
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
  paymentMethodId: z.number().int().positive().nullable().optional(),
  installmentCount: z.number().int().min(1).max(24).nullable().optional(),
  firstDueDate: z.string().nullable().optional(),
  lateFeeCents: z.number().int().min(0).nullable().optional(),
  dailyInterestBps: z.number().int().min(0).max(10000).nullable().optional(),
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

// ─────────────────────────────────────────────────────────────────────────────
// Comandas & mesas
//
// Antes destes schemas as 12 rotas do módulo validavam com `if (!campo) 400` dentro do
// controller — o que aceita `qty: "abacaxi"`, `qty: -3` ou `payments: [{}]` e só quebra
// mais fundo, no meio de uma transação que mexe em estoque e caixa. O fechamento de
// comanda reaproveita os schemas de item e pagamento da VENDA, que é literalmente o que
// ele gera no fim.
// ─────────────────────────────────────────────────────────────────────────────

export const createTableSchema = z.object({
  label: z.string().min(1, 'Informe o nome da mesa.').max(60, 'Nome de mesa muito longo.'),
  sortOrder: z.number().int().min(0).optional(),
});

export const updateTableSchema = z.object({
  label: z.string().min(1, 'Informe o nome da mesa.').max(60, 'Nome de mesa muito longo.').optional(),
  sortOrder: z.number().int().min(0).optional(),
});

// `tableId` é opcional: comanda de balcão (sem mesa) é um uso válido.
export const openComandaSchema = z.object({
  tableId: z.number().int().positive('ID da mesa inválido.').optional(),
  customerId: z.number().int().positive('ID do cliente inválido.').optional(),
  notes: z.string().max(500, 'Observação muito longa.').optional(),
});

export const addComandaItemSchema = z.object({
  productId: z.number().int().positive('ID do produto inválido.'),
  qty: z.number().positive('Quantidade deve ser positiva.'),
  notes: z.string().max(500, 'Observação muito longa.').optional(),
  lineGroupUuid: z.string().optional(),
});

export const transferComandaSchema = z.object({
  tableId: z.number().int().positive('Informe a mesa de destino.'),
});

export const splitComandaSchema = z.object({
  itemIds: z.array(z.number().int().positive()).min(1, 'Selecione ao menos um item para separar.'),
});

export const mergeComandaSchema = z.object({
  sourceComandaId: z.number().int().positive('Informe a comanda de origem.'),
});

// Corpo ausente vale como `pronta: true` — é o comportamento que o controller já tinha
// (`req.body?.pronta !== false`), e o botão do garçom chama sem corpo nenhum.
export const readyForPaymentSchema = z.object({
  pronta: z.boolean().optional(),
});

export const closeComandaSchema = z.object({
  payments: z.array(salePaymentSchema).min(1, 'Informe ao menos uma forma de pagamento.'),
  items: z.array(saleItemSchema).min(1).optional(),
  discountCents: z.number().int().min(0).optional(),
  surchargeCents: z.number().int().min(0).optional(),
  customerId: z.number().int().positive().optional(),
  customerName: z.string().max(120, 'Nome do cliente muito longo.').optional(),
  clientRequestId: z.string().optional(),
});

// ─────────────────────────────────────────────────────────────────────────────
// Usuários e cargos (Core)
//
// São as rotas que criam credencial e distribuem permissão — as últimas onde o corpo
// devia chegar sem forma conferida. A força da senha continua com
// `validatePasswordStrength` (regra do projeto, mensagem própria); aqui o schema só
// garante que os campos existem e são do tipo certo antes de virarem hash e INSERT.
// ─────────────────────────────────────────────────────────────────────────────

export const createUserSchema = z.object({
  username: z.string().trim().min(1, 'Informe o nome de usuário.').max(60, 'Nome de usuário muito longo.'),
  name: z.string().trim().min(1, 'Informe o nome.').max(120, 'Nome muito longo.'),
  // Sem checagem de formato de propósito: o campo é `type="text"` na tela, não é usado
  // para autenticar nem para enviar nada, e recusar o que o lojista digitou ali seria
  // criar um obstáculo onde não há risco. O limite existe para não crescer sem fim.
  email: z.string().max(160, 'E-mail muito longo.').nullable().optional(),
  password: z.string().min(1, 'Informe a senha.'),
  roleSlug: z.string().min(1, 'Informe o cargo.'),
  quickLogin: z.boolean().optional(),
});

export const updateUserSchema = z.object({
  name: z.string().trim().min(1, 'Informe o nome.').max(120, 'Nome muito longo.').optional(),
  email: z.string().max(160, 'E-mail muito longo.').nullable().optional(),
  roleSlug: z.string().min(1).optional(),
  active: z.boolean().optional(),
  // String vazia = "não trocar a senha", que é o que a tela manda quando o campo fica em
  // branco. O controller já trata pelo mesmo truthy.
  password: z.string().optional(),
  quickLogin: z.boolean().optional(),
});

export const bulkDeleteUsersSchema = z.object({
  ids: z.array(z.union([z.number().int().positive(), z.string().min(1)]))
    .min(1, 'Informe ao menos um id.'),
});

export const createRoleSchema = z.object({
  name: z.string().trim().min(1, 'Informe o nome do cargo.').max(60, 'Nome de cargo muito longo.'),
});

// Lista VAZIA é válida: significa "tirar todas as permissões deste cargo". A recusa do
// cargo Administrador e a checagem de chave inexistente continuam no controller, que é
// quem conhece o catálogo de permissões do banco.
export const setRolePermissionsSchema = z.object({
  permissions: z.array(z.string().min(1)),
});

// ─────────────────────────────────────────────────────────────────────────────
// Foodservice (cozinha)
// ─────────────────────────────────────────────────────────────────────────────

const kitchenStatusValues = ['pendente', 'preparo', 'pronto', 'entregue'] as const;

export const createKitchenRoutingSchema = z.object({
  productId: z.number().int().positive('ID do produto inválido.'),
  station: z.string().max(60, 'Nome da estação muito longo.').nullable().optional(),
  estimatedMinutes: z.number().int().min(0).max(600, 'Tempo estimado fora do razoável.').nullable().optional(),
});

export const updateKitchenRoutingSchema = z.object({
  station: z.string().max(60, 'Nome da estação muito longo.').nullable().optional(),
  estimatedMinutes: z.number().int().min(0).max(600, 'Tempo estimado fora do razoável.').nullable().optional(),
});

export const kitchenStatusSchema = z.object({
  status: z.enum(kitchenStatusValues, { error: 'Status inválido.' }),
});

// ─────────────────────────────────────────────────────────────────────────────
// Contas a pagar / a receber
//
// `installments` e `settledAt` continuam com a checagem do controller também: ela devolve
// mensagem específica ("entre 1 e 24", "use AAAA-MM-DD") que a tela mostra ao lojista, e
// duplicar a regra aqui só adianta a recusa — não substitui aquela mensagem.
// ─────────────────────────────────────────────────────────────────────────────

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use o formato AAAA-MM-DD.');

export const createBillSchema = z.object({
  description: z.string().trim().min(1, 'Informe a descrição.').max(200, 'Descrição muito longa.'),
  amountCents: z.number().int().positive('Valor deve ser inteiro em centavos, maior que zero.'),
  dueDate: isoDate,
  issueDate: isoDate.optional(),
  partyId: z.number().int().positive().nullable().optional(),
  notes: z.string().max(1000, 'Observação muito longa.').nullable().optional(),
  dreCategoryId: z.number().int().positive().nullable().optional(),
  installments: z.number().int().min(1).max(24).nullable().optional(),
});

export const updateBillSchema = z.object({
  description: z.string().trim().min(1).max(200, 'Descrição muito longa.').optional(),
  amountCents: z.number().int().positive('Valor deve ser inteiro em centavos, maior que zero.').optional(),
  dueDate: isoDate.optional(),
  issueDate: isoDate.nullable().optional(),
  partyId: z.number().int().positive().nullable().optional(),
  notes: z.string().max(1000, 'Observação muito longa.').nullable().optional(),
  dreCategoryId: z.number().int().positive().nullable().optional(),
  status: z.literal('cancelada').optional(),
});

export const settleBillSchema = z.object({
  payments: z.array(z.object({
    paymentMethodId: z.number().int().positive('Forma de pagamento inválida.'),
    amountCents: z.number().int().positive('Valor inválido em uma das formas de pagamento.'),
  })).min(1, 'Informe ao menos uma forma de pagamento.'),
  settledAt: isoDate.optional(),
});

// ─────────────────────────────────────────────────────────────────────────────
// DRE — categorias
//
// As linhas com valor calculado automaticamente (receita bruta, CMV, taxas de cartão)
// não entram: o lojista só cria/edita categoria nas linhas manuais. `adjustmentBps` é
// ponto-base — ±10000 é ±100%.
// ─────────────────────────────────────────────────────────────────────────────

export const DRE_MANUAL_LINES = ['deducoes', 'cmv', 'despesas_operacionais', 'despesas_financeiras'] as const;

export const createDreCategorySchema = z.object({
  label: z.string().trim().min(1, 'Informe o nome da categoria.').max(120, 'Nome muito longo.'),
  dreLine: z.enum(DRE_MANUAL_LINES, { error: `Linha do DRE deve ser uma de: ${DRE_MANUAL_LINES.join(' | ')}.` }),
  adjustmentBps: z.number().int().min(-10000).max(10000, 'Ajuste deve estar entre -10000 e 10000 bps (-100% a +100%).').optional(),
});

export const updateDreCategorySchema = z.object({
  label: z.string().trim().min(1).max(120, 'Nome muito longo.').optional(),
  dreLine: z.enum(DRE_MANUAL_LINES, { error: `Linha do DRE deve ser uma de: ${DRE_MANUAL_LINES.join(' | ')}.` }).optional(),
  adjustmentBps: z.number().int().min(-10000).max(10000, 'Ajuste deve estar entre -10000 e 10000 bps.').optional(),
  active: z.union([z.boolean(), z.number().int()]).optional(),
});

// ─────────────────────────────────────────────────────────────────────────────
// Fiscal (NFC-e)
//
// Os dois `save` do módulo faziam `req.body as Partial<...>` e gravavam direto em
// `settings` — um cast, que é promessa de tipo em tempo de compilação e nada em tempo de
// execução. Aqui os campos passam a ser conferidos de fato antes de virar configuração
// fiscal, que é o que sai impresso no documento do cliente.
//
// Todos opcionais: as duas telas salvam por partes (a de empresa e a de parâmetros).
// ─────────────────────────────────────────────────────────────────────────────

export const saveFiscalEmpresaSchema = z.object({
  razaoSocial: z.string().max(200).optional(),
  nomeFantasia: z.string().max(200).optional(),
  cnpj: z.string().max(20).optional(),
  ie: z.string().max(30).optional(),
  cep: z.string().max(12).optional(),
  rua: z.string().max(200).optional(),
  numero: z.string().max(20).optional(),
  complemento: z.string().max(100).optional(),
  bairro: z.string().max(100).optional(),
  cidade: z.string().max(100).optional(),
  uf: z.string().length(2, 'UF deve ter 2 letras.').optional(),
  municipioIbge: z.string().max(10).optional(),
  telefone: z.string().max(20).optional(),
});

export const saveFiscalConfigSchema = z.object({
  serie: z.number().int().min(1).max(999).optional(),
  crt: z.union([z.literal(1), z.literal(2), z.literal(3)], { error: 'CRT deve ser 1, 2 ou 3.' }).optional(),
  cfop: z.string().max(6).optional(),
  csosnPadrao: z.string().max(6).optional(),
  cstPadrao: z.string().max(6).optional(),
  origemPadrao: z.number().int().min(0).max(8).optional(),
  emitirAuto: z.boolean().optional(),
  pedirCpf: z.boolean().optional(),
  provider: z.string().max(60).optional(),
  idCsc: z.string().max(20).optional(),
});

// `csc` e `token` são segredos: vão para o cofre, nunca para `settings` nem para a
// auditoria. O schema só garante que são texto — o formato quem valida é o emissor.
export const saveFiscalCredentialsSchema = z.object({
  csc: z.string().max(200).optional(),
  idCsc: z.string().max(20).optional(),
  provider: z.string().max(60).optional(),
  token: z.string().max(500).optional(),
});

export const uploadCertificateSchema = z.object({
  pfxBase64: z.string().min(1, 'Envie o arquivo do certificado (.pfx ou .p12).'),
  senha: z.string().min(1, 'Informe a senha do certificado.'),
});

// ─────────────────────────────────────────────────────────────────────────────
// Configurações (chave/valor)
// ─────────────────────────────────────────────────────────────────────────────

// `value` guardado como texto. Antes qualquer coisa passava por `String(value)` — mandar
// um objeto gravava a string "[object Object]" na configuração e só aparecia como
// comportamento estranho muito depois, sem pista da origem.
export const setSettingSchema = z.object({
  value: z.union([z.string().max(20000, 'Valor muito longo.'), z.number(), z.boolean(), z.null()]).optional(),
});

// ─────────────────────────────────────────────────────────────────────────────
// Ativação (rota PÚBLICA — roda antes de existir sessão) e suporte
// ─────────────────────────────────────────────────────────────────────────────

export const activateLicenseSchema = z.object({
  licenseKey: z.string().trim().min(1, 'Informe a chave de licença.').max(120, 'Chave de licença inválida.'),
  // Opcional: sem ele a nuvem descobre a empresa pela própria chave.
  companyUuid: z.string().trim().max(64).nullable().optional(),
});

// O corpo destas duas é repassado à nuvem. Os limites existem para o Kivo não virar o
// caminho por onde se empurra conteúdo grande para o servidor de suporte.
export const supportTicketSchema = z.object({
  subject: z.string().trim().min(1, 'Informe o assunto.').max(200, 'Assunto muito longo.'),
  category: z.string().max(60).optional(),
  message: z.string().trim().min(1, 'Escreva sua mensagem.').max(8000, 'Mensagem muito longa.'),
  attachment: z.string().max(8_000_000, 'Anexo grande demais.').nullable().optional(),
});

export const supportMessageSchema = z.object({
  body: z.string().trim().min(1, 'Escreva sua mensagem.').max(8000, 'Mensagem muito longa.'),
  attachment: z.string().max(8_000_000, 'Anexo grande demais.').nullable().optional(),
});
