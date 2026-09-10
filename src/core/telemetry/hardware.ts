/**
 * Coletor de inventário de hardware (anônimo).
 *
 * Só dado técnico — nada de nome de usuário, hostname, empresa ou caminho de arquivo.
 * A tela de hardware do painel cloud usa isso para achar padrões de máquina (placa, OS,
 * RAM) que dão problema. O que só existe no Electron (tela, GPU, versão do app) chega
 * por `overrides`, para este módulo continuar puro e testável fora do Electron.
 */
import os from 'node:os';

export interface ScreenInfo {
  width: number;
  height: number;
  scaleFactor: number;
}

export interface GpuInfo {
  status: string;
  software: boolean;
}

export interface InventoryOverrides {
  appVersion?: string | null;
  electronVersion?: string | null;
  chromeVersion?: string | null;
  nodeVersion?: string | null;
  screen?: ScreenInfo | null;
  gpu?: GpuInfo | null;
}

export interface MachineInventory {
  os: { platform: string; release: string; arch: string };
  cpu: { model: string; cores: number };
  memory: { totalGb: number; freeGb: number };
  screen: ScreenInfo | null;
  gpu: GpuInfo | null;
  versions: { app: string | null; electron: string | null; chrome: string | null; node: string };
  locale: { locale: string; timezone: string };
  collectedAt: string;
}

function roundGb(bytes: number): number {
  return Math.round((bytes / 1024 ** 3) * 10) / 10;
}

/** Rótulo curto do sistema, usado como coluna/agrupador no painel. */
export function osLabel(): string {
  return `${os.platform()} ${os.release()} (${os.arch()})`;
}

export function collectMachineInventory(overrides: InventoryOverrides = {}): MachineInventory {
  const cpus = os.cpus();
  const rt = Intl.DateTimeFormat().resolvedOptions();
  return {
    os: { platform: os.platform(), release: os.release(), arch: os.arch() },
    cpu: { model: (cpus[0]?.model ?? 'desconhecida').trim(), cores: cpus.length },
    memory: { totalGb: roundGb(os.totalmem()), freeGb: roundGb(os.freemem()) },
    screen: overrides.screen ?? null,
    gpu: overrides.gpu ?? null,
    versions: {
      app: overrides.appVersion ?? null,
      electron: overrides.electronVersion ?? null,
      chrome: overrides.chromeVersion ?? null,
      node: overrides.nodeVersion ?? process.versions.node,
    },
    locale: { locale: rt.locale, timezone: rt.timeZone },
    collectedAt: new Date().toISOString(),
  };
}
