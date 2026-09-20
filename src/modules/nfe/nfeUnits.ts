/**
 * Conversão de unidade e detecção de embalagem na importação de NF-e.
 *
 * O fornecedor pode faturar em CAIXA (uCom=CX, qCom=10, vUnCom=50,00) enquanto o produto
 * é vendido em UNIDADE. Sem converter, o importador lançaria 10 unidades a R$ 50 (estoque
 * 12x menor e custo 12x maior). Aqui ficam as regras PURAS (sem banco) que decidem o fator
 * de conversão e se o EAN da nota é código de embalagem.
 *
 * Ordem de confiança do fator (unidades de venda por 1 unidade da nota):
 *   1. unidade de venda == unidade da nota           → 1;
 *   2. uTrib (unidade tributável) == unidade de venda → qTrib / qCom;
 *   3. conversão já conhecida do fornecedor (pack)     → pack_qty;
 *   4. unidade da nota é embalagem sem fator conhecido → precisa do usuário (null).
 */
import type { NfeDetItem } from './nfeParse';
import { isPackagingUnit, unitKey } from '../../shared/units';

export type ConversionSource = 'same_unit' | 'trib' | 'supplier_pack' | 'needs_input';

export interface ConversionResult {
  /** Unidades de venda por 1 unidade da nota. null = precisa do usuário. */
  factor: number | null;
  source: ConversionSource;
  /** Unidade de compra da nota (ex.: 'CX') — só quando há conversão real (factor != 1). */
  packUnit: string | null;
}

export interface SupplierPack {
  unit: string | null;
  qty: number | null;
}

function sameUnit(a: string | null | undefined, b: string | null | undefined): boolean {
  const ka = unitKey(a);
  const kb = unitKey(b);
  return !!ka && !!kb && ka === kb;
}

/**
 * Decide o fator de conversão para levar a quantidade/custo da nota à unidade de venda
 * `targetUnit`. `targetUnit` nulo/vazio (produto novo sem unidade definida) devolve 1.
 */
export function detectConversion(
  item: NfeDetItem,
  targetUnit: string | null | undefined,
  supplierPack?: SupplierPack | null,
): ConversionResult {
  const noteUnit = item.unit;
  if (!targetUnit || !unitKey(targetUnit)) return { factor: 1, source: 'same_unit', packUnit: null };
  if (sameUnit(noteUnit, targetUnit)) return { factor: 1, source: 'same_unit', packUnit: null };

  // uTrib é a unidade de referência fiscal — em nota de caixa costuma vir a unidade de venda.
  if (sameUnit(item.unitTrib, targetUnit) && item.qtyTrib != null && item.qtyTrib > 0 && item.qty > 0) {
    const factor = item.qtyTrib / item.qty;
    if (factor > 0 && Number.isFinite(factor)) {
      return { factor, source: 'trib', packUnit: noteUnit };
    }
  }

  if (supplierPack && supplierPack.qty != null && supplierPack.qty > 0 && sameUnit(supplierPack.unit, noteUnit)) {
    return { factor: supplierPack.qty, source: 'supplier_pack', packUnit: noteUnit };
  }

  if (isPackagingUnit(noteUnit)) {
    return { factor: null, source: 'needs_input', packUnit: noteUnit };
  }
  // Unidades diferentes e nenhuma pista: assume 1 (não inventa conversão).
  return { factor: 1, source: 'same_unit', packUnit: null };
}

/**
 * O EAN da nota é código de EMBALAGEM (caixa)? Só nesses casos ele não pode virar o código
 * principal do produto. Sinais: GTIN-14 (indicador de embalagem), EAN tributável diferente
 * do comercial, ou unidade da nota sendo embalagem quando há conversão para unidade menor.
 */
export function isPackagingEan(item: NfeDetItem, factor: number | null): boolean {
  const ean = (item.ean ?? '').trim();
  if (!ean) return false;
  if (/^\d{14}$/.test(ean)) return true;
  if (item.eanTrib && item.eanTrib.trim() && item.eanTrib.trim() !== ean) return true;
  if (isPackagingUnit(item.unit) && factor != null && factor > 1) return true;
  return false;
}

/** EAN que representa a UNIDADE de venda (para virar products.barcode): o comercial se
 *  não for embalagem; senão o tributável, se existir e não for embalagem. */
export function unitEanFor(item: NfeDetItem, factor: number | null): string | null {
  const ean = (item.ean ?? '').trim() || null;
  if (ean && !isPackagingEan(item, factor)) return ean;
  const trib = (item.eanTrib ?? '').trim() || null;
  if (trib && trib !== ean && !/^\d{14}$/.test(trib)) return trib;
  return null;
}
