import type { ModuleManifest } from '../../core/modules/types';

const manifest: ModuleManifest = {
  id: 'store',
  name: 'Loja (PDV e vendas)',
  version: '1.0.0',
  requiresCore: '>=0.1.0',
  dependsOn: ['commercial', 'finance'],
  permissions: [
    { key: 'store.sales.view', description: 'Visualizar vendas' },
    { key: 'store.sales.create', description: 'Realizar vendas (PDV)' },
    { key: 'store.sales.discount', description: 'Aplicar desconto na venda' },
    { key: 'store.sales.cancel', description: 'Cancelar vendas' },
    { key: 'store.reports.view', description: 'Visualizar relatório de vendas' },
    { key: 'store.quotes.view', description: 'Visualizar orçamentos' },
    { key: 'store.quotes.create', description: 'Criar e cancelar orçamentos' },
    { key: 'store.quotes.edit', description: 'Editar orçamentos (cliente, validade, observações, desconto)' },
  ],
  routes: './routes',
  pages: './pages',
  views: './views',
  migrations: './migrations',
  setup: './setup',
  menu: [
    { label: 'PDV', href: '/app/store/pdv', permission: 'store.sales.create', description: 'Frente de caixa: vender rápido.', icon: 'cart' },
    { label: 'Vendas', href: '/app/store/vendas', permission: 'store.sales.view', description: 'Histórico e relatório do dia.', icon: 'receipt' },
    { label: 'Orçamentos', href: '/app/store/orcamentos', permission: 'store.quotes.view', description: 'Cotações com validade; converta em venda.', icon: 'clipboard' },
  ],
  // Fase 6a — motor de sincronização (KATSU_PLANO.md §6).
  // user_id/canceled_by referenciam `users`, que não sincroniza nesta sub-fase.
  syncTables: [
    {
      table: 'sales',
      foreignKeys: { customer_id: 'customers', cash_register_id: 'cash_registers', receivable_id: 'receivables' },
      excludeColumns: ['user_id', 'canceled_by'],
      children: [
        { table: 'sale_items', parentColumn: 'sale_id', foreignKeys: { product_id: 'products' } },
        {
          table: 'sale_payments',
          parentColumn: 'sale_id',
          foreignKeys: { receivable_id: 'receivables' },
          excludeColumns: ['payment_method_id'],
        },
      ],
    },
    {
      table: 'quotes',
      foreignKeys: { customer_id: 'customers', sale_id: 'sales' },
      excludeColumns: ['user_id'],
      children: [{ table: 'quote_items', parentColumn: 'quote_id', foreignKeys: { product_id: 'products' } }],
    },
  ],
};

export default manifest;
