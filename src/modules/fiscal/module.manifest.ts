import type { ModuleManifest } from '../../core/modules/types';

/**
 * Módulo fiscal — emissão de NFC-e (modelo 65) a partir do PDV.
 *
 * Nasce DESLIGADO: a capability `fiscal.nfce` entra com `enabled=0` (padrão da tabela) e
 * o item de menu declara `capability`, então nada aparece até o lojista ativar em
 * Configurações → Recursos. Emitir documento fiscal errado tem consequência legal — o
 * caminho é opt-in consciente, não descoberta por acidente.
 *
 * `fiscal_documents` NÃO entra em `syncTables`: documento fiscal é arquivo do
 * contribuinte naquela máquina, e a numeração por série/ambiente não sobrevive a uma
 * resolução de conflito last-write-wins.
 */
const manifest: ModuleManifest = {
  id: 'fiscal',
  name: 'Fiscal (notas fiscais)',
  version: '0.1.0',
  requiresCore: '>=0.1.0',
  dependsOn: ['commercial', 'store'],
  permissions: [
    { key: 'fiscal.config.view', description: 'Visualizar a configuração fiscal' },
    { key: 'fiscal.config.edit', description: 'Configurar emissão de nota fiscal (certificado, série, ambiente)' },
    { key: 'fiscal.documents.view', description: 'Consultar notas fiscais emitidas e a fila de envio' },
    { key: 'fiscal.emit', description: 'Emitir nota fiscal manualmente' },
    { key: 'fiscal.cancel', description: 'Cancelar nota fiscal autorizada' },
  ],
  capabilities: [
    {
      key: 'fiscal.nfce',
      description: 'Nota fiscal do consumidor (NFC-e)',
      beta: true,
    },
  ],
  routes: './routes',
  pages: './pages',
  views: './views',
  migrations: './migrations',
  setup: './setup',
  menu: [
    {
      label: 'Notas Fiscais',
      href: '/app/fiscal/notas',
      permission: 'fiscal.documents.view',
      capability: 'fiscal.nfce',
      description: 'Notas emitidas, fila de envio e configuração.',
      icon: 'file-text',
    },
  ],
};

export default manifest;
