import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { login, logout, verifyPassword, hashPassword } from './service';
import { SESSION_COOKIE } from './middleware';
import { getSqlite } from '../database/connection';
import { audit } from '../audit/service';
import { assertAuth } from '../../shared/auth';
import { validateBody } from '../../shared/validateBody';
import { loginSchema, changePasswordSchema } from '../../shared/schemas';

const router = Router();

const loginLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  message: { error: 'Muitas tentativas. Aguarde 1 minuto.' },
  standardHeaders: true,
  legacyHeaders: false,
});

router.post('/login', loginLimiter, validateBody(loginSchema), (req, res) => {
  const { username, password, remember } = req.body;
  const result = login(username, password, remember, req.ip);
  if (!result) {
    audit(req, 'login_falhou', 'user', String(username));
    res.status(401).json({ error: 'Usuário ou senha inválidos.' });
    return;
  }
  res.cookie(SESSION_COOKIE, result.token, {
    httpOnly: true,
    sameSite: 'strict',
    expires: new Date(result.expiresAt),
  });
  req.user = result.user;
  audit(req, 'login', 'user', result.user.id);
  res.json({
    user: {
      id: result.user.id,
      name: result.user.name,
      username: result.user.username,
      role: result.user.roleSlug,
      permissions: [...result.user.permissions],
    },
  });
});

router.post('/logout', (req, res) => {
  const cookies = req.headers.cookie ?? '';
  const match = cookies.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`));
  if (match) logout(match[1]);
  if (req.user) audit(req, 'logout', 'user', req.user.id);
  res.clearCookie(SESSION_COOKIE);
  res.json({ ok: true });
});

/** Troca de senha do PRÓPRIO usuário: exige senha atual e derruba as outras sessões. */
router.post('/change-password', validateBody(changePasswordSchema), (req, res) => {
  if (!req.user) {
    res.status(401).json({ error: 'Não autenticado.' });
    return;
  }
  const { currentPassword, newPassword } = req.body;
  const db = getSqlite();
  const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id) as
    | { password_hash: string }
    | undefined;
  if (!row || !verifyPassword(String(currentPassword), row.password_hash)) {
    audit(req, 'senha_falhou', 'user', req.user.id);
    res.status(400).json({ error: 'Senha atual incorreta.' });
    return;
  }
  assertAuth(req);
  const cookies = req.headers.cookie ?? '';
  const match = cookies.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`));
  db.transaction(() => {
    db.prepare(`UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(hashPassword(String(newPassword)), req.user.id);
    // derruba as outras sessões, mantém a atual
    if (match) db.prepare('DELETE FROM sessions WHERE user_id = ? AND token != ?').run(req.user.id, match[1]);
  })();
  audit(req, 'senha_trocada', 'user', req.user.id);
  res.json({ ok: true });
});

router.get('/me', (req, res) => {
  if (!req.user) {
    res.status(401).json({ error: 'Não autenticado.' });
    return;
  }
  const { id, name, username, roleSlug, permissions } = req.user;
  res.json({ id, name, username, role: roleSlug, permissions: [...permissions] });
});

export default router;
