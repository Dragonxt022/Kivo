import type { ModuleManifest } from '../../core/modules/types';

/**
 * Integração com a API pública do Mais Delivery.
 *
 * A API tem um único endpoint POST e opera por `nrOperacao`. Nesta primeira entrega
 * o módulo apenas LÊ pedidos do marketplace e permite alterar a situação do pedido
 * no Mais Delivery. Nada é gravado em vendas, comandas ou estoque do Kivo — a tela
 * é uma janela para o marketplace, com o mesmo token e Basic Auth do painel.
 *
 * As credenciais ficam no cofre local (`core/secrets`), fora do banco e do backup.
 * O restante da configuração (ids e sandbox) usa a tabela `settings`.
 */
const manifest: ModuleManifest = {
  id: 'maisdelivery',
  name: 'Mais Delivery',
  version: '0.1.0',
  requiresCore: '>=0.1.0',
  permissions: [
    { key: 'maisdelivery.orders.view', description: 'Visualizar pedidos do Mais Delivery' },
    {
      key: 'maisdelivery.orders.status',
      description: 'Alterar a situação de pedidos no Mais Delivery',
    },
    {
      key: 'maisdelivery.settings.manage',
      description: 'Configurar credenciais e testar a conexão com o Mais Delivery',
    },
  ],
  routes: './routes',
  pages: './pages',
  views: './views',
  menu: [
    {
      label: 'Pedidos',
      href: '/app/maisdelivery/pedidos',
      permission: 'maisdelivery.orders.view',
      description: 'Pedidos recebidos pelo Mais Delivery.',
      icon: 'truck',
    },
    {
      label: 'Integração',
      href: '/app/maisdelivery/configuracoes',
      permission: 'maisdelivery.settings.manage',
      description: 'Credenciais e teste de conexão com o Mais Delivery.',
      icon: 'settings',
    },
  ],
};

export default manifest;
