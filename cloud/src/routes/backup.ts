import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express, { Router } from 'express';
import { getPool } from '../db';
import { requireCompanyAuth, requireCloudSavePlan, type AuthedRequest } from '../auth';

const router = Router();
const rawGzip = express.raw({ type: 'application/gzip', limit: '200mb' });

// Relativo ao arquivo (não a process.cwd()): robusto independente de onde o processo é
// iniciado (ex.: testes automatizados sobem o cloud/ com cwd na raiz do repo Katsu).
const STORAGE_DIR = path.resolve(__dirname, '..', '..', 'storage', 'backups');

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

interface CloudBackupRow {
  uuid: string;
  machine_id: string;
  checksum: string;
  size_bytes: number;
  created_at: string;
}

router.post('/upload', rawGzip, requireCompanyAuth, requireCloudSavePlan, async (req: AuthedRequest, res) => {
  const uuid = req.header('X-Katsu-Backup-Uuid');
  const checksum = req.header('X-Katsu-Backup-Checksum');
  const machineId = req.header('X-Katsu-Machine-Id');
  const body = req.body as Buffer;
  if (!uuid || !checksum || !machineId || !Buffer.isBuffer(body) || !body.length) {
    res.status(400).json({ error: 'Cabeçalhos obrigatórios: X-Katsu-Backup-Uuid, X-Katsu-Backup-Checksum, X-Katsu-Machine-Id, corpo binário.' });
    return;
  }
  if (sha256(body) !== checksum) {
    res.status(400).json({ error: 'Checksum não confere com o corpo recebido.' });
    return;
  }
  const dir = path.join(STORAGE_DIR, req.companyUuid!);
  fs.mkdirSync(dir, { recursive: true });
  const storagePath = path.join(dir, `${uuid}.gz`);
  fs.writeFileSync(storagePath, body);

  await getPool().query(
    `INSERT INTO cloud_backups (company_uuid, uuid, machine_id, checksum, size_bytes, storage_path)
     VALUES (?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE checksum = VALUES(checksum), size_bytes = VALUES(size_bytes), storage_path = VALUES(storage_path)`,
    [req.companyUuid, uuid, machineId, checksum, body.length, storagePath],
  );
  res.status(201).json({ uuid, sizeBytes: body.length });
});

router.get('/', requireCompanyAuth, async (req: AuthedRequest, res) => {
  const [rows] = await getPool().query(
    'SELECT uuid, machine_id, checksum, size_bytes, created_at FROM cloud_backups WHERE company_uuid = ? ORDER BY created_at DESC',
    [req.companyUuid],
  );
  res.json(
    (rows as CloudBackupRow[]).map((r) => ({
      uuid: r.uuid,
      machineId: r.machine_id,
      checksum: r.checksum,
      sizeBytes: r.size_bytes,
      createdAt: r.created_at,
    })),
  );
});

router.get('/:uuid/download', requireCompanyAuth, async (req: AuthedRequest, res) => {
  const [rows] = await getPool().query(
    'SELECT storage_path, checksum FROM cloud_backups WHERE company_uuid = ? AND uuid = ?',
    [req.companyUuid, req.params.uuid],
  );
  const row = (rows as { storage_path: string; checksum: string }[])[0];
  if (!row || !fs.existsSync(row.storage_path)) {
    res.status(404).json({ error: 'Backup não encontrado.' });
    return;
  }
  res.setHeader('X-Katsu-Backup-Checksum', row.checksum);
  res.setHeader('Content-Type', 'application/gzip');
  res.send(fs.readFileSync(row.storage_path));
});

export default router;
