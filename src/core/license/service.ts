import { createHash, createHmac, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { machineIdSync } from 'node-machine-id';
import { getSqlite } from '../database/connection';
import { getCloudServerUrl } from '../config/cloud';
import { settingsRepository } from '../repositories/SettingsRepository';

/**
 * Licenciamento (KIVO_PLANO.md §7): Machine ID + Empresa UUID + License Key.
 * Ativação online obrigatória na primeira vez (ver activationRoutes.ts); depois disso,
 * opera offline com tolerância configurável. Reforços contra uso indevido: trava de
 * máquina (machineId real, não hostname), watermark anti-retrocesso de relógio e
 * assinatura de integridade da linha local — nenhum desses é à prova de engenharia
 * reversa do binário Electron, são barreiras contra adulteração casual (editar o
 * SQLite na mão, copiar o banco pra outra máquina, atrasar o relógio do Windows).
 */

export type LicenseStatus = 'valida' | 'tolerancia' | 'expirada' | 'sem_licenca' | 'bloqueada';

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

/** Versão atual do algoritmo de machineId — ver `reanchorMachineIdIfNeeded`. */
const MACHINE_ID_VERSION = 2;

/**
 * Não é segredo real (está no bundle do Electron, extraível com esforço) — é só um
 * "pepper" que impede que a assinatura de integridade seja recalculada por quem só
 * edita o SQLite na mão sem também descompilar o app.
 */
const INTEGRITY_PEPPER = 'kivo-license-integrity-v1-8f2c6a41';

/** Folga para diferença de fuso/NTP antes de considerar o relógio retrocedido. */
const CLOCK_TOLERANCE_MS = 5 * 60_000;

let cachedMachineId: string | null = null;

function fallbackMachineIdPath(): string {
  const dbPath = process.env.KIVO_DB_PATH ?? path.resolve(process.cwd(), 'database', 'kivo.db');
  return path.join(path.dirname(dbPath), 'machine-id.local');
}

/**
 * Último recurso se `node-machine-id` falhar (sandbox, permissão negada): um UUID
 * aleatório gerado uma vez e persistido ao lado do banco. Diferente do hash de
 * hostname/CPU antigo, pelo menos não é trivialmente forjável só trocando o hostname —
 * mas viaja junto se alguém copiar a pasta `database/` inteira.
 */
function fallbackMachineId(): string {
  const file = fallbackMachineIdPath();
  try {
    if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
  } catch {
    // segue e tenta gerar um novo
  }
  const id = randomUUID();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, id);
  } catch {
    // sem permissão de escrita: usa o valor só nesta execução (não trava o boot por isso)
  }
  return id;
}

/**
 * ID real da instalação (GUID nativo do SO via `node-machine-id`: MachineGuid do
 * registro no Windows, IOPlatformUUID no mac, /etc/machine-id no Linux) — estável
 * mesmo se o hostname mudar, ao contrário do hash de hostname/CPU usado antes.
 * `KIVO_MACHINE_ID` permite forçar um valor (testes com múltiplas "máquinas").
 */
export function machineId(): string {
  if (process.env.KIVO_MACHINE_ID) return process.env.KIVO_MACHINE_ID;
  if (cachedMachineId) return cachedMachineId;
  let raw: string;
  try {
    raw = machineIdSync();
  } catch {
    raw = fallbackMachineId();
  }
  cachedMachineId = createHash('sha256').update(raw).digest('hex').slice(0, 32);
  return cachedMachineId;
}

/**
 * `datetime('now')` do SQLite grava UTC como `YYYY-MM-DD HH:MM:SS` (sem `Z`/offset).
 * `new Date(...)` do V8 interpreta essa forma (sem `T`) como horário LOCAL, não UTC —
 * sem isso, `daysRemaining`/expiração ficam deslocados pelo fuso da máquina.
 */
function parseSqliteUtc(s: string): number {
  return new Date(`${s}Z`).getTime();
}

