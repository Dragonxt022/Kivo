import type { ModuleManifest } from '../../core/modules/types';

/**
 * Integração com a API pública do Mais Delivery.
 *
 * A API tem um único endpoint POST e opera por `nrOperacao`. O módulo lê pedidos do
 * marketplace, permite alterar a situação lá fora e tem a PONTE DE COZINHA
 * (`kitchenBridge.ts`): "Enviar p/ cozinha" cria um ticket de produção no KDS
 * (source_type='delivery', itens textuais — sem loja de catálogo/venda do Kuruk) e
 * sincroniza a etapa da cozinha com a situação do pedido no marketplace.
 *
 * As credenciais (Access token e Basic Auth) podem ficar no cofre local
 * (`core/secrets`) ou no painel cloud; o restante da configuração (ids e sandbox)
 * usa a tabela `settings`.
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
  setup: './setup',
  menu: [
    {
      label: 'Pedidos',
      href: '/app/maisdelivery/pedidos',
      permission: 'maisdelivery.orders.view',
      description: 'Pedidos recebidos pelo Mais Delivery.',
      icon: 'truck',
    },
  ],
};

export default manifest;
