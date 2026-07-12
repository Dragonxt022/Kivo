import type { ModuleManifest } from '../../core/modules/types';

const manifest: ModuleManifest = {
  id: 'commercial',
  name: 'Comercial (cadastros e estoque)',
  version: '1.0.0',
  requiresCore: '>=0.1.0',
  permissions: [
    { key: 'commercial.customers.view', description: 'Visualizar clientes' },
    { key: 'commercial.customers.create', description: 'Criar clientes' },
    { key: 'commercial.customers.edit', description: 'Editar clientes' },
    { key: 'commercial.customers.delete', description: 'Excluir clientes' },
    { key: 'commercial.suppliers.view', description: 'Visualizar fornecedores' },
    { key: 'commercial.suppliers.create', description: 'Criar fornecedores' },
    { key: 'commercial.suppliers.edit', description: 'Editar fornecedores' },
    { key: 'commercial.suppliers.delete', description: 'Excluir fornecedores' },
    { key: 'commercial.products.view', description: 'Visualizar produtos' },
    { key: 'commercial.products.create', description: 'Criar produtos' },
    { key: 'commercial.products.edit', description: 'Editar produtos (exceto preço)' },
    { key: 'commercial.products.delete', description: 'Excluir produtos' },
    { key: 'commercial.products.price', description: 'Alterar preço de produtos' },
    { key: 'commercial.pricelists.view', description: 'Visualizar listas de preço' },
    { key: 'commercial.pricelists.manage', description: 'Criar, editar e excluir listas de preço e seus itens' },
    { key: 'commercial.stock.view', description: 'Visualizar estoque e movimentações' },
    { key: 'commercial.stock.move', description: 'Movimentar estoque (entrada/saída/ajuste)' },
    { key: 'commercial.purchases.view', description: 'Visualizar compras' },
    { key: 'commercial.purchases.create', description: 'Registrar compras' },
    { key: 'commercial.purchases.edit', description: 'Editar dados da compra (fornecedor, observações)' },
    { key: 'commercial.purchases.cancel', description: 'Cancelar compra (reverte estoque)' },
    { key: 'commercial.customers.creditgrant', description: 'Conceder crédito de troca ao cliente' },
    { key: 'commercial.agreements.view', description: 'Visualizar empresas conveniadas' },
    { key: 'commercial.agreements.create', description: 'Criar empresas conveniadas' },
    { key: 'commercial.agreements.edit', description: 'Editar empresas conveniadas' },
    { key: 'commercial.agreements.delete', description: 'Excluir empresas conveniadas' },
    { key: 'commercial.products.variants.manage', description: 'Gerenciar variantes de produto' },
    { key: 'commercial.products.complements.manage', description: 'Gerenciar grupos de complementos/opcionais' },
  ],
  capabilities: [
    { key: 'commercial.variantes', description: 'Produtos com variantes (tamanho, cor, etc.)' },
    { key: 'commercial.complementos', description: 'Grupos de complementos/opcionais por produto, com seleção no PDV' },
  ],
  routes: './routes',
  pages: './pages',
  views: './views',
  migrations: './migrations',
  setup: './setup',
  menu: [
    { label: 'Clientes', href: '/app/commercial/clientes', permission: 'commercial.customers.view', description: 'Cadastro de clientes.', icon: 'users' },
    { label: 'Fornecedores', href: '/app/commercial/fornecedores', permission: 'commercial.suppliers.view', description: 'Cadastro de fornecedores.', icon: 'truck' },
    { label: 'Produtos', href: '/app/commercial/produtos', permission: 'commercial.products.view', description: 'Catálogo, preços e estoque.', icon: 'package' },
    { label: 'Listas de preço', href: '/app/commercial/listas-de-preco', permission: 'commercial.pricelists.view', description: 'Atacado, varejo, faixas por quantidade e listas por cliente.', icon: 'dollar-sign' },
    { label: 'Compras', href: '/app/commercial/compras', permission: 'commercial.purchases.view', description: 'Recebimento de mercadoria e custos.', icon: 'bag' },
  ],
  // Fase 6a — motor de sincronização (KATSU_PLANO.md §6).
  // stock_qty é derivado do ledger stock_movements — nunca viaja na rede (ver stock.ts/setup.ts).
  // Colunas que referenciam `users` (user_id) ficam fora do payload: usuários não sincronizam
  // nesta sub-fase (KATSU_PLANO.md, Fase 6a "fora de escopo").
  syncTables: [
    { table: 'categories', foreignKeys: { parent_id: 'categories' } },
    {
      table: 'products', foreignKeys: { category_id: 'categories', parent_product_id: 'products' },
      // image_url: caminho local (/uploads/products/…) ou URL do banco de imagens do
      // Katsu Cloud — não sincroniza entre máquinas nesta fase (arquivo local só existe
      // na máquina onde a imagem foi definida). Ver src/core/catalog/.
      excludeColumns: ['stock_qty', 'image_url'],
    },
    { table: 'product_attributes' },
    { table: 'product_attribute_values', foreignKeys: { attribute_id: 'product_attributes' } },
    {
      table: 'product_variant_values',
      foreignKeys: { product_id: 'products', attribute_id: 'product_attributes', attribute_value_id: 'product_attribute_values' },
    },
    {
      table: 'customers',
      foreignKeys: { price_list_id: 'price_lists', agreement_company_id: 'agreement_companies' },
      excludeColumns: ['store_credit_cents', 'loyalty_points'],
    },
    { table: 'suppliers' },
    { table: 'agreement_companies' },
    {
      table: 'customer_credit_movements',
      excludeColumns: ['balance_after', 'ref_id', 'user_id'],
      ledgerFor: { parentTable: 'customers', parentColumn: 'customer_id' },
    },
    {
      table: 'loyalty_point_movements',
      excludeColumns: ['balance_after', 'ref_id', 'user_id'],
      ledgerFor: { parentTable: 'customers', parentColumn: 'customer_id' },
    },
    {
      table: 'purchases',
      foreignKeys: { supplier_id: 'suppliers' },
      children: [{ table: 'purchase_items', parentColumn: 'purchase_id', foreignKeys: { product_id: 'products' } }],
    },
    {
      table: 'stock_movements',
      excludeColumns: ['balance_after', 'ref_id', 'user_id'],
      ledgerFor: { parentTable: 'products', parentColumn: 'product_id' },
    },
    {
      table: 'price_lists',
      children: [{ table: 'price_list_items', parentColumn: 'price_list_id', foreignKeys: { product_id: 'products' } }],
    },
    {
      table: 'complement_groups',
      children: [{
        table: 'complement_group_items', parentColumn: 'group_id',
        foreignKeys: { product_id: 'products' },
      }],
    },
    {
      table: 'product_complement_groups',
      foreignKeys: { product_id: 'products', group_id: 'complement_groups' },
    },
  ],
};

export default manifest;
