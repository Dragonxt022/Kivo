import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { getSqlite, closeDb } from '../database/connection';
import { getLicenseCredentials, machineId } from '../license/service';
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

export async function runBackup(trigger: 'manual' | 'agendado' = 'manual'): Promise<BackupResult> {
  const db = getSqlite();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const tmpDb = path.join(backupDir(), `katsu-${stamp}.db`);
  const finalPath = `${tmpDb}.gz`;

  await db.backup(tmpDb); // cópia consistente mesmo com o banco em uso
  const compressed = gzipSync(fs.readFileSync(tmpDb));
  fs.writeFileSync(finalPath, compressed);
  fs.unlinkSync(tmpDb);

  const checksum = sha256(compressed);
  const backupUuid = randomUUID();
  const info = db
    .prepare(
      `INSERT INTO backups (file_path, size_bytes, checksum, trigger, uuid) VALUES (?, ?, ?, ?, ?)`,
    )
    .run(finalPath, compressed.length, checksum, trigger, backupUuid);
  const id = Number(info.lastInsertRowid);

  if (getLicenseCredentials().companyUuid) {
    try {
      await uploadBackupToCloud(id);
    } catch (e) {
      console.error('[backup] falha ao enviar backup à nuvem (mantém apenas local):', e);
    }
  }

  return { id, filePath: finalPath, sizeBytes: compressed.length, checksum };
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

/** Agendador: backup diário às 23:00 (verifica a cada minuto, sem duplicar no dia). */
export function startBackupScheduler(): NodeJS.Timeout {
  const timer = setInterval(async () => {
    const now = new Date();
    if (now.getHours() !== 23 || now.getMinutes() !== 0) return;
    const today = now.toISOString().slice(0, 10);
    const last = getSqlite()
      .prepare("SELECT 1 FROM backups WHERE trigger = 'agendado' AND date(created_at) = ?")
      .get(today);
    if (!last) {
      try {
        await runBackup('agendado');
        console.log('[backup] backup diário concluído.');
      } catch (e) {
        console.error('[backup] falha no backup agendado:', e);
      }
    }
  }, 60_000);
  timer.unref(); // não impede o processo de encerrar
  return timer;
}
