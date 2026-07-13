import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createGzip, createGunzip, gunzipSync } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { getSqlite, closeDb } from '../database/connection';
import { getLicenseCredentials, machineId, validateLicense } from '../license/service';
import { canSaveToCloud } from '../license/plans';
import { getCloudServerUrl } from '../config/cloud';

/**
 * Backup local (KATSU_PLANO.md §8):
 * compacta o SQLite (gzip), calcula checksum sha256 e registra no histórico.
 * Destino configurável via setting `backup.dir`. Restauração validada por checksum.
 * Fase 6c: se houver licença configurada, o backup também sobe para o cloud/
 * (best-effort — falha de rede não compromete o backup local, que já aconteceu).
 */

function backupDir(): string {
  const row = getSqlite()
    .prepare("SELECT value FROM settings WHERE key = 'backup.dir' AND deleted_at IS NULL")
    .get() as { value: string | null } | undefined;
  const dir = row?.value || path.resolve(process.cwd(), 'storage', 'backups');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

export interface BackupResult {
  id: number;
  filePath: string;
  sizeBytes: number;
  checksum: string;
}

export interface BackupSettings {
  frequencia: 'diario' | 'semanal' | 'mensal';
  hora: string; // 'HH:MM'
  diaSemana: number; // 0 (domingo) .. 6 (sábado), usado só se frequencia = 'semanal'
  diaMes: number; // 1..28, usado só se frequencia = 'mensal'
  retencao: number | null; // null/0 = sem limite (não apaga nada automaticamente)
}

/** Configurações de agendamento/retenção de backup, guardadas na tabela `settings` (chaves `backup.*`). */
export function getBackupSettings(): BackupSettings {
  const rows = getSqlite()
    .prepare("SELECT key, value FROM settings WHERE key LIKE 'backup.%' AND deleted_at IS NULL")
    .all() as { key: string; value: string | null }[];
  const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  const frequencia = map['backup.frequencia'] === 'semanal' || map['backup.frequencia'] === 'mensal' ? map['backup.frequencia'] : 'diario';
  return {
    frequencia,
    hora: map['backup.hora'] || '23:00',
    diaSemana: map['backup.dia_semana'] != null ? Number(map['backup.dia_semana']) : 0,
    diaMes: map['backup.dia_mes'] != null ? Number(map['backup.dia_mes']) : 1,
    retencao: map['backup.retencao'] != null ? Number(map['backup.retencao']) : 4,
  };
}

export async function runBackup(trigger: 'manual' | 'agendado' = 'manual'): Promise<BackupResult> {
  const db = getSqlite();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const tmpDb = path.join(backupDir(), `katsu-${stamp}.db`);
  const finalPath = `${tmpDb}.gz`;

  await db.backup(tmpDb); // cópia consistente mesmo com o banco em uso
  await pipeline(fs.createReadStream(tmpDb), createGzip(), fs.createWriteStream(finalPath));
  fs.unlinkSync(tmpDb);
  const stat = fs.statSync(finalPath);

  const compressedBuf = fs.readFileSync(finalPath);
  const checksum = sha256(compressedBuf);
  const backupUuid = randomUUID();
  const info = db
    .prepare(
      `INSERT INTO backups (file_path, size_bytes, checksum, trigger, uuid) VALUES (?, ?, ?, ?, ?)`,
    )
    .run(finalPath, compressedBuf.length, checksum, trigger, backupUuid);
  const id = Number(info.lastInsertRowid);

  if (getLicenseCredentials().companyUuid && canSaveToCloud(validateLicense().plan)) {
    try {
      await uploadBackupToCloud(id);
    } catch (e) {
      console.error('[backup] falha ao enviar backup à nuvem (mantém apenas local):', e);
    }
  }

  try {
    await enforceRetention();
  } catch (e) {
    console.error('[backup] falha ao aplicar retenção (mantém os backups como estão):', e);
  }

  return { id, filePath: finalPath, sizeBytes: compressedBuf.length, checksum };
}

/**
 * Apaga os backups mais antigos além do limite configurado em `backup.retencao`
 * (local e, se o plano permitir nuvem, a cópia lá também). Sem limite configurado
 * (0/vazio), não faz nada — é opt-in.
 */
export async function enforceRetention(): Promise<void> {
  const { retencao } = getBackupSettings();
  if (!retencao || retencao <= 0) return;
  const db = getSqlite();
  const excess = db
    .prepare('SELECT id, file_path, uuid, uploaded_at FROM backups ORDER BY id DESC LIMIT -1 OFFSET ?')
    .all(retencao) as { id: number; file_path: string; uuid: string; uploaded_at: string | null }[];
  const canCloud = getLicenseCredentials().companyUuid && canSaveToCloud(validateLicense().plan);
  for (const row of excess) {
    if (row.uploaded_at && canCloud) {
      try {
        await deleteCloudBackup(row.uuid);
      } catch (e) {
        console.error('[backup] falha ao excluir cópia antiga na nuvem (mantém a exclusão local):', e);
      }
    }
    try {
      if (fs.existsSync(row.file_path)) fs.unlinkSync(row.file_path);
    } catch {
      // arquivo já não existe — segue a exclusão do registro mesmo assim
    }
    db.prepare('DELETE FROM backups WHERE id = ?').run(row.id);
  }
}

/** Restaura um backup do histórico. Valida checksum antes de tocar no banco. */
export function restoreBackup(backupId: number): { ok: boolean; error?: string } {
  const db = getSqlite();
  const row = db.prepare('SELECT file_path, checksum FROM backups WHERE id = ?').get(backupId) as
    | { file_path: string; checksum: string }
    | undefined;
  if (!row) return { ok: false, error: 'Backup não encontrado.' };
  if (!fs.existsSync(row.file_path)) return { ok: false, error: 'Arquivo de backup não existe mais.' };

  const compressed = fs.readFileSync(row.file_path);
  if (sha256(compressed) !== row.checksum) {
    return { ok: false, error: 'Checksum inválido — arquivo corrompido, restauração abortada.' };
  }

  const data = gunzipSync(compressed);
  const dbPath = (db as unknown as { name: string }).name;
  closeDb();
  fs.writeFileSync(dbPath, data);
  getSqlite(); // reabre
  return { ok: true };
}

export function listBackups() {
  return getSqlite()
    .prepare(
      'SELECT id, file_path, size_bytes, checksum, trigger, status, uploaded_at, created_at FROM backups ORDER BY id DESC LIMIT 100',
    )
    .all();
}

/**
 * Exclui um backup local (arquivo + linha). Se ele já tiver sido enviado à nuvem
 * (`uploaded_at` preenchido), tenta apagar a cópia lá também — best-effort: falha de
 * rede não impede a exclusão local, que já é o efeito principal pedido pelo usuário.
 */
export async function deleteBackup(backupId: number): Promise<{ ok: boolean; error?: string }> {
  const row = getSqlite().prepare('SELECT file_path, uuid, uploaded_at FROM backups WHERE id = ?').get(backupId) as
    | { file_path: string; uuid: string; uploaded_at: string | null }
    | undefined;
  if (!row) return { ok: false, error: 'Backup não encontrado.' };

  if (row.uploaded_at) {
    try {
      await deleteCloudBackup(row.uuid);
    } catch (e) {
      console.error('[backup] falha ao excluir cópia na nuvem (mantém a exclusão local):', e);
    }
  }
  try {
    if (fs.existsSync(row.file_path)) fs.unlinkSync(row.file_path);
  } catch {
    // arquivo já não existe — segue a exclusão do registro mesmo assim
  }
  getSqlite().prepare('DELETE FROM backups WHERE id = ?').run(backupId);
  return { ok: true };
}

function cloudBaseUrl(): string | null {
  const url = getCloudServerUrl();
  return url ? url.replace(/\/$/, '') : null;
}

function cloudAuthHeaders(): Record<string, string> | null {
  const { companyUuid, licenseKey } = getLicenseCredentials();
  if (!companyUuid || !licenseKey) return null;
  return { 'X-Katsu-Company': companyUuid, 'X-Katsu-License-Key': licenseKey };
}

/** Envia um backup já gravado localmente para o cloud/. Não faz nada se não houver licença/URL configurados. */
export async function uploadBackupToCloud(backupId: number): Promise<void> {
  const base = cloudBaseUrl();
  const auth = cloudAuthHeaders();
  if (!base || !auth) return;

  const row = getSqlite().prepare('SELECT file_path, checksum, uuid FROM backups WHERE id = ?').get(backupId) as
    | { file_path: string; checksum: string; uuid: string }
    | undefined;
  if (!row) return;

  const res = await fetch(`${base}/api/backup/upload`, {
    method: 'POST',
    headers: {
      ...auth,
      'Content-Type': 'application/gzip',
      'X-Katsu-Backup-Uuid': row.uuid,
      'X-Katsu-Backup-Checksum': row.checksum,
      'X-Katsu-Machine-Id': machineId(),
    },
    body: fs.readFileSync(row.file_path),
  });
  if (!res.ok) throw new Error(`Upload de backup falhou: ${res.status} ${await res.text()}`);

  getSqlite().prepare("UPDATE backups SET uploaded_at = datetime('now') WHERE id = ?").run(backupId);
}

export interface CloudBackupInfo {
  uuid: string;
  machineId: string;
  checksum: string;
  sizeBytes: number;
  createdAt: string;
}

/** Lista os backups disponíveis na nuvem para a empresa desta licença. */
export async function listCloudBackups(): Promise<CloudBackupInfo[]> {
  const base = cloudBaseUrl();
  const auth = cloudAuthHeaders();
  if (!base || !auth) throw new Error('Licença/URL da nuvem não configurados.');
  const res = await fetch(`${base}/api/backup`, { headers: auth });
  if (!res.ok) throw new Error(`Falha ao listar backups da nuvem: ${res.status} ${await res.text()}`);
  return (await res.json()) as CloudBackupInfo[];
}

/** Exclui um backup da nuvem (usado tanto pela exclusão em cascata de `deleteBackup` quanto pela lista "Backups na nuvem"). */
export async function deleteCloudBackup(cloudUuid: string): Promise<void> {
  const base = cloudBaseUrl();
  const auth = cloudAuthHeaders();
  if (!base || !auth) return; // sem nuvem configurada, nada a fazer

  const res = await fetch(`${base}/api/backup/${cloudUuid}`, { method: 'DELETE', headers: auth });
  if (!res.ok && res.status !== 404) {
    throw new Error(`Falha ao excluir backup da nuvem: ${res.status} ${await res.text()}`);
  }
}

/**
 * Baixa um backup da nuvem e registra localmente (trigger 'nuvem') — pronto para ser
 * restaurado com `restoreBackup(id)`, sem duplicar a lógica de checksum-e-sobrescrita.
 */
export async function downloadCloudBackup(cloudUuid: string): Promise<BackupResult> {
  const base = cloudBaseUrl();
  const auth = cloudAuthHeaders();
  if (!base || !auth) throw new Error('Licença/URL da nuvem não configurados.');

  const res = await fetch(`${base}/api/backup/${cloudUuid}/download`, { headers: auth });
  if (!res.ok) throw new Error(`Falha ao baixar backup da nuvem: ${res.status} ${await res.text()}`);
  const expectedChecksum = res.headers.get('X-Katsu-Backup-Checksum');
  const compressed = Buffer.from(await res.arrayBuffer());
  const checksum = sha256(compressed);
  if (expectedChecksum && checksum !== expectedChecksum) {
    throw new Error('Checksum inválido — backup da nuvem corrompido, download rejeitado.');
  }

  const finalPath = path.join(backupDir(), `katsu-nuvem-${cloudUuid}.gz`);
  fs.writeFileSync(finalPath, compressed);

  const db = getSqlite();
  db.prepare(
    `INSERT INTO backups (file_path, size_bytes, checksum, trigger, uuid) VALUES (?, ?, ?, 'nuvem', ?)
     ON CONFLICT(uuid) DO UPDATE SET file_path = excluded.file_path, size_bytes = excluded.size_bytes, checksum = excluded.checksum`,
  ).run(finalPath, compressed.length, checksum, cloudUuid);
  const { id } = db.prepare('SELECT id FROM backups WHERE uuid = ?').get(cloudUuid) as { id: number };

  return { id, filePath: finalPath, sizeBytes: compressed.length, checksum };
}

/**
 * Já passou do horário configurado hoje, é um dia elegível pra frequência escolhida,
 * e ainda não rodou um backup agendado hoje? Não checa o minuto exato — assim, se o
 * app estiver fechado no horário configurado, o backup roda assim que for aberto de
 * novo (catch-up), em vez de simplesmente perder o dia.
 */
function isScheduledBackupDue(now: Date): boolean {
  const s = getBackupSettings();
  const [hh, mm] = s.hora.split(':').map((n) => Number(n));
  if (Number.isNaN(hh) || Number.isNaN(mm)) return false;
  if (now.getHours() * 60 + now.getMinutes() < hh * 60 + mm) return false;
  if (s.frequencia === 'semanal' && now.getDay() !== s.diaSemana) return false;
  if (s.frequencia === 'mensal' && now.getDate() !== s.diaMes) return false;
  const today = now.toISOString().slice(0, 10);
  const already = getSqlite()
    .prepare("SELECT 1 FROM backups WHERE trigger = 'agendado' AND date(created_at) = ?")
    .get(today);
  return !already;
}

/** Agendador de backup: horário/frequência configuráveis em `backup.*` (settings). */
export function startBackupScheduler(): NodeJS.Timeout {
  const check = async () => {
    if (!isScheduledBackupDue(new Date())) return;
    try {
      await runBackup('agendado');
      console.log('[backup] backup agendado concluído.');
    } catch (e) {
      console.error('[backup] falha no backup agendado:', e);
    }
  };
  check(); // catch-up: cobre o caso do app ter ficado fechado no horário configurado
  const timer = setInterval(check, 60_000);
  timer.unref(); // não impede o processo de encerrar
  return timer;
}
