/**
 * Esqueleto do auto-updater (Fase 0).
 * O app e cada módulo atualizam separadamente (KIVO_PLANO.md §1.5).
 * Implementação real virá com o servidor de atualizações (Fase 6).
 */
export interface UpdateInfo {
  available: boolean;
  current: string;
  latest?: string;
}

export async function checkAppUpdates(): Promise<UpdateInfo> {
  // TODO: consultar servidor de updates (electron-updater) quando existir.
  return { available: false, current: '0.1.0' };
}

export async function checkModuleUpdates(): Promise<Record<string, UpdateInfo>> {
  // TODO: comparar versão de cada manifesto com o catálogo remoto de módulos.
  return {};
}
