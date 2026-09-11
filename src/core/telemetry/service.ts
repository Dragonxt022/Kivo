/**
 * Telemetria do desktop: erros anônimos + inventário de hardware.
 *
 * Regras que valem o desenho:
 *  - NUNCA derruba o app: toda função engole erro (telemetria é acessório).
 *  - Sem dado pessoal: só mensagem/stack técnica e um contexto já higienizado.
 *  - Erros são agregados localmente por `fingerprint` (mesmo erro não vira mil linhas)
 *    e removidos após o envio com sucesso.
 *  - Inventário só é reenviado quando o hardware muda ou a cada 24h.
 *  - Desligável pelo lojista (`telemetria.habilitada`).
 */
import { createHash, randomUUID } from 'node:crypto';
import { getSqlite } from '../database/connection';
import { settingsRepository } from '../repositories/SettingsRepository';
import { getLicenseCredentials, machineId, hasCloudIssue } from '../license/service';
import { getCloudServerUrl } from '../config/cloud';
import { createLogger, setErrorSink } from '../logger';
import { collectMachineInventory, osLabel, type InventoryOverrides, type MachineInventory } from './hardware';

const log = createLogger('telemetria');

const SETTING_ENABLED = 'telemetria.habilitada';
const SETTING_MACHINE_HASH = 'telemetria.machine_hash';
const SETTING_MACHINE_AT = 'telemetria.machine_em';
const MACHINE_RESEND_MS = 24 * 3600e3;

export function isTelemetryEnabled(): boolean {
  try {
    return settingsRepository.getBool(SETTING_ENABLED, true);
  } catch {
    return false;
  }
}

let inventoryProvider: (() => InventoryOverrides) | null = null;
let cachedAppVersion: string | null | undefined;

/** O Electron registra aqui o que só ele sabe (tela, GPU, versões). */
export function registerInventoryProvider(fn: () => InventoryOverrides): void {
  inventoryProvider = fn;
  cachedAppVersion = undefined;
}

/** Inventário atual, com os dados que o Electron registrou (tela/GPU/versões). */
export function getMachineInventory(): MachineInventory {
  return collectMachineInventory(inventoryProvider?.() ?? {});
}

function appVersion(): string | null {
  if (cachedAppVersion === undefined) {
    cachedAppVersion = inventoryProvider?.().appVersion ?? process.env.KIVO_APP_VERSION ?? null;
  }
  return cachedAppVersion;
}

/** Contexto vira JSON de uma linha, cortado — nunca é para carregar dado pessoal. */
function scrub(context: unknown): string | null {
  if (context === undefined || context === null) return null;
  const value = context instanceof Error ? { erro: context.message } : context;
  try {
    const s = JSON.stringify(value);
    return s.length > 8000 ? s.slice(0, 8000) : s;
  } catch {
    return null;
  }
}

function stackOf(context: unknown): string | undefined {
  if (context instanceof Error) return context.stack;
  if (context && typeof context === 'object' && 'stack' in context) {
    const s = (context as { stack?: unknown }).stack;
    if (typeof s === 'string') return s;
  }
  return undefined;
}

/** Assinatura estável do erro: escopo + mensagem + as primeiras linhas da stack. */
function fingerprintOf(scope: string, message: string, stack?: string): string {
  const frames = (stack ?? '').split('\n').slice(0, 5).join('\n');
  return createHash('sha256').update(`${scope}|${message}|${frames}`).digest('hex').slice(0, 40);
}

export function recordError(scope: string, message: string, context?: unknown, level: 'error' | 'warn' = 'error'): void {
  if (!isTelemetryEnabled()) return;
  try {
    const stack = stackOf(context);
    const fp = fingerprintOf(scope, message, stack);
    getSqlite()
      .prepare(
        `INSERT INTO telemetry_errors (fingerprint, scope, level, message, stack, context, app_version, os, uuid)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(fingerprint) DO UPDATE SET
           occurrences = occurrences + 1,
           last_seen_at = datetime('now'),
           message = excluded.message,
           stack = excluded.stack,
           context = excluded.context`,
      )
      .run(
        fp, scope, level, message.slice(0, 4000), stack?.slice(0, 20_000) ?? null,
        scrub(context), appVersion(), osLabel(), randomUUID(),
      );
  } catch {
    // Telemetria nunca pode derrubar o app — inclusive se a tabela ainda não existir.
  }
}

