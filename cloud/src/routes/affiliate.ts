import { Router } from 'express';
import { getPool } from '../db';
import { affiliateSummary, createPayoutFromAvailable } from '../affiliates';
import {
  AFFILIATE_SESSION_COOKIE,
  createAffiliateSession,
  destroyAffiliateSession,
  hashAffiliatePassword,
  readAffiliateCookie,
  requireAffiliateAuth,
  verifyAffiliateCredentials,
  type AffiliateRequest,
} from '../affiliateAuth';

/**
 * Portal do afiliado (`/afiliado`). O representante entra com o usuário/senha que o admin
 * cadastrou e acompanha as indicações dele: empresas, créditos de comissão, previsão de
 * lucro e pedidos de pagamento. Ele NUNCA enxerga dados de outros afiliados — toda query
 * é filtrada por `affiliate_id` da sessão.
 */
const router = Router();

router.get('/login', (req, res) => {
  if (readAffiliateCookie(req)) {
    res.redirect('/afiliado');
    return;
  }
  res.render('afiliado-login', { error: null });
});

router.post('/login', async (req, res) => {
  const { username, password } = req.body ?? {};
  const identity = username && password
    ? await verifyAffiliateCredentials(String(username).trim(), String(password))
    : null;
  if (!identity) {
    res.status(401).render('afiliado-login', { error: 'Usuário ou senha inválidos.' });
    return;
  }
  const token = await createAffiliateSession(identity.id);
  await getPool().query('UPDATE affiliates SET last_login_at = NOW(3) WHERE id = ?', [identity.id]);
  res.cookie(AFFILIATE_SESSION_COOKIE, token, { httpOnly: true, sameSite: 'lax' });
  res.redirect('/afiliado');
});

router.post('/logout', async (req, res) => {
  await destroyAffiliateSession(readAffiliateCookie(req));
  res.clearCookie(AFFILIATE_SESSION_COOKIE);
  res.redirect('/afiliado/login');
});

/** Dados básicos do afiliado logado + resumo financeiro. */
async function loadMe(affiliateId: number) {
  const [rows] = await getPool().query(
    `SELECT id, name, contact, city, document, pix_key, commission_pct, discount_pct, notes, username, last_login_at, active
       FROM affiliates WHERE id = ?`,
    [affiliateId],
  );
  return (rows as Record<string, unknown>[])[0] ?? null;
}

router.get('/', requireAffiliateAuth, async (req: AffiliateRequest, res) => {
  const affiliateId = req.affiliateId!;
  const pool = getPool();
  const me = await loadMe(affiliateId);
  const summary = await affiliateSummary(affiliateId);

  const [companies] = await pool.query(
    `SELECT c.company_uuid, c.name, c.plan, c.valid_until, c.city, c.state,
            (SELECT COALESCE(SUM(ch.amount_cents),0) FROM charges ch
              WHERE ch.company_uuid = c.company_uuid AND ch.status = 'pendente') AS pending_cents,
            (SELECT COALESCE(SUM(ch.amount_cents),0) FROM charges ch
              WHERE ch.company_uuid = c.company_uuid AND ch.status = 'paga') AS paid_cents
       FROM companies c WHERE c.affiliate_id = ? ORDER BY c.name`,
    [affiliateId],
  );

  const [recentCommissions] = await pool.query(
    `SELECT ac.id, ac.amount_cents, ac.pct, ac.status, ac.created_at, c.name AS company_name
       FROM affiliate_commissions ac
       LEFT JOIN companies c ON c.company_uuid = ac.company_uuid
      WHERE ac.affiliate_id = ? ORDER BY ac.id DESC LIMIT 6`,
    [affiliateId],
  );

  const [recentPayouts] = await pool.query(
    `SELECT id, amount_cents, status, method, requested_at, paid_at
       FROM affiliate_payouts WHERE affiliate_id = ? ORDER BY id DESC LIMIT 5`,
    [affiliateId],
  );

  // Alertas do próprio afiliado: pagamento aguardando confirmação e crédito disponível.
  const alerts: { type: string; title: string; detail: string; link?: string }[] = [];
  if (summary.requestedCents > 0) {
    alerts.push({
      type: 'info',
      title: 'Pagamento em processamento',
      detail: 'Você tem um pedido de pagamento aguardando confirmação.',
      link: '/afiliado/pagamentos',
    });
  }
  if (summary.availableCents > 0) {
    alerts.push({
      type: 'warning',
      title: 'Você tem crédito a receber',
      detail: 'Solicite o pagamento na aba Pagamentos.',
      link: '/afiliado/pagamentos',
    });
  }

  res.render('afiliado-dashboard', {
    me,
    summary,
    companies,
    recentCommissions,
    recentPayouts,
    alerts,
    active: 'dashboard',
  });
});

router.get('/indicacoes', requireAffiliateAuth, async (req: AffiliateRequest, res) => {
  const affiliateId = req.affiliateId!;
  const [companies] = await getPool().query(
    `SELECT c.company_uuid, c.name, c.plan, c.valid_until, c.city, c.state, c.email, c.phone,
            (SELECT COUNT(*) FROM charges ch WHERE ch.company_uuid = c.company_uuid) AS charges_count,
            (SELECT COALESCE(SUM(ch.amount_cents),0) FROM charges ch
              WHERE ch.company_uuid = c.company_uuid AND ch.status = 'pendente') AS pending_cents,
            (SELECT COALESCE(SUM(ch.amount_cents),0) FROM charges ch
              WHERE ch.company_uuid = c.company_uuid AND ch.status = 'paga') AS paid_cents
       FROM companies c WHERE c.affiliate_id = ? ORDER BY c.name`,
    [affiliateId],
  );
  res.render('afiliado-indicacoes', { companies, active: 'indicacoes' });
});

