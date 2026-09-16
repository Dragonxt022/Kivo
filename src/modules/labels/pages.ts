import { Router, type Request, type Response } from 'express';
import { assertAuth } from '../../shared/auth';
import { hasCapability } from '../../core/capabilities/service';
import { createLogger } from '../../core/logger';
import { buildLabels, companyName, getSheet, paginate, parseRequest } from './labels';
import { labelPrintJobRepository } from './repositories/LabelPrintJobRepository';

const log = createLogger('labels');

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

router.get('/historico', (req, res) => {
  if (!gate(req, res, 'labels.generate')) return;
  res.render('labels-history', { user: req.user });
});

/**
 * Recebe o "payload" da tela (JSON num campo de formulário, para navegar numa aba nova
 * com `target="_blank"`), remonta as etiquetas no servidor e devolve a folha pronta para
 * impressão. A tela manda só id + quantidade; nome/preço/código são relidos do banco —
 * o cliente nunca dita o que é impresso.
 */
router.post('/imprimir', (req, res) => {
  if (!gate(req, res, 'labels.generate')) return;
  assertAuth(req);
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

  // Histórico para reimpressão e rastreio. É acessório: se falhar, a folha sai do mesmo jeito.
  try {
    // Resumo por produto (nome + código impresso) para a lista do histórico não depender de
    // recarregar o catálogo; o `payload` cru fica guardado à parte, só para reimprimir.
    const byProduct = new Map<number, { id: number; name: string; code: string; qty: number }>();
    for (const l of labels) {
      const e = byProduct.get(l.productId);
      if (e) e.qty += 1;
      else byProduct.set(l.productId, { id: l.productId, name: l.name, code: l.code, qty: 1 });
    }
    labelPrintJobRepository.createJob({
      sheetId: sheet.id,
      sheetName: sheet.name,
      symbology: reqData.config.symbology,
      fieldsJson: JSON.stringify(reqData.config.fields),
      payloadJson: JSON.stringify(parsed),
      summaryJson: JSON.stringify([...byProduct.values()]),
      totalLabels: labels.length,
      pages: pages.length,
      userId: req.user.id,
      userName: req.user.name || req.user.username,
    });
  } catch (e) {
    log.error('não foi possível registrar o histórico de etiquetas', e);
  }

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
