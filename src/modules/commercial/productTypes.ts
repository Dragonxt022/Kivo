import { BaseRepository, type Row } from '../../core/database/repository';

export interface ProductTypeConfigRow extends Row {
  id: number;
  key: string;
  label: string;
  description: string | null;
  controls_stock: number;
  active: number;
  sort_order: number;
}

export interface ProductTypePatch {
  controls_stock?: number;
  active?: number;
  label?: string;
  description?: string | null;
}

/**
 * Configuração dos tipos de produto (Configurações › Tipos de produto). Substitui o
 * comportamento que antes estava hardcoded no cadastro e no servidor.
 */
class ProductTypeConfigRepository extends BaseRepository<ProductTypeConfigRow> {
  constructor() {
    super('product_type_config');
  }

  list(): ProductTypeConfigRow[] {
    return this.raw(
      `SELECT id, key, label, description, controls_stock, active, sort_order
         FROM product_type_config WHERE deleted_at IS NULL ORDER BY sort_order, label`,
    ) as unknown as ProductTypeConfigRow[];
  }

  get(key: string): ProductTypeConfigRow | undefined {
    return this.rawOne(
      `SELECT id, key, label, description, controls_stock, active, sort_order
         FROM product_type_config WHERE key = ? AND deleted_at IS NULL`,
      key,
    ) as ProductTypeConfigRow | undefined;
  }
}

export const productTypeConfigRepository = new ProductTypeConfigRepository();

// Cache curto: o servidor lê a config a cada produto salvo; um TTL pequeno evita bater no
// banco em rajada sem deixar a tela de configuração com valor velho por muito tempo.
let cache: { at: number; map: Map<string, ProductTypeConfigRow> } | null = null;
const CACHE_MS = 5000;

export function invalidateProductTypeCache(): void {
  cache = null;
}

export function productTypeMap(): Map<string, ProductTypeConfigRow> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.map;
  const map = new Map(productTypeConfigRepository.list().map((r) => [r.key, r]));
  cache = { at: Date.now(), map };
  return map;
}

export function productTypeConfig(key: string): ProductTypeConfigRow | undefined {
  return productTypeMap().get(key);
}

/**
 * O tipo controla estoque? Sem configuração (tipo legado/desconhecido), assume que SIM —
 * é o comportamento anterior para qualquer tipo não listado.
 */
export function typeControlsStock(key: string): boolean {
  const c = productTypeConfig(key);
  return c ? Number(c.controls_stock) === 1 : true;
}

/** O tipo está ativo (oferecido ao criar produtos)? */
export function typeIsActive(key: string): boolean {
  const c = productTypeConfig(key);
  return c ? Number(c.active) === 1 : true;
}
