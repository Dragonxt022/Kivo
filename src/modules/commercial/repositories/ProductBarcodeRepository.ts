import { randomUUID } from 'node:crypto';
import { BaseRepository, type Row } from '../../../core/database/repository';

export type ProductBarcodeKind = 'unidade' | 'caixa' | 'lastro' | 'inner' | 'outro';

export interface ProductBarcodeRow extends Row {
  id: number;
  product_id: number;
  barcode: string;
  kind: string;
  pack_qty: number | null;
  supplier_id: number | null;
}

/**
 * Códigos de barras ADICIONAIS do produto. O `products.barcode` continua sendo o código
 * principal de venda (unidade); esta tabela guarda os demais (caixa/lastro/inner) sem
 * deixá-los virar o código do produto — foi exatamente o que acontecia na importação
 * de NF-e, que gravava o EAN da caixa em `products.barcode`.
 */
export class ProductBarcodeRepository extends BaseRepository<ProductBarcodeRow> {
  constructor() {
    super('product_barcodes');
  }

  listByProduct(productId: number): ProductBarcodeRow[] {
    return this.raw(
      `SELECT id, product_id, barcode, kind, pack_qty, supplier_id
         FROM product_barcodes
        WHERE product_id = ? AND deleted_at IS NULL
        ORDER BY kind, barcode`,
      productId,
    ) as unknown as ProductBarcodeRow[];
  }

  /** Todos os códigos ativos (produto × código) — usado para indexar a classificação da NF-e. */
  listAllActive(): { product_id: number; barcode: string }[] {
    return this.raw(
      `SELECT product_id, barcode FROM product_barcodes WHERE deleted_at IS NULL`,
    ) as unknown as { product_id: number; barcode: string }[];
  }

  /** Produto dono de um código adicional (para a busca por bipe no PDV). */
  findProductIdByBarcode(barcode: string): number | null {
    const row = this.rawOne(
      `SELECT product_id FROM product_barcodes
        WHERE barcode = ? AND deleted_at IS NULL LIMIT 1`,
      barcode,
    ) as { product_id: number } | undefined;
    return row?.product_id ?? null;
  }

  /**
   * Adiciona um código se ainda não existir ATIVO em nenhum produto. Se já pertencer ao
   * mesmo produto, atualiza kind/pack (idempotente). Se pertencer a OUTRO produto, não
   * faz nada — dois produtos não podem dividir o mesmo código (o índice é único).
   */
  addIfMissing(
    productId: number,
    barcode: string,
    kind: ProductBarcodeKind = 'unidade',
    packQty: number | null = null,
    supplierId: number | null = null,
  ): boolean {
    const code = String(barcode ?? '').trim();
    if (!code) return false;
    // Nunca duplicar o código PRINCIPAL de outro produto (o índice de products.barcode é
    // único e a busca por bipe prioriza o principal).
    const ownedAsPrimary = this.rawOne(
      `SELECT 1 FROM products WHERE barcode = ? AND deleted_at IS NULL AND id <> ? LIMIT 1`,
      code, productId,
    );
    if (ownedAsPrimary) return false;
    const existing = this.rawOne(
      `SELECT id, product_id FROM product_barcodes
        WHERE barcode = ? AND deleted_at IS NULL LIMIT 1`,
      code,
    ) as { id: number; product_id: number } | undefined;
    if (existing) {
      if (existing.product_id !== productId) return false;
      this.rawRun(
        `UPDATE product_barcodes SET kind = ?, pack_qty = COALESCE(?, pack_qty),
                supplier_id = COALESCE(?, supplier_id), updated_at = datetime('now')
          WHERE id = ?`,
        kind, packQty, supplierId, existing.id,
      );
      return true;
    }
    this.create({
      product_id: productId,
      barcode: code,
      kind,
      pack_qty: packQty,
      supplier_id: supplierId,
      uuid: randomUUID(),
      origin_machine: null,
    });
    return true;
  }
}

export const productBarcodeRepository = new ProductBarcodeRepository();
