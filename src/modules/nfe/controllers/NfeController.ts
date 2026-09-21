import type { Request, Response } from 'express';
import { NfeImportError, buildImportPreview, commitImport, NFE_MARKUP_SETTING } from '../nfeImport';
import { revertImport } from '../nfeRevert';
import { buildEditData, commitEdit, NfeEditChoiceRequired } from '../nfeEdit';
import { productRepository } from '../../commercial/repositories/ProductRepository';
import { categoryRepository } from '../../commercial/repositories/CategoryRepository';
import { purchaseInvoiceRepository } from '../repositories/NfeRepository';
import { settingsRepository } from '../../../core/repositories/SettingsRepository';
import { audit } from '../../../core/audit/service';

function wrap(handler: (req: Request, res: Response) => void) {
  return (req: Request, res: Response): void => {
    try {
      handler(req, res);
    } catch (e) {
      // A edição precisa de uma escolha do usuário sobre o estoque: 409 com o detalhe.
      // O envelope global só preserva campos extras quando o corpo já traz `success`.
      if (e instanceof NfeEditChoiceRequired) {
        res.status(409).json({ success: false, error: e.message, needsStockChoice: true, divergence: e.divergence });
        return;
      }
      if (e instanceof NfeImportError) {
        res.status(400).json({ error: e.message });
        return;
      }
      const msg = e instanceof Error ? e.message : String(e);
      res.status(400).json({ error: msg });
    }
  };
}

export const nfeController = {
  preview: wrap((req, res) => {
    const xml = typeof req.body?.xml === 'string' ? req.body.xml : '';
    if (!xml.trim()) { res.status(400).json({ error: 'Nenhum XML enviado.' }); return; }
    res.json(buildImportPreview(xml));
  }),

  commit: wrap((req, res) => {
    const xml = typeof req.body?.xml === 'string' ? req.body.xml : '';
    const decisions = Array.isArray(req.body?.decisions) ? req.body.decisions : [];
    if (!xml.trim()) { res.status(400).json({ error: 'Nenhum XML enviado.' }); return; }
    if (!decisions.length) { res.status(400).json({ error: 'Nenhuma decisão de conferência enviada.' }); return; }
    res.json(commitImport(req, xml, decisions));
  }),

  searchProducts: wrap((req, res) => {
    const q = String(req.query.q ?? '').trim();
    if (q.length < 2) { res.json([]); return; }
    const rows = productRepository.raw(
      `SELECT id, name, sku, barcode, unit, cost_cents, price_cents
         FROM products
        WHERE deleted_at IS NULL
          AND product_type != 'complemento'
          AND product_type != 'variante'
          AND (name LIKE ? OR barcode = ? OR sku = ?
               OR EXISTS (SELECT 1 FROM product_barcodes pb
                           WHERE pb.product_id = products.id AND pb.barcode = ? AND pb.deleted_at IS NULL))
        ORDER BY name LIMIT 12`,
      `%${q}%`, q, q, q,
    );
    res.json(rows);
  }),

  listCategories: wrap((_req, res) => {
    res.json(categoryRepository.listAll());
  }),

  listInvoices: wrap((_req, res) => {
    const rows = purchaseInvoiceRepository.raw(
      `SELECT pi.id, pi.access_key, pi.invoice_number, pi.series, pi.issued_at, pi.total_cents,
              pi.status, pi.created_at, s.name AS supplier_name,
              (SELECT COUNT(*) FROM purchase_invoice_items pii WHERE pii.purchase_invoice_id = pi.id) AS items_count,
              (SELECT COUNT(*) FROM purchase_invoice_items pii WHERE pii.purchase_invoice_id = pi.id AND pii.product_id IS NOT NULL) AS imported_count
         FROM purchase_invoices pi
         LEFT JOIN suppliers s ON s.id = pi.supplier_id
        WHERE pi.deleted_at IS NULL
        ORDER BY pi.id DESC LIMIT 30`,
    );
    res.json(rows);
  }),

  revert: wrap((req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: 'Importação inválida.' }); return; }
    res.json(revertImport(req, id));
  }),

  /** Baixa o XML original da NF-e de compra (para guardar/enviar ao contador). */
  downloadXml: wrap((req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: 'Importação inválida.' }); return; }
    const row = purchaseInvoiceRepository.rawOne(
      'SELECT access_key, xml FROM purchase_invoices WHERE id = ? AND deleted_at IS NULL',
      id,
    ) as { access_key: string; xml: string } | undefined;
    if (!row) { res.status(404).json({ error: 'Importação não encontrada.' }); return; }
    audit(req, 'exportar', 'purchase_invoice', id, null, { accessKey: row.access_key });
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="nfe-${row.access_key}.xml"`);
    res.send(row.xml);
  }),

  /** Reabre a conferência de uma importação para edição (pré-preenchida). */
  edit: wrap((req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: 'Importação inválida.' }); return; }
    res.json(buildEditData(id));
  }),

  /** Salva a edição de uma importação (estorna a versão antiga e aplica a nova). */
  commitEdit: wrap((req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: 'Importação inválida.' }); return; }
    const decisions = Array.isArray(req.body?.decisions) ? req.body.decisions : [];
    if (!decisions.length) { res.status(400).json({ error: 'Nenhuma decisão de conferência enviada.' }); return; }
    const raw = req.body?.stockMode;
    const stockMode = raw === 'keep' || raw === 'restore' ? raw : null;
    res.json(commitEdit(req, id, decisions, stockMode));
  }),

  /** Markup global de sugestão de preço (basis points; 10000 = 100%). */
  setMarkup: wrap((req, res) => {
    const bps = Number(req.body?.markupBps);
    if (!Number.isInteger(bps) || bps < 0 || bps > 100000) {
      res.status(400).json({ error: 'Markup inválido (use 0 a 100000 basis points, ou seja, até 1000%).' });
      return;
    }
    const before = settingsRepository.get(NFE_MARKUP_SETTING);
    settingsRepository.set(NFE_MARKUP_SETTING, String(bps));
    audit(req, 'editar', 'setting', NFE_MARKUP_SETTING, before, { markupBps: bps });
    res.json({ markupBps: bps });
  }),
};
