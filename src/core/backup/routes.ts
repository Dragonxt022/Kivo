import { Router } from 'express';
import { requirePermission } from '../permissions/middleware';
import { audit } from '../audit/service';
import { runBackup, restoreBackup, listBackups, listCloudBackups, downloadCloudBackup, deleteBackup, deleteCloudBackup } from './service';

const router = Router();

router.get('/', requirePermission('backup.view'), (_req, res) => {
  res.json(listBackups());
});

router.get('/cloud', requirePermission('backup.view'), async (_req, res) => {
  try {
    res.json(await listCloudBackups());
  } catch (e) {
    res.status(502).json({ error: (e as Error).message });
  }
});

router.post('/cloud/:uuid/download', requirePermission('backup.restore'), async (req, res) => {
  try {
    const result = await downloadCloudBackup(String(req.params.uuid));
    audit(req, 'backup_baixar_nuvem', 'backup', result.id, null, result);
    res.status(201).json(result);
  } catch (e) {
    res.status(502).json({ error: (e as Error).message });
  }
});

router.post('/', requirePermission('backup.run'), async (req, res) => {
  try {
    const result = await runBackup('manual');
    audit(req, 'backup', 'backup', result.id, null, result);
    res.status(201).json(result);
  } catch (e) {
    res.status(500).json({ error: `Falha no backup: ${String(e)}` });
  }
});

router.post('/:id/restore', requirePermission('backup.restore'), (req, res) => {
  const id = Number(req.params.id);
  const result = restoreBackup(id);
  audit(req, result.ok ? 'restaurar' : 'restaurar_falhou', 'backup', id, null, result);
  if (!result.ok) {
    res.status(400).json(result);
    return;
  }
  res.json(result);
});

router.delete('/cloud/:uuid', requirePermission('backup.delete'), async (req, res) => {
  try {
    await deleteCloudBackup(String(req.params.uuid));
    audit(req, 'excluir_nuvem', 'backup', undefined, null, { uuid: req.params.uuid });
    res.json({ ok: true });
  } catch (e) {
    res.status(502).json({ error: (e as Error).message });
  }
});

router.delete('/:id', requirePermission('backup.delete'), async (req, res) => {
  const id = Number(req.params.id);
  const result = await deleteBackup(id);
  audit(req, result.ok ? 'excluir' : 'excluir_falhou', 'backup', id, null, result);
  if (!result.ok) {
    res.status(404).json(result);
    return;
  }
  res.json(result);
});

export default router;