router.get('/comissoes', requireAffiliateAuth, async (req: AffiliateRequest, res) => {
  const affiliateId = req.affiliateId!;
  const status = typeof req.query.status === 'string' &&
    ['disponivel', 'solicitado', 'pago', 'cancelado'].includes(req.query.status)
    ? req.query.status
    : '';
  const params: unknown[] = [affiliateId];
  let where = 'WHERE ac.affiliate_id = ?';
  if (status) {
    where += ' AND ac.status = ?';
    params.push(status);
  }
  const [commissions] = await getPool().query(
    `SELECT ac.id, ac.amount_cents, ac.base_cents, ac.pct, ac.status, ac.created_at, ac.paid_at,
            c.name AS company_name, c.company_uuid, ch.description AS charge_description
       FROM affiliate_commissions ac
       LEFT JOIN companies c ON c.company_uuid = ac.company_uuid
       LEFT JOIN charges ch ON ch.id = ac.charge_id
      ${where} ORDER BY ac.id DESC LIMIT 500`,
    params,
  );
  const summary = await affiliateSummary(affiliateId);
  res.render('afiliado-comissoes', { commissions, summary, filter: { status }, active: 'comissoes' });
});

router.get('/pagamentos', requireAffiliateAuth, async (req: AffiliateRequest, res) => {
  const affiliateId = req.affiliateId!;
  const pool = getPool();
  const summary = await affiliateSummary(affiliateId);
  const [payouts] = await pool.query(
    `SELECT id, amount_cents, status, method, notes, requested_at, paid_at, paid_by
       FROM affiliate_payouts WHERE affiliate_id = ? ORDER BY id DESC`,
    [affiliateId],
  );
  const [pendingCharges] = await pool.query(
    `SELECT c.name AS company_name, ch.description, ch.amount_cents, ch.due_date,
            ROUND(ch.amount_cents * a.commission_pct / 100) AS forecast_cents
       FROM charges ch
       JOIN companies c ON c.company_uuid = ch.company_uuid
       JOIN affiliates a ON a.id = c.affiliate_id
      WHERE c.affiliate_id = ? AND ch.status = 'pendente'
      ORDER BY ch.due_date ASC LIMIT 30`,
    [affiliateId],
  );
  res.render('afiliado-pagamentos', { payouts, summary, pendingCharges, active: 'pagamentos', ok: null, error: null });
});

router.post('/pagamentos/solicitar', requireAffiliateAuth, async (req: AffiliateRequest, res) => {
  const affiliateId = req.affiliateId!;
  const method = typeof req.body?.method === 'string' ? req.body.method.trim().slice(0, 40) : null;
  const notes = typeof req.body?.notes === 'string' ? req.body.notes.trim().slice(0, 255) : null;
  const result = await createPayoutFromAvailable({
    affiliateId,
    method: method || null,
    notes: notes || null,
    requestedBy: 'afiliado',
  });
  const summary = await affiliateSummary(affiliateId);
  const [payouts] = await getPool().query(
    `SELECT id, amount_cents, status, method, notes, requested_at, paid_at, paid_by
       FROM affiliate_payouts WHERE affiliate_id = ? ORDER BY id DESC`,
    [affiliateId],
  );
  const [pendingCharges] = await getPool().query(
    `SELECT c.name AS company_name, ch.description, ch.amount_cents, ch.due_date,
            ROUND(ch.amount_cents * a.commission_pct / 100) AS forecast_cents
       FROM charges ch
       JOIN companies c ON c.company_uuid = ch.company_uuid
       JOIN affiliates a ON a.id = c.affiliate_id
      WHERE c.affiliate_id = ? AND ch.status = 'pendente'
      ORDER BY ch.due_date ASC LIMIT 30`,
    [affiliateId],
  );
  res.render('afiliado-pagamentos', {
    payouts,
    summary,
    pendingCharges,
    active: 'pagamentos',
    ok: result ? 'Pedido de pagamento enviado. Aguarde a confirmação.' : null,
    error: result ? null : 'Não há crédito disponível para solicitar agora.',
  });
});

router.get('/perfil', requireAffiliateAuth, async (req: AffiliateRequest, res) => {
  const me = await loadMe(req.affiliateId!);
  res.render('afiliado-perfil', { me, error: null, success: null, active: 'perfil' });
});

router.post('/perfil/password', requireAffiliateAuth, async (req: AffiliateRequest, res) => {
  const me = await loadMe(req.affiliateId!);
  const { currentPassword, newPassword, confirmPassword } = req.body ?? {};
  const fail = (error: string) => res.status(400).render('afiliado-perfil', { me, error, success: null, active: 'perfil' });

  if (!currentPassword || !newPassword || !confirmPassword) {
    fail('Preencha todos os campos.');
    return;
  }
  if (String(newPassword) !== String(confirmPassword)) {
    fail('A confirmação não bate com a nova senha.');
    return;
  }
  if (String(newPassword).length < 6) {
    fail('A nova senha precisa ter pelo menos 6 caracteres.');
    return;
  }
  const identity = await verifyAffiliateCredentials(String(me?.username ?? ''), String(currentPassword));
  if (!identity) {
    fail('Senha atual incorreta.');
    return;
  }
  await getPool().query('UPDATE affiliates SET password_hash = ? WHERE id = ?', [
    hashAffiliatePassword(String(newPassword)),
    req.affiliateId,
  ]);
  res.render('afiliado-perfil', { me, error: null, success: 'Senha alterada com sucesso.', active: 'perfil' });
});

export default router;
