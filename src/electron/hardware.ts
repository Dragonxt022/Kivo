import { ipcMain } from 'electron';
import { getMachinePrefs, type PrinterPrefs, type ScalePrefs } from '../core/config/machinePrefs';
import { parseScaleWeight } from '../shared/scale';
import { createLogger } from '../core/logger';

/**
 * Ponte de hardware do PDV: balança serial e impressora térmica ESC/POS.
 *
 * As duas bibliotecas são `optionalDependencies` de propósito. `serialport` carrega
 * binário nativo e pode não ter build para uma arquitetura; `node-thermal-printer` é JS
 * puro, mas também não deve impedir o Kuruk de abrir se faltar. O `require` é feito
 * dentro de try/catch e a tela recebe um erro explicando o que instalar — em vez de o
 * boot morrer com MODULE_NOT_FOUND.
 *
 * Nada aqui roda no renderer: o preload expõe só três chamadas (listar portas, ler peso,
 * imprimir texto). O renderer nunca recebe acesso a `require`/`fs`.
 */

const log = createLogger('hardware');

// ─── Tipos mínimos das bibliotecas opcionais ────────────────────────────────

interface SerialPortLike {
  on(event: 'data', cb: (data: Buffer) => void): void;
  on(event: 'error', cb: (err: Error) => void): void;
  open(cb: (err?: Error | null) => void): void;
  close(cb?: () => void): void;
  write(data: string | Buffer, cb?: (err?: Error | null) => void): void;
  destroy?(): void;
}

interface SerialPortModule {
  SerialPort: new (opts: {
    path: string;
    baudRate: number;
    autoOpen: boolean;
    dataBits?: number;
    stopBits?: number;
    parity?: string;
  }) => SerialPortLike;
}

interface ThermalPrinterLike {
  println(text: string): void;
  cut(): void;
  openCashDrawer(): void;
  execute(): Promise<void>;
}

interface ThermalModule {
  printer: new (config: {
    type: string;
    interface: string;
    characterSet: string;
    width: number;
    removeSpecialCharacters?: boolean;
  }) => ThermalPrinterLike;
  types: Record<string, string>;
  characterSet: Record<string, string>;
}

function loadSerial(): SerialPortModule | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('serialport') as SerialPortModule;
  } catch (e) {
    log.warn(
      'serialport indisponível; balança desligada',
      e instanceof Error ? e.message : String(e),
    );
    return null;
  }
}

function loadThermal(): ThermalModule | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('node-thermal-printer') as ThermalModule;
  } catch (e) {
    log.warn(
      'node-thermal-printer indisponível; impressão ESC/POS desligada',
      e instanceof Error ? e.message : String(e),
    );
    return null;
  }
}

// ─── Balança ────────────────────────────────────────────────────────────────

interface ScaleOverride {
  path?: unknown;
  baudRate?: unknown;
  protocol?: unknown;
}

function resolverBalanca(override?: ScaleOverride): { prefs: ScalePrefs; teste: boolean } | null {
  const salvo = getMachinePrefs().balanca;
  if (!override) return { prefs: salvo, teste: false };

  // A tela de Configurações testa os valores AINDA NÃO salvos. Sem o override, o
  // "Testar leitura" usaria a porta antiga e diria que está tudo errado.
  const path = typeof override.path === 'string' ? override.path.trim() : '';
  const baudRate = Number(override.baudRate);
  const protocol = override.protocol;
  if (!path || !Number.isFinite(baudRate) || (protocol !== 'generic' && protocol !== 'toledo')) {
    return null;
  }
  return { prefs: { enabled: true, path, baudRate, protocol }, teste: true };
}

function readScale(
  override?: ScaleOverride,
): Promise<{ ok: boolean; kg?: number; raw?: string; error?: string }> {
  const alvo = resolverBalanca(override);
  if (!alvo) return Promise.resolve({ ok: false, error: 'Configuração da balança inválida.' });
  const prefs = alvo.prefs;
  if (!prefs.enabled && !alvo.teste) {
    return Promise.resolve({
      ok: false,
      error: 'Balança desligada em Configurações › Periféricos.',
    });
  }
  const mod = loadSerial();
  if (!mod) {
    return Promise.resolve({
      ok: false,
      error: 'Módulo da balança não está instalado nesta versão do Kuruk.',
    });
  }

  return new Promise((resolve) => {
    let settled = false;
    let buffer = '';
    let port: SerialPortLike | null = null;

    const finish = (result: { ok: boolean; kg?: number; raw?: string; error?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        port?.destroy?.();
      } catch {
        /* porta já fechada */
      }
      try {
        port?.close();
      } catch {
        /* idem */
      }
      resolve(result);
    };

    const timer = setTimeout(() => {
      finish({
        ok: false,
        error: 'A balança não respondeu. Confira a porta, o cabo e se o visor está ligado.',
      });
    }, 2500);

    try {
      port = new mod.SerialPort({
        path: prefs.path,
        baudRate: prefs.baudRate,
        autoOpen: false,
        dataBits: 8,
        stopBits: 1,
        parity: 'none',
      });
    } catch (e) {
      finish({
        ok: false,
        error: 'Porta da balança inválida: ' + (e instanceof Error ? e.message : String(e)),
      });
      return;
    }

    port.on('data', (chunk) => {
      buffer += chunk.toString('ascii');
      // Mantém só o fim: alguns visores streamam continuamente e o buffer cresceria sem limite.
      if (buffer.length > 400) buffer = buffer.slice(-400);
      const kg = parseScaleWeight(buffer, prefs.protocol);
      if (kg != null) finish({ ok: true, kg, raw: buffer.trim() });
    });
    port.on('error', (err) => {
      finish({ ok: false, error: 'Erro na balança: ' + err.message });
    });

    port.open((err) => {
      if (err) {
        finish({ ok: false, error: 'Não foi possível abrir ' + prefs.path + ': ' + err.message });
        return;
      }
      // Toledo responde ao ENQ; os demais costumam transmitir sozinhos.
      try {
        port?.write(prefs.protocol === 'toledo' ? '\x05' : 'P\r\n');
      } catch {
        /* visor que não aceita comando: segue escutando */
      }
    });
  });
}

