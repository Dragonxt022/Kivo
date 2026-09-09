import type { Request, Response } from 'express';
import { NfeImportError, buildImportPreview, commitImport } from '../nfeImport';
import { productRepository } from '../../commercial/repositories/ProductRepository';
import { purchaseInvoiceRepository } from '../repositories/NfeRepository';

function wrap(handler: (req: Request, res: Response) => void) {
  return (req: Request, res: Response): void => {
    try {
      handler(req, res);
    } catch (e) {
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
      `SELECT id, name, sku, barcode, unit, cost_cents
         FROM products
        WHERE deleted_at IS NULL
          AND product_type != 'complemento'
          AND product_type != 'variante'
          AND (name LIKE ? OR barcode = ? OR sku = ?)
        ORDER BY name LIMIT 12`,
      `%${q}%`, q, q,
    );
    res.json(rows);
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
};
