import { Router } from 'express';
import QRCode from 'qrcode';
import { requirePermission } from '../permissions/middleware';
import { getSqlite } from '../database/connection';
import { grantRemoteAccess, revokeRemoteAccess, listRemoteAccess, fetchRemoteUsage } from './service';
import { validateLicense } from '../license/service';
import { canUseWebApp } from '../license/plans';

const router = Router();

/** Estado da aba, para a tela saber se deve oferecer o recurso ou explicar por que não. */
router.get('/status', requirePermission('users.view'), async (_req, res) => {
  const lic = validateLicense();
  const usage = await fetchRemoteUsage();
  const uuidByUser = getSqlite().prepare('SELECT id, uuid FROM users WHERE deleted_at IS NULL').all() as
    { id: number; uuid: string }[];
  const uuidMap = new Map(uuidByUser.map((u) => [u.id, u.uuid]));
  res.json({
    available: canUseWebApp(lic.plan),
    plan: lic.plan,
    // O "último uso" só a nuvem sabe (é lá que o celular bate); mesclado aqui para a
    // listagem não precisar de duas chamadas na tela.
    accesses: listRemoteAccess().map((a) => ({
      ...a,
      last_used_at: usage[uuidMap.get(a.user_id) ?? '']?.last_used_at ?? a.last_used_at,
    })),
  });
});

/**
 * Devolve o token em claro UMA vez, junto com o QR já renderizado (mesma lib `qrcode` usada
 * em core/config/routes.ts). Não há rota para reler: perdeu, gera outro — que é justamente
 * o que invalida o link antigo.
 */
router.post('/users/:id/grant', requirePermission('users.remote.manage'), async (req, res) => {
  const result = await grantRemoteAccess(req, Number(req.params.id), req.body?.label);
  if (!result.ok) {
    res.status(400).json({ error: result.error });
    return;
  }
  const qr = await QRCode.toDataURL(result.url, { margin: 1, width: 240 });
  res.status(201).json({ url: result.url, qr });
});

router.delete('/users/:id/grant', requirePermission('users.remote.manage'), async (req, res) => {
  const result = await revokeRemoteAccess(req, Number(req.params.id));
  if (!result.ok) {
    res.status(400).json({ error: result.error });
    return;
  }
  res.json({ ok: true });
});

export default router;