interface LicenseRow {
  id: number;
  machine_id: string;
  machine_id_version: number;
  company_uuid: string | null;
  license_key: string | null;
  plan: string | null;
  modules_json: string | null;
  valid_until: string | null;
  last_validated_at: string | null;
  offline_grace_days: number;
  support_phone: string | null;
  support_email: string | null;
  time_watermark: number | null;
  integrity_hmac: string | null;
  activated_at: string | null;
  device_revoked_at: string | null;
}

function getRow(): LicenseRow | undefined {
  return getSqlite().prepare('SELECT * FROM license LIMIT 1').get() as LicenseRow | undefined;
}

/** Garante que a linha da licença existe (criada no boot). */
export function ensureLicenseRow(): void {
  if (!getRow()) {
    getSqlite()
      .prepare('INSERT INTO license (machine_id, machine_id_version) VALUES (?, ?)')
      .run(machineId(), MACHINE_ID_VERSION);
  }
}

/**
 * Assinatura HMAC-SHA256 sobre os campos que não devem ser editáveis por fora do app,
 * com chave derivada da máquina atual — copiar a linha (ou o `.db` inteiro) pra outro
 * PC quebra a verificação lá, pois o `machineId()` recalculado é outro.
 */
function computeIntegrityHmac(row: Pick<LicenseRow, 'machine_id' | 'company_uuid' | 'license_key' | 'plan' | 'valid_until' | 'time_watermark'>): string {
  const key = createHash('sha256').update(`${machineId()}:${INTEGRITY_PEPPER}`).digest('hex');
  const payload = [row.machine_id, row.company_uuid ?? '', row.license_key ?? '', row.plan ?? '', row.valid_until ?? '', row.time_watermark ?? ''].join('|');
  return createHmac('sha256', key).update(payload).digest('hex');
}

/**
 * Re-batismo único: o algoritmo de `machineId()` mudou (hostname/CPU → GUID nativo do
 * SO). Sem isso, toda instalação já ativada antes desta atualização veria um "machine_id
 * diferente" no primeiro boot pós-atualização e cairia em `bloqueada` à toa. Roda uma
 * única vez por instalação (marcado por `machine_id_version`); não recalcula o HMAC
 * (fica NULL até a próxima validação/gravação legítima — linha legada nunca é tratada
 * como violação).
 */
function reanchorMachineIdIfNeeded(row: LicenseRow): void {
  if (row.machine_id_version >= MACHINE_ID_VERSION) return;
  const current = machineId();
  getSqlite()
    .prepare('UPDATE license SET machine_id = ?, machine_id_version = ? WHERE id = ?')
    .run(current, MACHINE_ID_VERSION, row.id);
  row.machine_id = current;
  row.machine_id_version = MACHINE_ID_VERSION;
}

/** Nunca deixa o watermark regredir; grava junto a assinatura de integridade recalculada. */
function bumpWatermark(row: LicenseRow, candidateMs: number): void {
  if (row.time_watermark != null && candidateMs <= row.time_watermark) return;
  const hmac = computeIntegrityHmac({ ...row, time_watermark: candidateMs });
  getSqlite()
    .prepare('UPDATE license SET time_watermark = ?, integrity_hmac = ? WHERE id = ?')
    .run(candidateMs, hmac, row.id);
  row.time_watermark = candidateMs;
  row.integrity_hmac = hmac;
}

export function setLicense(companyUuid: string, licenseKey: string, plan?: string, validUntil?: string): void {
  ensureLicenseRow();
  const now = Date.now();
  getSqlite()
    .prepare(
      `UPDATE license SET company_uuid = ?, license_key = ?, plan = COALESCE(?, plan),
       valid_until = COALESCE(?, valid_until), last_validated_at = datetime('now'),
       activated_at = COALESCE(activated_at, datetime('now')), updated_at = datetime('now')`,
    )
    .run(companyUuid, licenseKey, plan ?? null, validUntil ?? null);
  const row = getRow()!;
  bumpWatermark(row, now);
}

