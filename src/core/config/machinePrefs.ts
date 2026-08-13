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
export interface MachinePrefs {
  /** Interface sem blur/sombra/animação + GPU desligada. Ver `:root[data-lite]` em app.css. */
  modoLeve: boolean;
  /** Já rodou a detecção automática de hardware fraco — não roda de novo, para nunca desfazer a escolha manual. */
  modoLeveDetectado: boolean;
}

const DEFAULTS: MachinePrefs = { modoLeve: false, modoLeveDetectado: false };

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
    };
  } catch {
    // Arquivo ausente na primeira execução, ou ilegível: os padrões valem e o boot segue.
    cache = { ...DEFAULTS };
  }
  return cache;
}

export function setMachinePrefs(patch: Partial<MachinePrefs>): MachinePrefs {
  const next = { ...getMachinePrefs(), ...patch };
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
