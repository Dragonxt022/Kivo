import { Router, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { login, logout, verifyPassword, hashPassword, isFirstRunSetupPending, completeFirstRunSetup } from './service';
import { SESSION_COOKIE } from './middleware';
import { getSqlite } from '../database/connection';
import { audit } from '../audit/service';
import { assertAuth } from '../../shared/auth';
import { validateBody } from '../../shared/validateBody';
import { loginSchema, changePasswordSchema, firstRunSetupSchema } from '../../shared/schemas';
import { isLoopback, listQuickProfiles, quickLogin } from './quickLogin';

const router = Router();

/**
 * Freio contra força bruta no login. A janela é curta de propósito: quem erra a senha
 * aqui é quase sempre o próprio operador no meio do expediente, e travar o caixa por um
 * minuto inteiro custa mais que os poucos segundos que o atacante ganha — 5 tentativas a
 * cada 30s ainda derruba qualquer varredura automatizada.
 */
const loginLimiter = rateLimit({
  windowMs: 30 * 1000,
  max: 5,
  message: { error: 'Muitas tentativas. Aguarde 30 segundos.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const firstRunLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: 'Muitas tentativas. Aguarde 1 minuto.' },
  standardHeaders: true,
  legacyHeaders: false,
});

type Session = NonNullable<ReturnType<typeof login>>;

function startSession(req: Request, res: Response, result: Session): void {
  res.cookie(SESSION_COOKIE, result.token, {
    httpOnly: true,
    sameSite: 'strict',
    expires: new Date(result.expiresAt),
  });
  req.user = result.user;
}

function publicUser(user: Session['user']) {
  return {
    id: user.id,
    name: user.name,
    username: user.username,
    role: user.roleSlug,
    permissions: [...user.permissions],
  };
}

router.post('/login', loginLimiter, validateBody(loginSchema), (req, res) => {
  const { username, password, remember } = req.body;
  const result = login(username, password, remember, req.ip);
  if (!result) {
    audit(req, 'login_falhou', 'user', String(username));
    res.status(401).json({ error: 'Usuário ou senha inválidos.' });
    return;
  }
  startSession(req, res, result);
  audit(req, 'login', 'user', result.user.id);
  res.json({ user: publicUser(result.user) });
});

/**
 * ─── Entrada rápida por perfil (balões na tela de login) ───
 *
 * Públicas por necessidade (não existe sessão antes de entrar) e restritas ao LOOPBACK: a
 * troca vale para quem está no teclado daquele computador, não para quem alcança o Kivo pela
 * rede. Com "Acesso pela rede local" ligado o app escuta em 0.0.0.0, e sem esta guarda
 * qualquer celular no Wi-Fi da loja entraria como o dono só abrindo o endereço.
 *
 * Fora do loopback a lista responde vazia em vez de 403: quem está no celular não precisa
 * saber que existem perfis salvos, nem quais são os nomes das pessoas da loja.
 */
router.get('/quick-profiles', (req, res) => {
  res.json(isLoopback(req) ? listQuickProfiles() : []);
});

router.post('/quick-login', loginLimiter, (req, res) => {
  if (!isLoopback(req)) {
    res.status(403).json({ error: 'A entrada rápida só funciona no próprio computador.' });
    return;
  }
  const profileId = Number((req.body ?? {}).profileId);
  if (!Number.isInteger(profileId)) {
    res.status(400).json({ error: 'Perfil inválido.' });
    return;
  }
  const result = quickLogin(profileId, req.ip);
  if (!result) {
    audit(req, 'login_rapido_falhou', 'quick_profile', String(profileId));
    res.status(401).json({ error: 'Perfil não encontrado ou usuário desativado.' });
    return;
  }
  startSession(req, res, result);
  audit(req, 'login_rapido', 'user', result.user.id);
  res.json({ user: publicUser(result.user) });
});

/**
 * Primeiro acesso — rotas PÚBLICAS por necessidade: quem acabou de aceitar o teste não
 * tem sessão e nunca recebeu credencial nenhuma, então não há como exigir autenticação
 * aqui. A guarda é o estado de fábrica (ver isFirstRunSetupPending): enquanto a senha
 * ainda for admin/admin, qualquer um que alcance o app já entraria com ela — esta tela
 * não abre porta nova, fecha a que estava aberta. Trocada a senha, o GET passa a devolver
 * false e o POST é recusado.
 */
router.get('/first-run', (_req, res) => {
  res.json({ pending: isFirstRunSetupPending() });
});

router.post('/first-run', firstRunLimiter, validateBody(firstRunSetupSchema), (req, res) => {
  const { name, username, password } = req.body;
  const setup = completeFirstRunSetup({ name, username, password });
  if (!setup.ok) {
    res.status(409).json({ error: setup.error });
    return;
  }
  const result = login(String(username).trim().toLowerCase(), password, true, req.ip);
  if (!result) {
    // Credencial acabou de ser gravada; se o login falhar aqui é bug, não senha errada.
    res.status(500).json({ error: 'Acesso criado, mas não foi possível entrar. Recarregue a página e faça login.' });
    return;
  }
  startSession(req, res, result);
  audit(req, 'primeiro_acesso', 'user', result.user.id, null, { username: result.user.username });
  res.json({ user: publicUser(result.user) });
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
