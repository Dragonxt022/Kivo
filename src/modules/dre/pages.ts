import { Router, type Request, type Response } from 'express';
import { getSqlite } from '../../core/database/connection';
import { demonstrativoResultado } from './report';

/** Páginas do módulo dre (montadas em /app/dre, já autenticadas). */
const router = Router();
const db = () => getSqlite();

interface CompanyInfo { name: string; document: string | null; address: string | null }

/** Cópia local do helper de finance/pages.ts — mesmo padrão de duplicar helpers pequenos entre páginas de impressão. */
function companyInfo(): CompanyInfo {
  const rows = db()
    .prepare("SELECT key, value FROM settings WHERE key IN ('empresa.nome', 'empresa.documento', 'empresa.endereco') AND deleted_at IS NULL")
    .all() as { key: string; value: string | null }[];
  const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return { name: map['empresa.nome'] || 'Katsu', document: map['empresa.documento'] || null, address: map['empresa.endereco'] || null };
}

function page(view: string, permission: string, extra: Record<string, unknown> = {}) {
  return (req: Request, res: Response) => {
    if (!req.user!.permissions.has(permission)) return res.redirect('/');
    res.render(view, { user: req.user, ...extra });
  };
}

router.get('/relatorio', page('dre-relatorio', 'dre.view'));
router.get('/categorias', page('dre-categorias', 'dre.categories.edit'));

router.get('/relatorio/imprimir', (req, res) => {
  if (!req.user!.permissions.has('dre.view')) return res.redirect('/');
  const from = String(req.query.from || '0000-01-01');
  const to = String(req.query.to || '9999-12-31');
  const report = demonstrativoResultado(from, to);
  const generatedAt = new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Porto_Velho', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(new Date());
  res.render('dre-report-print', { report, company: companyInfo(), generatedAt });
});

export default router;
