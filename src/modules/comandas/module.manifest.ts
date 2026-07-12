import type { ModuleManifest } from '../../core/modules/types';

const manifest: ModuleManifest = {
  id: 'comandas', name: 'Comandas & Mesas', version: '1.0.0', requiresCore: '>=0.1.0',
  permissions: [
    { key: 'comandas.view', description: 'Visualizar mesas e comandas' },
    { key: 'comandas.manage', description: 'Abrir, adicionar itens, transferir, dividir, unir e fechar comandas' },
    { key: 'comandas.tables.manage', description: 'Cadastrar/editar mesas' },
  ],
  capabilities: [{ key: 'comandas.mesas', description: 'Mesas e comandas — pre-venda que vira venda normal ao fechar' }],
  routes: './routes', pages: './pages', views: './views', migrations: './migrations',
  menu: [{ label: 'Mesas', href: '/app/comandas/mesas', permission: 'comandas.view', description: 'Mesas e comandas abertas.', icon: 'utensils' }],
  syncTables: [
    { table: 'store_tables' },
    { table: 'comandas', foreignKeys: { table_id: 'store_tables', customer_id: 'customers', sale_id: 'sales' }, excludeColumns: ['opened_by'] },
    { table: 'comanda_items', foreignKeys: { comanda_id: 'comandas', product_id: 'products' }, excludeColumns: ['added_by'] },
  ],
};

export default manifest;
