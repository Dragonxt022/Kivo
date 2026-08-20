/**
 * Estado da atualização do app, compartilhado entre o processo principal do Electron
 * (quem fala com o `electron-updater`) e a API HTTP que a tela de Configurações consome.
 *
 * Por que um módulo com estado em memória, e não IPC pelo preload: a interface do Kivo
 * não é uma renderer comum — é uma página servida pelo Express local, a mesma que o
 * celular do garçom abre pela rede. Nada nela pode depender de `window.electron`. Como o
 * servidor roda DENTRO do processo principal (ver electron/main.ts), um singleton de
 * módulo já é o canal entre os dois lados, sem serialização nem ponte nova.
 *
 * O Electron registra um "driver" aqui no boot; fora dele (dev, testes) o driver não
 * existe e tudo responde `suportado: false` com o motivo — a tela explica em vez de
 * oferecer um botão que não faria nada.
 */

import fs from 'node:fs';
import path from 'node:path';

export type UpdateStatus =
  /** Nada em andamento; nenhuma versão nova conhecida. */
  | 'ocioso'
  | 'verificando'
  | 'disponivel'
  | 'baixando'
  | 'baixado'
  | 'erro';

export interface UpdateProgress {
  percent: number;
  transferido: number;
  total: number;
  bytesPorSegundo: number;
}

export interface UpdateState {
  /** Falso em dev e em plano sem atualização automática — `motivo` diz qual dos dois. */
  suportado: boolean;
  motivo: string | null;
  status: UpdateStatus;
  versaoAtual: string;
  versaoDisponivel: string | null;
  notas: string | null;
  progresso: UpdateProgress | null;
  erro: string | null;
  /** ISO da última verificação concluída (com ou sem novidade). */
  verificadoEm: string | null;
}

export interface UpdaterDriver {
  verificar(): Promise<void>;
  baixar(): Promise<void>;
  instalar(): void;
}

/**
 * Versão instalada quando o Electron ainda não se apresentou (dev, testes). Lê o
 * package.json que o electron-builder copia junto do `dist/` — mesmo arquivo de onde
 * `app.getVersion()` tira o número, então os dois nunca divergem.
 */
function versaoDoPacote(): string {
  try {
    // Lido do disco em vez de `import`/`require` do JSON: o compilado vive em
    // dist/core/updater/, e o package.json fica na raiz do app (o electron-builder o
    // copia para junto de dist/ — ver "files" em package.json).
    const raw = fs.readFileSync(path.resolve(__dirname, '..', '..', '..', 'package.json'), 'utf8');
    return (JSON.parse(raw) as { version?: string }).version ?? '—';
  } catch {
    return '—';
  }
}

let driver: UpdaterDriver | null = null;

let state: UpdateState = {
  suportado: false,
  motivo: 'Atualização automática indisponível nesta execução.',
  status: 'ocioso',
  versaoAtual: versaoDoPacote(),
  versaoDisponivel: null,
  notas: null,
  progresso: null,
  erro: null,
  verificadoEm: null,
};

export function getUpdateState(): UpdateState {
  return { ...state, progresso: state.progresso ? { ...state.progresso } : null };
}

export function patchUpdateState(patch: Partial<UpdateState>): UpdateState {
  state = { ...state, ...patch };
  return getUpdateState();
}

/** Chamado só por electron/main.ts, depois de decidir que o auto-update vale nesta máquina. */
export function registrarUpdaterDriver(d: UpdaterDriver): void {
  driver = d;
}

type Acao = { ok: true } | { ok: false; error: string };

function exigirDriver(): Acao {
  if (!driver || !state.suportado) {
    return { ok: false, error: state.motivo ?? 'Atualização automática indisponível nesta instalação.' };
  }
  return { ok: true };
}

export async function verificarAtualizacao(): Promise<Acao> {
  const guarda = exigirDriver();
  if (!guarda.ok) return guarda;
  // Verificar durante um download em andamento cancelaria o que já baixou.
  if (state.status === 'verificando' || state.status === 'baixando') return { ok: true };
  patchUpdateState({ status: 'verificando', erro: null });
  try {
    await driver!.verificar();
    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    patchUpdateState({ status: 'erro', erro: msg });
    return { ok: false, error: msg };
  }
}

export async function baixarAtualizacao(): Promise<Acao> {
  const guarda = exigirDriver();
  if (!guarda.ok) return guarda;
  if (state.status === 'baixando') return { ok: true };
  if (state.status === 'baixado') return { ok: true };
  if (!state.versaoDisponivel) {
    return { ok: false, error: 'Nenhuma atualização disponível para baixar. Verifique primeiro.' };
  }
  patchUpdateState({ status: 'baixando', erro: null, progresso: { percent: 0, transferido: 0, total: 0, bytesPorSegundo: 0 } });
  try {
    await driver!.baixar();
    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    patchUpdateState({ status: 'erro', erro: msg });
    return { ok: false, error: msg };
  }
}

/**
 * Não retorna: o app é encerrado para o instalador rodar. Quem chama precisa ter
 * respondido ao HTTP antes (ver updater/routes.ts).
 */
export function instalarAtualizacao(): Acao {
  const guarda = exigirDriver();
  if (!guarda.ok) return guarda;
  if (state.status !== 'baixado') {
    return { ok: false, error: 'A atualização ainda não terminou de baixar.' };
  }
  driver!.instalar();
  return { ok: true };
}