// ─── Impressora térmica ─────────────────────────────────────────────────────

interface PrinterOverride {
  type?: unknown;
  interface?: unknown;
  width?: unknown;
}

interface PrintPayload {
  text?: unknown;
  openDrawer?: unknown;
  /** Configuração da tela de teste (ainda não salva). Sem isto, vale a salva. */
  config?: PrinterOverride;
}

function truncate(line: string, cols: number): string {
  if (line.length <= cols) return line;
  return line.slice(0, Math.max(0, cols - 1)) + '…';
}

function resolverImpressora(
  override?: PrinterOverride,
): { prefs: PrinterPrefs; teste: boolean } | null {
  const salvo = getMachinePrefs().impressora;
  if (!override) return { prefs: salvo, teste: false };

  const type = String(override.type ?? '');
  const iface = String(override.interface ?? '').trim();
  const width = Number(override.width);
  if (!['epson', 'daruma', 'star', 'generic'].includes(type)) return null;
  if (!iface || iface.length > 160 || (width !== 58 && width !== 80)) return null;
  return {
    prefs: { enabled: true, type: type as PrinterPrefs['type'], interface: iface, width },
    teste: true,
  };
}

async function printEscPos(payload: PrintPayload): Promise<{ ok: boolean; error?: string }> {
  const alvo = resolverImpressora(payload.config);
  if (!alvo) return { ok: false, error: 'Configuração da impressora inválida.' };
  const prefs = alvo.prefs;
  if (!prefs.enabled && !alvo.teste) {
    return { ok: false, error: 'Impressora térmica desligada em Configurações › Periféricos.' };
  }
  const text = typeof payload.text === 'string' ? payload.text : '';
  if (!text.trim()) return { ok: false, error: 'Nada para imprimir.' };
  if (text.length > 20000) return { ok: false, error: 'Cupom grande demais para a impressora.' };

  const mod = loadThermal();
  if (!mod)
    return { ok: false, error: 'Módulo da impressora não está instalado nesta versão do Kuruk.' };

  const cols = prefs.width === 58 ? 32 : 48;
  const type = mod.types[String(prefs.type).toUpperCase()] ?? mod.types.EPSON;

  try {
    const printer = new mod.printer({
      type,
      interface: prefs.interface,
      characterSet: mod.characterSet.PC860_PORTUGUESE,
      width: cols,
      removeSpecialCharacters: true,
    });
    const lines = text.replace(/\r\n/g, '\n').split('\n');
    for (const line of lines) printer.println(truncate(line, cols));
    if (payload.openDrawer === true) printer.openCashDrawer();
    printer.cut();
    await Promise.race([
      printer.execute(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('A impressora não respondeu em 8 segundos.')), 8000),
      ),
    ]);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// ─── Registro dos canais ────────────────────────────────────────────────────

export function registerHardwareIpc(): void {
  ipcMain.handle('hardware:ports', async () => {
    const mod = loadSerial();
    if (!mod) return { ok: false, error: 'Módulo serial não instalado.', ports: [] };
    try {
      const SerialPortCtor = mod.SerialPort as unknown as {
        list?: () => Promise<{ path: string; manufacturer?: string }[]>;
      };
      const ports = (await SerialPortCtor.list?.()) ?? [];
      return {
        ok: true,
        ports: ports.map((p) => ({
          path: p.path,
          label: p.manufacturer ? p.path + ' — ' + p.manufacturer : p.path,
        })),
      };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e), ports: [] };
    }
  });

  ipcMain.handle('hardware:scale:read', (_event, override: ScaleOverride | undefined) =>
    readScale(override),
  );
  ipcMain.handle('hardware:printer:print', (_event, payload: PrintPayload) =>
    printEscPos(payload ?? {}),
  );
}

/** Usado pela tela de Configurações para saber se o Kuruk está rodando no desktop. */
export function hardwareAvailable(): boolean {
  return !!loadSerial() || !!loadThermal();
}

export type { PrinterPrefs };
