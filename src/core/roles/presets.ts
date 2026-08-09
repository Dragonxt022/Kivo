/**
 * Cargos prontos do Kivo — fonte única da verdade.
 *
 * O mesmo objeto alimenta duas coisas que antes viviam separadas e divergiam:
 *  - `runSeeds()` (core/database/seeds.ts), que cria os cargos de fábrica; e
 *  - a tela /admin/cargos, que oferece "aplicar modelo" ao editar as permissões.
 *
 * Antes daqui, os cargos nasciam com a lista de permissões VAZIA e o único jeito de
 * aproveitá-los era abrir cada um e clicar no modelo correspondente — quem não fizesse
 * isso criava usuários que não conseguiam abrir nada. Agora o cargo já nasce usável e o
 * modelo continua disponível para reaplicar depois de mexer demais.
 *
 * As chaves referenciam permissões de MÓDULOS (store.*, commercial.*, finance.*…), que
 * ainda não existem na tabela `permissions` quando as seeds rodam — o boot é
 * migrations → seeds → módulos. Isso é seguro porque `role_permissions.permission_key`
 * não tem FK: a linha fica "pendente" até o módulo registrar a permissão, o que sempre
 * acontece antes de qualquer requisição real. Se o módulo não estiver no plano
 * contratado, a permissão simplesmente nunca passa a valer (ver isModuleEntitled).
 */
export interface RolePreset {
  slug: string;
  name: string;
  /** Uma frase, na língua do lojista, explicando para quem é o cargo. */
  description: string;
  /** Nome de arquivo em src/public/icons (sem .svg). */
  icon: string;
  /** '*' = todas as permissões do sistema. */
  permissions: string[] | '*';
}

export const ROLE_PRESETS: RolePreset[] = [
  {
    slug: 'administrador',
    name: 'Administrador',
    description: 'Acesso total, inclusive configurações, usuários e licença. Sempre tem todas as permissões.',
    icon: 'shield-check',
    permissions: '*',
  },
  {
    slug: 'gerente',
    name: 'Gerente',
    description: 'Toca o dia a dia da loja inteira: vendas, estoque, compras, financeiro e relatórios. Não mexe em licença nem restaura backup.',
    icon: 'user-cog',
    permissions: [
      'users.view', 'users.create', 'users.edit', 'roles.view', 'audit.view',
      'settings.view', 'backup.view', 'backup.run', 'sync.run', 'billing.view', 'license.view',
      'commercial.customers.view', 'commercial.customers.create', 'commercial.customers.edit',
      'commercial.suppliers.view', 'commercial.suppliers.create', 'commercial.suppliers.edit',
      'commercial.products.view', 'commercial.products.search', 'commercial.products.create',
      'commercial.products.edit', 'commercial.products.price',
      'commercial.pricelists.view', 'commercial.pricelists.manage',
      'commercial.stock.view', 'commercial.stock.move',
      'commercial.purchases.view', 'commercial.purchases.create', 'commercial.purchases.edit', 'commercial.purchases.cancel',
      'commercial.agreements.view', 'commercial.agreements.create', 'commercial.agreements.edit',
      'commercial.customers.creditgrant',
      'finance.cash.view', 'finance.cash.open', 'finance.cash.close', 'finance.cash.move',
      'finance.payables.view', 'finance.payables.create', 'finance.payables.edit', 'finance.payables.pay',
      'finance.receivables.view', 'finance.receivables.create', 'finance.receivables.edit', 'finance.receivables.receive',
      'finance.reports.view', 'finance.paymethods.view', 'finance.paymethods.edit',
      'finance.agreements.view', 'finance.agreements.invoice', 'finance.reconciliation.view',
      'store.sales.view', 'store.sales.create', 'store.sales.discount', 'store.sales.cancel',
      'store.quotes.view', 'store.quotes.create', 'store.quotes.edit', 'store.reports.view',
      'comandas.view', 'comandas.manage', 'comandas.tables.manage',
      'fiscal.config.view', 'fiscal.documents.view', 'fiscal.emit', 'fiscal.cancel',
      'dre.view',
    ],
  },
  {
    slug: 'vendedor',
    name: 'Vendedor',
    description: 'Atende e vende: PDV, orçamentos, comandas e cadastro de cliente. Não abre nem fecha caixa.',
    icon: 'cart',
    permissions: [
      'store.sales.view', 'store.sales.create',
      'store.quotes.view', 'store.quotes.create', 'store.quotes.edit',
      'commercial.products.search', 'commercial.products.view',
      'commercial.customers.view', 'commercial.customers.create', 'commercial.customers.edit',
      'comandas.view', 'comandas.manage',
    ],
  },
  {
    slug: 'caixa',
    name: 'Caixa',
    description: 'Opera o PDV e o caixa: abre, sangra, fecha e emite a nota do consumidor.',
    icon: 'wallet',
    permissions: [
      'store.sales.view', 'store.sales.create',
      'finance.cash.view', 'finance.cash.open', 'finance.cash.close', 'finance.cash.move',
      'finance.paymethods.view',
      'commercial.products.search', 'commercial.customers.view', 'commercial.customers.create',
      'comandas.view', 'comandas.manage',
      'fiscal.documents.view', 'fiscal.emit',
    ],
  },
  {
    slug: 'estoquista',
    name: 'Estoquista',
    description: 'Cuida do catálogo e do estoque: cadastra produto, dá entrada de compra e ajusta saldo. Não altera preço de venda.',
    icon: 'package',
    permissions: [
      'commercial.products.view', 'commercial.products.search', 'commercial.products.create', 'commercial.products.edit',
      'commercial.stock.view', 'commercial.stock.move',
      'commercial.purchases.view', 'commercial.purchases.create', 'commercial.purchases.edit',
      'commercial.suppliers.view', 'commercial.suppliers.create', 'commercial.suppliers.edit',
    ],
  },
  {
    slug: 'entregador',
    name: 'Entregador',
    description: 'Só consulta o que precisa para entregar: pedidos do dia e o endereço do cliente.',
    icon: 'truck',
    permissions: ['store.sales.view', 'comandas.view', 'commercial.customers.view'],
  },
  /**
   * Papéis restritos pensados para acesso pela rede local (celular do garçom,
   * tablet fixo na cozinha) — não enxergam financeiro, caixa nem configurações.
   */
  {
    slug: 'garcom',
    name: 'Garçom',
    description: 'Trabalha só nas mesas, pelo celular: abre comanda, lança item e transfere mesa.',
    icon: 'utensils',
    permissions: ['comandas.view', 'comandas.manage', 'commercial.products.search'],
  },
  {
    slug: 'cozinha',
    name: 'Cozinha (KDS)',
    description: 'Vê o painel de produção e marca pedido como pronto. Não acessa venda nem dinheiro.',
    icon: 'chef-hat',
    permissions: ['foodservice.kitchen.view', 'foodservice.kitchen.manage'],
  },
  /**
   * Propositalmente vazio: é o cargo-base para quem quer montar um perfil do zero,
   * e serve de "nenhum acesso" enquanto o dono decide o que liberar. A tela de cargos
   * diz isso na cara para ninguém achar que está quebrado.
   */
  {
    slug: 'operador',
    name: 'Operador',
    description: 'Começa sem nenhuma permissão, de propósito: use como base para montar um cargo do zero.',
    icon: 'key-round',
    permissions: [],
  },
];

export const ROLE_PRESET_BY_SLUG = new Map(ROLE_PRESETS.map((p) => [p.slug, p]));
