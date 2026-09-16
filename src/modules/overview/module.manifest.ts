import type { ModuleManifest } from '../../core/modules/types';

/**
 * Módulo overview — Painel de Controle: visão geral (KPIs) + relatórios de estoque e de
 * caixas, com exportação CSV.
 *
 * `alwaysEnabled: true` = módulo de SISTEMA: não depende do plano contratado nem de ligar
 * um recurso — nasce ativo em toda instalação. O acesso é controlado por permissão
 * (`overview.view`), concedida ao Administrador e ao Gerente.
 *
 * Só LÊ: agrega o que os outros módulos já gravaram (produtos/estoque, caixas, contas).
 * Nada de escrita — quem altera continua nas telas de cada módulo.
 */
const manifest: ModuleManifest = {
  id: 'overview',
  name: 'Painel de Controle',
  version: '0.1.0',
  requiresCore: '>=0.1.0',
  alwaysEnabled: true,
  dependsOn: ['commercial', 'finance', 'store'],
  permissions: [
    { key: 'overview.view', description: 'Visualizar o Painel de Controle (KPIs, estoque e caixas) e exportar os relatórios' },
  ],
  routes: './routes',
  pages: './pages',
  views: './views',
  menu: [
    {
      label: 'Painel',
      href: '/app/overview',
      permission: 'overview.view',
      description: 'Visão geral: caixa, vendas, estoque e contas a vencer.',
      icon: 'chart',
    },
  ],
};

export default manifest;
