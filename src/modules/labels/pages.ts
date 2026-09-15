import { Router, type Request, type Response } from 'express';
import { assertAuth } from '../../shared/auth';
import { hasCapability } from '../../core/capabilities/service';
import { buildLabels, companyName, getSheet, paginate, parseRequest } from './labels';

/** Páginas do módulo labels (montadas em /app/labels, já autenticadas). */
const router = Router();

function gate(req: Request, res: Response, permission: string): boolean {
  assertAuth(req);
  if (!hasCapability('labels.generator')) {
    res.redirect('/');
    return false;
  }
  if (!req.user.permissions.has(permission)) {
    res.redirect('/');
    return false;
  }
  return true;
}

router.get('/', (req, res) => {
  if (!gate(req, res, 'labels.generate')) return;
  res.render('labels-generator', { user: req.user, companyName: companyName() });
});

/**
 * Recebe o "payload" da tela (JSON num campo de formulário, para navegar numa aba nova
 * com `target="_blank"`), remonta as etiquetas no servidor e devolve a folha pronta para
 * impressão. A tela manda só id + quantidade; nome/preço/código são relidos do banco —
 * o cliente nunca dita o que é impresso.
 */
router.post('/imprimir', (req, res) => {
  if (!gate(req, res, 'labels.generate')) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(String((req.body as Record<string, unknown>)?.payload ?? '{}'));
  } catch {
    return res.status(400).send('Dados de impressão inválidos.');
  }
  const reqData = parseRequest(parsed);
  if (!reqData.ok) return res.status(400).send(reqData.error);

  const sheet = getSheet(reqData.config.sheetId);
  if (!sheet) return res.status(404).send('Modelo de folha não encontrado.');

  const labels = buildLabels(reqData.items, reqData.config.symbology);
  if (!labels.length) return res.status(400).send('Nenhum produto encontrado para imprimir.');
  const pages = paginate(labels, sheet);

  res.render('labels-print', {
    sheet,
    pages,
    fields: reqData.config.fields,
    symbology: reqData.config.symbology,
    company: companyName(),
    total: labels.length,
  });
});

export default router;