function authHeaders(companyUuid: string, licenseKey: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'X-Kivo-Company': companyUuid,
    'X-Kivo-License-Key': licenseKey,
    'X-Kivo-Machine-Id': machineId(),
  };
}

function safeParse(s: unknown): unknown {
  if (typeof s !== 'string') return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

async function sendErrors(base: string, companyUuid: string, licenseKey: string): Promise<void> {
  const db = getSqlite();
  const rows = db
    .prepare('SELECT * FROM telemetry_errors ORDER BY id LIMIT 50')
    .all() as Record<string, unknown>[];
  if (!rows.length) return;

  const errors = rows.map((r) => ({
    fingerprint: r.fingerprint,
    scope: r.scope,
    level: r.level,
    message: r.message,
    stack: r.stack,
    context: safeParse(r.context),
    appVersion: r.app_version,
    os: r.os,
    occurrences: r.occurrences,
    firstSeenAt: r.first_seen_at,
    lastSeenAt: r.last_seen_at,
  }));

  const res = await fetch(`${base}/api/telemetry/errors`, {
    method: 'POST',
    headers: authHeaders(companyUuid, licenseKey),
    body: JSON.stringify({ errors }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`envio de erros falhou: ${res.status}`);

  const ids = rows.map((r) => r.id);
  db.prepare(`DELETE FROM telemetry_errors WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids);
}

async function sendMachine(base: string, companyUuid: string, licenseKey: string): Promise<void> {
  const inv = collectMachineInventory(inventoryProvider?.() ?? {});
  const hash = createHash('sha256')
    .update(JSON.stringify({ os: inv.os, cpu: inv.cpu, memory: inv.memory, screen: inv.screen, gpu: inv.gpu, versions: inv.versions }))
    .digest('hex');
  const prevHash = settingsRepository.get(SETTING_MACHINE_HASH);
  const prevAt = settingsRepository.get(SETTING_MACHINE_AT);
  const recent = prevAt ? Date.now() - new Date(prevAt).getTime() < MACHINE_RESEND_MS : false;
  if (prevHash === hash && recent) return;

  const res = await fetch(`${base}/api/telemetry/machine`, {
    method: 'POST',
    headers: authHeaders(companyUuid, licenseKey),
    body: JSON.stringify({
      data: inv,
      os: osLabel(),
      cpu: inv.cpu.model,
      ramGb: inv.memory.totalGb,
      appVersion: inv.versions.app,
    }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`envio de inventário falhou: ${res.status}`);
  settingsRepository.set(SETTING_MACHINE_HASH, hash);
  settingsRepository.set(SETTING_MACHINE_AT, new Date().toISOString());
}

let flushing = false;

/** Envia erros pendentes + inventário. Best-effort: nunca lança. */
export async function flushTelemetry(): Promise<void> {
  if (!isTelemetryEnabled() || flushing) return;
  // Empresa já recusada pelo servidor (excluída/desativada ou chave trocada): insistir só
  // geraria 401 a cada ciclo. O aviso já está na tela de licença; o próximo `refresh`
  // bem-sucedido (empresa restaurada) limpa o marcador e a telemetria volta sozinha.
  if (hasCloudIssue()) return;
  const { companyUuid, licenseKey } = getLicenseCredentials();
  const base = getCloudServerUrl();
  if (!companyUuid || !licenseKey || !base) return;
  flushing = true;
  try {
    await sendErrors(base.replace(/\/$/, ''), companyUuid, licenseKey);
    await sendMachine(base.replace(/\/$/, ''), companyUuid, licenseKey);
  } catch (e) {
    log.warn('falha ao enviar telemetria (tentará de novo no próximo ciclo)', e);
  } finally {
    flushing = false;
  }
}

let installed = false;

/** Liga o sink do logger e marca a telemetria como instalada. Idempotente. */
export function installTelemetry(): void {
  if (installed) return;
  installed = true;
  setErrorSink((scope, message, context) => recordError(scope, message, context));
}
