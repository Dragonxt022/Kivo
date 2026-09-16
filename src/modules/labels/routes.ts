import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import type { z } from 'zod';
import { requirePermission } from '../../core/permissions/middleware';
import { requireCapability } from '../../core/capabilities/middleware';
import { validateBody } from '../../shared/validateBody';
import { audit } from '../../core/audit/service';
import { labelSheetRepository, type LabelSheetRow } from './repositories/LabelSheetRepository';
import { labelPrintJobRepository } from './repositories/LabelPrintJobRepository';
import { labelSheetSchema, updateLabelSheetSchema } from './schemas';
import { searchProducts } from './labels';
import { barcodeSvg, isSymbology } from './services/barcode';

/** API do módulo labels (montada em /api/labels). Tudo atrás da capability. */
const router = Router();
router.use(requireCapability('labels.generator'));

/** JSON guardado em coluna TEXT pode estar corrompido; a lista não pode quebrar por isso. */
function safeParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

router.get('/sheets', requirePermission('labels.generate'), (_req, res) => {
  res.json(labelSheetRepository.listAll());
});

router.post('/sheets', requirePermission('labels.sheets.manage'), validateBody(labelSheetSchema), (req, res) => {
  const data = req.body as z.infer<typeof labelSheetSchema>;
  const id = labelSheetRepository.create({ ...data, is_preset: 0, uuid: randomUUID() });
  const sheet = labelSheetRepository.findById(id);
  audit(req, 'criar', 'label_sheet', id, null, sheet);
  res.status(201).json(sheet);
});

router.put('/sheets/:id', requirePermission('labels.sheets.manage'), validateBody(updateLabelSheetSchema), (req, res) => {
  const sheet = labelSheetRepository.findById(String(req.params.id));
  if (!sheet) return res.status(404).json({ error: 'Modelo de folha não encontrado.' });
  if (sheet.is_preset) return res.status(400).json({ error: 'Modelos de fábrica não podem ser alterados. Crie um modelo próprio.' });
  labelSheetRepository.update(sheet.id, req.body as Partial<LabelSheetRow>);
  const after = labelSheetRepository.findById(sheet.id);
  audit(req, 'editar', 'label_sheet', sheet.id, sheet, after);
  res.json(after);
});

router.delete('/sheets/:id', requirePermission('labels.sheets.manage'), (req, res) => {
  const sheet = labelSheetRepository.findById(String(req.params.id));
  if (!sheet) return res.status(404).json({ error: 'Modelo de folha não encontrado.' });
  if (sheet.is_preset) return res.status(400).json({ error: 'Modelos de fábrica não podem ser excluídos.' });
  labelSheetRepository.softDelete(sheet.id);
  audit(req, 'excluir', 'label_sheet', sheet.id, sheet, null);
  res.json({ ok: true });
});

router.get('/products', requirePermission('labels.generate'), (req, res) => {
  const limit = Number(req.query.limit);
  res.json(searchProducts(String(req.query.q ?? ''), Number.isFinite(limit) ? limit : 40));
});

/** Prévia do código na tela: devolve o SVG sem precisar montar a folha inteira. */
router.get('/barcode-preview', requirePermission('labels.generate'), (req, res) => {
  const symbology = isSymbology(req.query.symbology) ? req.query.symbology : 'ean13';
  res.json(barcodeSvg(symbology, String(req.query.text ?? '')));
});

/** Histórico de impressões. Devolve o payload salvo para a tela poder REIMPRIMIR a folha. */
router.get('/history', requirePermission('labels.generate'), (req, res) => {
  const limit = Number(req.query.limit);
  res.json(
    labelPrintJobRepository.listRecent(Number.isFinite(limit) ? limit : 50).map((r) => ({
      id: r.id,
      sheetId: r.sheet_id,
      sheetName: r.sheet_name,
      symbology: r.symbology,
      totalLabels: r.total_labels,
      pages: r.pages,
      userName: r.user_name,
      createdAt: r.created_at,
      fields: safeParse(r.fields_json),
      summary: safeParse(r.summary_json ?? ''),
      payload: safeParse(r.payload_json),
    })),
  );
});

export default router;
