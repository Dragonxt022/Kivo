import { Router } from 'express';
import { getPool } from '../db';
import { requireCompanyAuth, type AuthedRequest } from '../auth';
import { canUseWebApp } from '../plans';

/**
 * Concessões de acesso ao Kivo Web, criadas e revogadas PELO DESKTOP (autenticado por
 * licença, não pelo celular). O token em claro nunca passa por aqui: o desktop gera, mostra
 * uma vez no QR e envia só o sha256.
 */
const router = Router();

/** Gate de plano na concessão. A revalidação por requisição fica em `mobileAuth.ts`. */
function requireWebAppPlan(req: AuthedRequest, res: import('express').Response, next: import('express').NextFunction): void {
  if (!canUseWebApp(req.companyPlan)) {
    res.status(403).json({ error: 'O acesso pelo celular (Kivo Web) é exclusivo do plano Diamante.' });
    return;
  }
  next();
}

router.post('/grants', requireCompanyAuth, requireWebAppPlan, async (req: AuthedRequest, res) => {
  const b = req.body as {
    userUuid?: string; username?: string; name?: string;
    roleSlug?: string | null; permissions?: string[]; tokenHash?: string;
  };
  if (!b.userUuid || !b.username || !b.tokenHash) {
    res.status(400).json({ error: 'Informe userUuid, username e tokenHash.' });
    return;
  }
  if (!/^[0-9a-f]{64}$/.test(b.tokenHash)) {
    res.status(400).json({ error: 'tokenHash deve ser um sha256 em hexadecimal.' });
    return;
  }
  // Um acesso por usuário: gerar um link novo invalida o anterior (o token_hash muda), que é
  // o que o lojista espera de "gerar novo link" quando perdeu o celular.
  await getPool().query(
    `INSERT INTO company_mobile_grants
       (company_uuid, user_uuid, username, name, role_slug, permissions, token_hash, revoked_at)
     VALUES (?, ?, ?, ?, ?, CAST(? AS JSON), ?, NULL)
     ON DUPLICATE KEY UPDATE
       username = VALUES(username), name = VALUES(name), role_slug = VALUES(role_slug),
       permissions = VALUES(permissions), token_hash = VALUES(token_hash),
       revoked_at = NULL, last_used_at = NULL, created_at = NOW()`,
    [
      req.companyUuid, b.userUuid, b.username, b.name ?? b.username, b.roleSlug ?? null,
      JSON.stringify(b.permissions ?? []), b.tokenHash,
    ],
  );
  res.status(201).json({ ok: true });
});

router.delete('/grants/:userUuid', requireCompanyAuth, async (req: AuthedRequest, res) => {
  // Marca revogado em vez de apagar: mantém o histórico de que aquele acesso existiu, e o
  // `revoked_at IS NULL` do login já basta para barrar na requisição seguinte.
  await getPool().query(
    'UPDATE company_mobile_grants SET revoked_at = NOW() WHERE company_uuid = ? AND user_uuid = ?',
    [req.companyUuid, req.params.userUuid],
  );
  res.json({ ok: true });
});

/** Estado dos acessos, para o desktop mostrar "último uso" na lista sem guardar isso local. */
router.get('/grants', requireCompanyAuth, async (req: AuthedRequest, res) => {
  const [rows] = await getPool().query(
    `SELECT user_uuid, username, created_at, last_used_at, revoked_at
       FROM company_mobile_grants WHERE company_uuid = ? ORDER BY created_at DESC`,
    [req.companyUuid],
  );
  res.json({ grants: rows });
});

export default router;
