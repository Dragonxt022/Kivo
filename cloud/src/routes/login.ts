import { Router } from 'express';
import { getPool } from '../db';
import {
  ADMIN_SESSION_COOKIE,
  createAdminSession,
  hasAnyAdmin,
  isAdminAuthenticated,
  verifyAdminCredentials,
} from '../adminAuth';
import {
  AFFILIATE_SESSION_COOKIE,
  createAffiliateSession,
  getAffiliateSession,
  verifyAffiliateCredentials,
} from '../affiliateAuth';

/**
 * Tela ÚNICA de login do Kivo Cloud (`/login`).
 *
 * Antes havia dois formulários separados — `/admin/login` (equipe Kivo) e `/afiliado/login`
 * (representantes). Agora existe um só: o controller tenta as credenciais na base de
 * administradores e, se não bater, tenta na de afiliados, redirecionando para o painel certo
 * (`/admin` ou `/afiliado`). As duas sessões continuam independentes (cookies/tabelas
 * distintos), então um usuário pode estar logado como admin sem afetar o portal do afiliado.
 */
const router = Router();

router.get('/login', async (req, res) => {
  // Primeiro acesso: ainda não existe nenhum admin — manda criar o administrador inicial.
  if (!(await hasAnyAdmin())) {
    res.redirect('/admin/setup');
    return;
  }
  if (await isAdminAuthenticated(req)) {
    res.redirect('/admin');
    return;
  }
  if (await getAffiliateSession(req)) {
    res.redirect('/afiliado');
    return;
  }
  res.render('login-unificado', { error: null });
});

router.post('/login', async (req, res) => {
  const { username, password } = req.body ?? {};
  const user = String(username ?? '').trim();
  const pass = String(password ?? '');

  if (user && pass) {
    // 1) Equipe Kivo (painel admin).
    if (await verifyAdminCredentials(user, pass)) {
      const token = await createAdminSession(user);
      res.cookie(ADMIN_SESSION_COOKIE, token, { httpOnly: true, sameSite: 'lax' });
      res.redirect('/admin');
      return;
    }
    // 2) Representante comercial (portal do afiliado).
    const affiliate = await verifyAffiliateCredentials(user, pass);
    if (affiliate) {
      const token = await createAffiliateSession(affiliate.id);
      await getPool().query('UPDATE affiliates SET last_login_at = NOW(3) WHERE id = ?', [affiliate.id]);
      res.cookie(AFFILIATE_SESSION_COOKIE, token, { httpOnly: true, sameSite: 'lax' });
      res.redirect('/afiliado');
      return;
    }
  }

  if (!(await hasAnyAdmin())) {
    res.redirect('/admin/setup');
    return;
  }
  res.status(401).render('login-unificado', { error: 'Usuário ou senha inválidos.' });
});

export default router;
