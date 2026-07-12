import type { ModuleManifest } from '../../core/modules/types';

const manifest: ModuleManifest = {
  id: 'dre',
  name: 'DRE (Demonstrativo de Resultado)',
  version: '1.0.0',
  requiresCore: '>=0.1.0',
  permissions: [
    { key: 'dre.view', description: 'Visualizar relatório de DRE e categorias' },
    { key: 'dre.categories.edit', description: 'Cadastrar/editar categorias e ajustes percentuais do DRE' },
  ],
  routes: './routes',
  pages: './pages',
  views: './views',
  migrations: './migrations',
  menu: [
    { label: 'DRE', href: '/app/dre/relatorio', permission: 'dre.view', description: 'Demonstrativo de Resultado do Exercício, por categoria.', icon: 'chart-column-stacked' },
  ],
  // dre_categories é configuração de negócio (não por máquina, ao contrário de payment_methods)
  // — todas as filiais/computadores da empresa devem enxergar as mesmas categorias e ajustes.
  syncTables: [
    { table: 'dre_categories' },
  ],
};

export default manifest;
