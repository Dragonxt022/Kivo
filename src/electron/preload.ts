import { contextBridge, ipcRenderer } from 'electron';

/**
 * Ponte mínima entre a janela e o processo principal.
 *
 * O renderer roda com `nodeIntegration: false` e `sandbox: true`: nada de `require`,
 * `fs` ou acesso direto ao banco. Só o que está nesta lista atravessa — e cada canal
 * valida o próprio payload em `electron/hardware.ts`.
 */
contextBridge.exposeInMainWorld('kivo', {
  version: '0.1.0',
  /**
   * Controles da janela que a página usa na abertura personalizada (ir direto para um
   * módulo em tela cheia). Sem isto, a Fullscreen API do Chromium exigiria um gesto do
   * usuário e a preferência não funcionaria no primeiro carregamento do Electron.
   */
  window: {
    setFullscreen: (enabled: boolean) => ipcRenderer.invoke('window:set-fullscreen', enabled === true),
  },
  hardware: {
    /** Lista as portas seriais (para o seletor de balança em Configurações). */
    listPorts: () => ipcRenderer.invoke('hardware:ports'),
    /**
     * Lê o peso atual da balança; devolve { ok, kg } ou { ok: false, error }.
     * `config` é usado só pelo "Testar leitura" (valores ainda não salvos).
     */
    readScale: (config?: { path: string; baudRate: number; protocol: string }) =>
      ipcRenderer.invoke('hardware:scale:read', config),
    /** Imprime texto pré-formatado em ESC/POS. `config` idem, para o teste. */
    print: (payload: {
      text: string;
      openDrawer?: boolean;
      config?: { type: string; interface: string; width: number };
    }) => ipcRenderer.invoke('hardware:printer:print', payload),
  },
});
