import type { ModuleManifest } from '../../core/modules/types';

/**
 * Módulo nfe — importação de compras via XML de NF-e (modelo 55, versão 4.00).
 *
 * Nasce DESLIGADO: a capability `nfe.import` entra com `enabled=0` (padrão) e o item
 * de menu declara `capability`, então nada aparece até ativar em Configurações →
 * Recursos (local) ou no provisionamento da licença (nuvem). Importar nota mexe em
 * produto/fornecedor/estoque — o caminho é opt-in consciente.
 *
 * A importação gera uma compra recebida no módulo commercial (custo médio e CMV do
 * DRE usam o fluxo normal) e mantém, aqui, o documento (purchase_invoices) e os
 * vínculos produto × fornecedor (product_suppliers) para rastreabilidade e reuso.
 */
const manifest: ModuleManifest = {
  id: 'nfe',
  name: 'Importação de NF-e',
  version: '0.1.0',
  requiresCore: '>=0.1.0',
  dependsOn: ['commercial'],
  permissions: [
    { key: 'nfe.import.view', description: 'Visualizar a importação de NF-e e o histórico' },
    { key: 'nfe.import.run', description: 'Confirmar a importação de uma NF-e (grava produtos, compra e estoque)' },
  ],
  capabilities: [
    {
      key: 'nfe.import',
      description: 'Importação de NF-e (XML modelo 55)',
    },
  ],
  routes: './routes',
  pages: './pages',
  views: './views',
  migrations: './migrations',
  menu: [
    {
      label: 'Importar NF-e',
      href: '/app/nfe/importar',
      permission: 'nfe.import.view',
      capability: 'nfe.import',
      description: 'Importe produtos e compras a partir do XML da nota do fornecedor.',
      icon: 'file-text',
    },
  ],
};

export default manifest;