/** Credenciais usadas pelo motor de sync (Fase 6a) para autenticar no cloud/. */
export function getLicenseCredentials(): { companyUuid: string | null; licenseKey: string | null } {
  const row = getRow();
  return { companyUuid: row?.company_uuid ?? null, licenseKey: row?.license_key ?? null };
}

/** Ativação obrigatória (primeira conexão): sem isso, o gate em server.ts bloqueia tudo. */
export function isActivated(): boolean {
  ensureLicenseRow();
  return !!getRow()?.activated_at;
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

export interface CloudCompanyProfile {
  name: string | null;
  legalName: string | null;
  document: string | null;
  stateRegistration: string | null;
  email: string | null;
  phone: string | null;
  zip: string | null;
  street: string | null;
  number: string | null;
  complement: string | null;
  district: string | null;
  city: string | null;
  state: string | null;
}

interface CloudValidateResponse {
  plan: string | null;
  modules: string[] | null;
  validUntil: string | null;
  supportPhone: string | null;
  supportEmail: string | null;
  company?: CloudCompanyProfile | null;
  serverTime?: string;
}

/**
 * Junta rua, número, complemento, bairro, cidade e UF numa linha só — é o formato que o
 * cupom (`empresa.endereco`) espera. Partes vazias somem sem deixar vírgula solta.
 */
export function composeAddress(c: CloudCompanyProfile): string {
  const linha1 = [c.street, c.number].filter((s) => s && s.trim()).join(', ');
  const cidadeUf = [c.city, c.state].filter((s) => s && s.trim()).join(' — ');
  return [linha1, c.complement, c.district, cidadeUf, c.zip]
    .map((s) => (s ?? '').trim())
    .filter(Boolean)
    .join(', ');
}

/**
 * Preenche as configurações da empresa no Kivo local a partir do perfil cadastrado no
 * cloud — SÓ os campos que ainda estão vazios, pra nunca sobrescrever o que o lojista
 * editou à mão. Chamado na ativação (e nas revalidações, de forma idempotente).
 */
export function applyCompanyProfile(c: CloudCompanyProfile | null | undefined): void {
  if (!c) return;
  const fillIfEmpty = (key: string, value: string | null | undefined): void => {
    const v = (value ?? '').trim();
    if (!v) return;
    const current = settingsRepository.get(key);
    if (current == null || current.trim() === '') settingsRepository.set(key, v);
  };
  fillIfEmpty('empresa.nome', c.name);
  fillIfEmpty('empresa.razao_social', c.legalName);
  fillIfEmpty('empresa.documento', c.document);
  fillIfEmpty('empresa.ie', c.stateRegistration);
  fillIfEmpty('empresa.email', c.email);
  fillIfEmpty('empresa.telefone', c.phone);
  fillIfEmpty('empresa.cep', c.zip);
  fillIfEmpty('empresa.rua', c.street);
  fillIfEmpty('empresa.numero', c.number);
  fillIfEmpty('empresa.complemento', c.complement);
  fillIfEmpty('empresa.bairro', c.district);
  fillIfEmpty('empresa.cidade', c.city);
  fillIfEmpty('empresa.uf', c.state);
  // Linha única usada no cabeçalho do cupom.
  fillIfEmpty('empresa.endereco', composeAddress(c));
}

type ActivateResult =
  | { ok: true; info: LicenseInfo }
  | { ok: false; error: string; reason: 'offline' | 'invalid_credentials' | 'device_limit_exceeded' | 'device_revoked' | 'not_configured' };

/**
 * Ativação inicial (tela obrigatória, `activationRoutes.ts`): ao contrário de
 * `refreshLicenseFromCloud`, NÃO engole erro — a primeira conexão precisa mesmo
 * acontecer, então quem chama precisa saber exatamente por que falhou.
 */
type TrialResult =
  | { ok: true; info: LicenseInfo }
  | { ok: false; error: string; reason: 'offline' | 'already_used' | 'not_configured' };

/**
 * Solicita um teste grátis de 15 dias no servidor. O servidor verifica se esta máquina
 * já utilizou o teste (via `trial_registry`) e, se não, cria uma empresa trial e retorna
 * as credenciais. O usuário não precisa digitar nada — a ativação é automática.
 */
export async function requestTrial(): Promise<TrialResult> {
  const url = getCloudServerUrl();
  if (!url) return { ok: false, error: 'Servidor de licenciamento não configurado.', reason: 'not_configured' };

  let res: Response;
  try {
    res = await fetch(`${url.replace(/\/$/, '')}/api/license/request-trial`, {
      method: 'POST',
      headers: { 'X-Kivo-Machine-Id': machineId() },
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    return { ok: false, error: 'Sem conexão com a internet. Conecte-se para ativar.', reason: 'offline' };
  }

  if (res.status === 409) {
    return { ok: false, error: 'Esta máquina já utilizou o período de teste gratuito.', reason: 'already_used' };
  }
  if (!res.ok) return { ok: false, error: `Falha ao solicitar teste (HTTP ${res.status}).`, reason: 'offline' };

  const body = (await res.json()) as {
    companyUuid: string; licenseKey: string; plan: string; validUntil: string;
    supportPhone?: string; supportEmail?: string; serverTime?: string;
  };

  ensureLicenseRow();
  getSqlite()
    .prepare(
      `UPDATE license SET company_uuid = ?, license_key = ?, plan = ?, valid_until = ?,
       support_phone = ?, support_email = ?, machine_id = ?, machine_id_version = ?,
       last_validated_at = datetime('now'), activated_at = datetime('now'), updated_at = datetime('now')`,
    )
    .run(
      body.companyUuid, body.licenseKey, body.plan, body.validUntil,
      body.supportPhone ?? null, body.supportEmail ?? null,
      machineId(), MACHINE_ID_VERSION,
    );
  const row = getRow()!;
  bumpWatermark(row, body.serverTime ? new Date(body.serverTime).getTime() : Date.now());

  return { ok: true, info: validateLicense() };
}

export async function activateLicense(companyUuid: string, licenseKey: string): Promise<ActivateResult> {
  const url = getCloudServerUrl();
  if (!url) return { ok: false, error: 'Servidor de licenciamento não configurado.', reason: 'not_configured' };

  let res: Response;
  try {
    res = await fetch(`${url.replace(/\/$/, '')}/api/license/validate`, {
      headers: { 'X-Kivo-Company': companyUuid, 'X-Kivo-License-Key': licenseKey, 'X-Kivo-Machine-Id': machineId() },
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    return { ok: false, error: 'Sem conexão com a internet. Conecte-se para ativar.', reason: 'offline' };
  }

  if (res.status === 401) return { ok: false, error: 'Empresa ou chave de licença inválidas.', reason: 'invalid_credentials' };
  if (res.status === 403) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    const reason = body.error === 'device_revoked' ? 'device_revoked' : 'device_limit_exceeded';
    return {
      ok: false,
      reason,
      error:
        reason === 'device_revoked'
          ? 'Este dispositivo foi desativado para esta licença. Contate o suporte.'
          : 'Limite de dispositivos desta licença atingido. Contate o suporte para liberar mais um.',
    };
  }
  if (!res.ok) return { ok: false, error: `Falha ao validar (HTTP ${res.status}).`, reason: 'offline' };

  const body = (await res.json()) as CloudValidateResponse;
  ensureLicenseRow();
  getSqlite()
    .prepare(
      `UPDATE license SET company_uuid = ?, license_key = ?, plan = ?, modules_json = ?, valid_until = ?,
       support_phone = ?, support_email = ?, machine_id = ?, machine_id_version = ?,
       last_validated_at = datetime('now'), activated_at = datetime('now'), updated_at = datetime('now')`,
    )
    .run(
      companyUuid,
      licenseKey,
      body.plan,
      body.modules != null ? JSON.stringify(body.modules) : null,
      body.validUntil,
      body.supportPhone ?? null,
      body.supportEmail ?? null,
      machineId(),
      MACHINE_ID_VERSION,
    );
  const row = getRow()!;
  bumpWatermark(row, body.serverTime ? new Date(body.serverTime).getTime() : Date.now());
  applyCompanyProfile(body.company);
  return { ok: true, info: validateLicense() };
}

/**
 * Validação remota periódica: confirma plano/módulos/validade contra o cloud/ e
 * atualiza o cache local. Nunca lança — falha de rede mantém o último estado
 * conhecido (tolerância offline). Também é quem "cura" divergência de machine_id
 * (reinstalação no mesmo hardware) e alimenta o watermark de relógio com o horário
 * do servidor.
 */
export async function refreshLicenseFromCloud(): Promise<void> {
  const { companyUuid, licenseKey } = getLicenseCredentials();
  const url = getCloudServerUrl();
  if (!companyUuid || !licenseKey || !url) return;
  try {
    const res = await fetch(`${url.replace(/\/$/, '')}/api/license/validate`, {
      headers: { 'X-Kivo-Company': companyUuid, 'X-Kivo-License-Key': licenseKey, 'X-Kivo-Machine-Id': machineId() },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      // 403 device_revoked é um sinal AUTORITATIVO do cloud (o suporte removeu este
      // dispositivo), diferente de rede fora do ar/timeout/5xx — esses últimos mantêm
      // o cache local como estava (tolerância offline); a revogação precisa travar de
      // fato, senão a máquina antiga nunca percebe que perdeu a vaga.
      if (res.status === 403) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        if (body.error === 'device_revoked') {
          ensureLicenseRow();
          getSqlite().prepare("UPDATE license SET device_revoked_at = datetime('now'), updated_at = datetime('now')").run();
        }
      }
      return;
    }
    const body = (await res.json()) as CloudValidateResponse;
    ensureLicenseRow();
    getSqlite()
      .prepare(
        `UPDATE license SET plan = ?, modules_json = ?, valid_until = ?, support_phone = ?, support_email = ?,
         machine_id = ?, machine_id_version = ?, device_revoked_at = NULL,
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
        machineId(),
        MACHINE_ID_VERSION,
      );
    const row = getRow()!;
    bumpWatermark(row, body.serverTime ? new Date(body.serverTime).getTime() : Date.now());
    applyCompanyProfile(body.company);
  } catch {
    // offline ou cloud fora do ar: mantém o cache local, não interrompe o sync.
  }
}

/** Validação local no boot/requests. Nunca trava por rede: só informa o status. */
export function validateLicense(): LicenseInfo {
  ensureLicenseRow();
  const row = getRow()!;
  reanchorMachineIdIfNeeded(row);

  const daysRemaining = row.valid_until ? Math.ceil((parseSqliteUtc(row.valid_until) - Date.now()) / 86_400_000) : null;
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

  if (row.device_revoked_at) {
    return {
      ...base,
      status: 'bloqueada',
      message: 'Este dispositivo foi desativado para esta licença pelo suporte. Contate o suporte para liberar novamente.',
    };
  }

  const now = Date.now();
  const clockRolledBack = row.time_watermark != null && now < row.time_watermark - CLOCK_TOLERANCE_MS;
  const hmacInvalid = row.integrity_hmac != null && row.integrity_hmac !== computeIntegrityHmac(row);
  const machineMismatch = row.machine_id !== machineId();

  if (!clockRolledBack) bumpWatermark(row, now);

  if (clockRolledBack || hmacInvalid || machineMismatch) {
    return {
      ...base,
      status: 'bloqueada',
      message: 'Detectamos uma inconsistência nesta instalação (relógio, integridade ou dispositivo). Conecte-se à internet para revalidar.',
    };
  }

  if (row.valid_until && parseSqliteUtc(row.valid_until) < now) {
    const grace = row.last_validated_at ? parseSqliteUtc(row.last_validated_at) + row.offline_grace_days * 24 * 3600e3 : 0;
    if (grace > now) {
      return { ...base, status: 'tolerancia', message: 'Licença vencida — operando em tolerância offline.' };
    }
    return { ...base, status: 'expirada', message: 'Licença expirada. Renove para continuar recebendo atualizações.' };
  }

  return { ...base, status: 'valida', message: 'Licença válida.' };
}
