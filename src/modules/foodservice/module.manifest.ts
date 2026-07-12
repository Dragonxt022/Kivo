import type { ModuleManifest } from '../../core/modules/types';

const manifest: ModuleManifest = {
  id: 'foodservice', name: 'Food Service (cozinha e producao)', version: '1.0.0', requiresCore: '>=0.1.0',
  permissions: [
    { key: 'foodservice.kitchen.view', description: 'Visualizar painel de cozinha' },
    { key: 'foodservice.kitchen.manage', description: 'Avancar status de itens/tickets na cozinha' },
    { key: 'foodservice.routing.manage', description: 'Definir quais produtos vao para a cozinha' },
  ],
  capabilities: [{ key: 'foodservice.cozinha', description: 'Painel de cozinha (KDS) e roteamento de produtos para producao' }],
  routes: './routes', pages: './pages', views: './views', migrations: './migrations', setup: './setup',
  menu: [{ label: 'Cozinha', href: '/app/foodservice/cozinha', permission: 'foodservice.kitchen.view', description: 'Painel de producao da cozinha.', icon: 'chef-hat' }],
  syncTables: [
    { table: 'kitchen_routing', foreignKeys: { product_id: 'products' } },
    { table: 'kitchen_tickets', children: [{ table: 'kitchen_ticket_items', parentColumn: 'ticket_id', foreignKeys: { product_id: 'products' } }] },
  ],
};

export default manifest;
