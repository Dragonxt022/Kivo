import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Preferências que valem só para ESTA máquina, guardadas num JSON ao lado do banco.
 *
 * Não vão para a tabela `settings` de propósito: ela sincroniza entre as máquinas da empresa
 * (ver `syncColumns` em core/database/schema.ts), e "modo leve" é exatamente o oposto disso —
 * o PC fraco do balcão arrastaria o notebook bom do dono junto.
 *
 * Também não vão só para o `localStorage` (onde moram tema e layout): o processo principal do
 * Electron precisa ler `modoLeve` ANTES de `app.whenReady()`, para poder desligar a aceleração
 * de vídeo, e nesse instante nem o banco foi migrado nem existe janela.
 *
 * O caminho deriva de `KIVO_DB_PATH` pelo mesmo motivo — e do mesmo jeito — que
 * `machine-id.local` em core/license/service.ts: acompanha a instalação, não o processo.
 */
export interface ScalePrefs {
  /** Liga a leitura pela porta serial no PDV. Desligado por padrão: máquina sem balança. */
  enabled: boolean;
  /** Porta do Windows/Linux, ex.: COM3 ou /dev/ttyUSB0. */
  path: string;
  baudRate: number;
  /** Protocolo do visor. `generic` espera uma linha de texto com o peso em kg. */
  protocol: 'toledo' | 'generic';
}

export interface PrinterPrefs {
  /** Liga a impressão ESC/POS direta (sem diálogo do Windows). */
  enabled: boolean;
  type: 'epson' | 'daruma' | 'star' | 'generic';
  /** `printer:NOME`, `tcp://192.168.0.10` ou `usb`. Ver node-thermal-printer. */
  interface: string;
  /** Colunas por linha: 48 para 80mm, 32 para 58mm. */
  width: 58 | 80;
}

export interface MachinePrefs {
  /** Interface sem blur/sombra/animação + GPU desligada. Ver `:root[data-lite]` em app.css. */
  modoLeve: boolean;
  /** Já rodou a detecção automática de hardware fraco — não roda de novo, para nunca desfazer a escolha manual. */
  modoLeveDetectado: boolean;
  /** Balança de checkout. Por máquina: o PDV do balcão tem, o notebook do dono não. */
  balanca: ScalePrefs;
  /** Impressora térmica não fiscal (cupom do PDV). */
  impressora: PrinterPrefs;
  /**
   * Exibe os balões de entrada rápida também para quem acessa pela rede local.
   * Desligado por padrão: sem senha, qualquer aparelho no Wi-Fi da loja entraria como
   * qualquer usuário com perfil salvo. O dono precisa ligar conscientemente.
   */
  entradaRapidaRede: boolean;
}

export const SCALE_DEFAULTS: ScalePrefs = {
  enabled: false,
  path: 'COM1',
  baudRate: 9600,
  protocol: 'generic',
};

export const PRINTER_DEFAULTS: PrinterPrefs = {
  enabled: false,
  type: 'epson',
  interface: 'printer:',
  width: 80,
};

const DEFAULTS: MachinePrefs = {
  modoLeve: false,
  modoLeveDetectado: false,
  balanca: { ...SCALE_DEFAULTS },
  impressora: { ...PRINTER_DEFAULTS },
  entradaRapidaRede: false,
};

let cache: MachinePrefs | null = null;

function prefsPath(): string {
  const dbPath = process.env.KIVO_DB_PATH ?? path.resolve(process.cwd(), 'database', 'kivo.db');
  return path.join(path.dirname(dbPath), 'machine-prefs.json');
}

export function getMachinePrefs(): MachinePrefs {
  if (cache) return cache;
  try {
    const raw = fs.readFileSync(prefsPath(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<MachinePrefs>;
    cache = {
      modoLeve: parsed.modoLeve === true,
      modoLeveDetectado: parsed.modoLeveDetectado === true,
      // Arquivo de uma versão anterior não tem estas chaves: o spread garante que a
      // máquina que já existia caia nos padrões sem perder modoLeve.
      balanca: { ...SCALE_DEFAULTS, ...(parsed.balanca ?? {}) },
      impressora: { ...PRINTER_DEFAULTS, ...(parsed.impressora ?? {}) },
      entradaRapidaRede: parsed.entradaRapidaRede === true,
    };
  } catch {
    // Arquivo ausente na primeira execução, ou ilegível: os padrões valem e o boot segue.
    cache = { ...DEFAULTS };
  }
  return cache;
}

export function setMachinePrefs(patch: Partial<MachinePrefs>): MachinePrefs {
  const atual = getMachinePrefs();
  const next = {
    ...atual,
    ...patch,
    // Merge raso perderia `baudRate`/`protocol` quando a tela mandasse só o caminho.
    balanca: { ...atual.balanca, ...(patch.balanca ?? {}) },
    impressora: { ...atual.impressora, ...(patch.impressora ?? {}) },
  };
  cache = next;
  try {
    const file = prefsPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(next, null, 2));
  } catch {
    // Sem permissão de escrita: vale nesta execução. Preferência de conforto não derruba o app.
  }
  return next;
}

/**
 * Sinais de hardware fraco disponíveis SEM esperar o Electron ficar pronto. Deliberadamente
 * conservador — ligar o modo leve numa máquina boa é um downgrade visual gratuito, então só
 * dispara em RAM ou núcleos claramente baixos. O sinal mais decisivo (GPU sem driver, que é o
 * caso que originou isto) vem depois, de `app.getGPUFeatureStatus()` em electron/main.ts.
 */
export function hardwareFraco(): boolean {
  const gib = os.totalmem() / 1024 ** 3;
  const nucleos = os.cpus()?.length ?? 1;
  return gib < 4.5 || nucleos <= 2;
}
