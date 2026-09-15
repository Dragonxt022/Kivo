import type { ModuleManifest } from '../../core/modules/types';

/**
 * Módulo labels — gerador de etiquetas de produto (código de barras + preço) em
 * folha A4, com modelos de folha no padrão Pimaco.
 *
 * Nasce DESLIGADO: a capability `labels.generator` entra com `enabled=0` (padrão) e o
 * item de menu declara `capability`, então nada aparece até ativar em Configurações →
 * Recursos (local) ou no provisionamento da licença (nuvem). Imprimir etiquetas é
 * opt-in: quem nunca usou não ganha um item de menu a mais.
 *
 * Lê o catálogo do módulo commercial (nome, preço, código de barras) e, ao imprimir,
 * preenche o código de barras dos produtos que não têm — gravando o EAN interno no
 * cadastro para a etiqueta ser escaneável no PDV (ver `ensureBarcode` em labels.ts).
 * Não cria produto nem registra syncTables: `products` já sincroniza pelo commercial.
 */
const manifest: ModuleManifest = {
  id: 'labels',
  name: 'Gerador de Etiquetas',
  version: '0.1.0',
  requiresCore: '>=0.1.0',
  dependsOn: ['commercial'],
  permissions: [
    { key: 'labels.generate', description: 'Gerar e imprimir etiquetas de produtos' },
    { key: 'labels.sheets.manage', description: 'Criar, editar e excluir modelos de folha de etiqueta' },
  ],
  capabilities: [
    { key: 'labels.generator', description: 'Gerador de etiquetas de produto (código de barras e preço) em folha A4' },
  ],
  routes: './routes',
  pages: './pages',
  views: './views',
  migrations: './migrations',
  setup: './setup',
  menu: [
    {
      label: 'Gerador de Etiquetas',
      href: '/app/labels',
      permission: 'labels.generate',
      capability: 'labels.generator',
      description: 'Imprima etiquetas de produto com código de barras e preço.',
      icon: 'tag',
    },
  ],
};

export default manifest;
