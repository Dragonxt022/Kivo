import { createHash } from 'node:crypto';
import os from 'node:os';
import { getSqlite } from '../database/connection';
import { getCloudServerUrl } from '../config/cloud';

/**
 * Licenciamento base (KATSU_PLANO.md §7): Machine ID + Empresa UUID + License Key.
 * Validação real contra o servidor virá na Fase 6; aqui fica o contrato local
 * com tolerância offline configurável (não trava operação sem internet).
 */

export type LicenseStatus = 'valida' | 'tolerancia' | 'expirada' | 'sem_licenca';

export interface LicenseInfo {
  status: LicenseStatus;
  machineId: string;
  companyUuid: string | null;
  plan: string | null;
  validUntil: string | null;
  lastValidatedAt: string | null;
  offlineGraceDays: number;
  daysRemaining: number | null;
  supportPhone: string | null;
  supportEmail: string | null;
  message: string;
}

/**
 * ID estável desta máquina (não é segredo; identifica a instalação).
 * `KATSU_MACHINE_ID` permite forçar um valor (testes com múltiplas "máquinas" no mesmo
 * hardware; VMs clonadas de um template que precisem de identidade distinta).
 */
export function machineId(): string {
  if (process.env.KATSU_MACHINE_ID) return process.env.KATSU_MACHINE_ID;
  const raw = [os.hostname(), os.platform(), os.arch(), os.cpus()[0]?.model ?? ''].join('|');
  return createHash('sha256').update(raw).digest('hex').slice(0, 32);
}

/**
 * `datetime('now')` do SQLite grava UTC como `YYYY-MM-DD HH:MM:SS` (sem `Z`/offset).
 * `new Date(...)` do V8 interpreta essa forma (sem `T`) como horário LOCAL, não UTC —
 * sem isso, `daysRemaining`/expiração ficam deslocados pelo fuso da máquina.
 */
function parseSqliteUtc(s: string): number {
  return new Date(`${s}Z`).getTime();
}

function getRow() {
  return getSqlite().prepare('SELECT * FROM license LIMIT 1').get() as
    | {
        id: number;
        machine_id: string;
        company_uuid: string | null;
        license_key: string | null;
        plan: string | null;
        modules_json: string | null;
        valid_until: string | null;
        last_validated_at: string | null;
        offline_grace_days: number;
        support_phone: string | null;
        support_email: string | null;
      }
    | undefined;
}

/** Garante que a linha da licença existe (criada no boot). */
export function ensureLicenseRow(): void {
  if (!getRow()) {
    getSqlite()
      .prepare('INSERT INTO license (machine_id) VALUES (?)')
      .run(machineId());
  }
}

export function setLicense(companyUuid: string, licenseKey: string, plan?: string, validUntil?: string): void {
  ensureLicenseRow();
  getSqlite()
    .prepare(
      `UPDATE license SET company_uuid = ?, license_key = ?, plan = COALESCE(?, plan),
       valid_until = COALESCE(?, valid_until), last_validated_at = datetime('now'), updated_at = datetime('now')`,
    )
    .run(companyUuid, licenseKey, plan ?? null, validUntil ?? null);
}

/** Credenciais usadas pelo motor de sync (Fase 6a) para autenticar no cloud/. */
export function getLicenseCredentials(): { companyUuid: string | null; licenseKey: string | null } {
  const row = getRow();
  return { companyUuid: row?.company_uuid ?? null, licenseKey: row?.license_key ?? null };
}

/**
 * Módulos habilitados pelo plano contratado (Fase 6b). `null` = sem restrição
 * (fail-open): modo desenvolvimento (sem licença configurada) ou licença configurada
 * mas ainda sem nenhuma validação remota bem-sucedida (evita travar o primeiro boot).
 */
export function getEntitledModules(): string[] | null {
  const row = getRow();
  if (!row?.license_key || !row.company_uuid) return null;
  if (!row.modules_json) return null;
  return JSON.parse(row.modules_json) as string[];
}

export function isModuleEntitled(moduleId: string): boolean {
  const modules = getEntitledModules();
  return modules === null || modules.includes(moduleId);
}

/**
 * Validação remota (Fase 6b): confirma plano/módulos/validade contra o cloud/ e
 * atualiza o cache local. Nunca lança — falha de rede mantém o último estado
 * conhecido (mesma tolerância offline de `validateLicense`); só reflete nas rotas
 * montadas no PRÓXIMO boot (o loader lê o cache local, não chama a rede).
 */
export async function refreshLicenseFromCloud(): Promise<void> {
  const { companyUuid, licenseKey } = getLicenseCredentials();
  const url = getCloudServerUrl();
  if (!companyUuid || !licenseKey || !url) return;
  try {
    const res = await fetch(`${url.replace(/\/$/, '')}/api/license/validate`, {
      headers: { 'X-Katsu-Company': companyUuid, 'X-Katsu-License-Key': licenseKey },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return;
    const body = (await res.json()) as {
      plan: string | null;
      modules: string[] | null;
      validUntil: string | null;
      supportPhone: string | null;
      supportEmail: string | null;
    };
    ensureLicenseRow();
    getSqlite()
      .prepare(
        `UPDATE license SET plan = ?, modules_json = ?, valid_until = ?, support_phone = ?, support_email = ?,
         last_validated_at = datetime('now'), updated_at = datetime('now')`,
      )
      // `modules: null` do cloud = sem restrição configurada ainda (fail-open) — grava
      // NULL local, não '[]' (que bloquearia tudo em isModuleEntitled).
      .run(
        body.plan,
        body.modules != null ? JSON.stringify(body.modules) : null,
        body.validUntil,
        body.supportPhone ?? null,
        body.supportEmail ?? null,
      );
  } catch {
    // offline ou cloud fora do ar: mantém o cache local, não interrompe o sync.
  }
}

/** Validação local no boot. Nunca trava a operação: apenas informa o status. */
export function validateLicense(): LicenseInfo {
  ensureLicenseRow();
  const row = getRow()!;
  const daysRemaining = row.valid_until
    ? Math.ceil((parseSqliteUtc(row.valid_until) - Date.now()) / 86_400_000)
    : null;
  const base = {
    machineId: row.machine_id,
    companyUuid: row.company_uuid,
    plan: row.plan,
    validUntil: row.valid_until,
    lastValidatedAt: row.last_validated_at,
    offlineGraceDays: row.offline_grace_days,
    daysRemaining,
    supportPhone: row.support_phone,
    supportEmail: row.support_email,
  };

  if (!row.license_key || !row.company_uuid) {
    return { ...base, status: 'sem_licenca', message: 'Instalação sem licença configurada (modo desenvolvimento).' };
  }

  const now = Date.now();
  if (row.valid_until && parseSqliteUtc(row.valid_until) < now) {
    const grace = row.last_validated_at
      ? parseSqliteUtc(row.last_validated_at) + row.offline_grace_days * 24 * 3600e3
      : 0;
    if (grace > now) {
      return { ...base, status: 'tolerancia', message: 'Licença vencida — operando em tolerância offline.' };
    }
    return { ...base, status: 'expirada', message: 'Licença expirada. Renove para continuar recebendo atualizações.' };
  }

  return { ...base, status: 'valida', message: 'Licença válida.' };
}
