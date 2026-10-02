import { BaseRepository, type Row } from '../../../core/database/repository';

/** Linha de `odonto_procedures` — catálogo clínico de procedimentos. */
export interface ProcedureRow extends Row {
  id: number;
  product_id: number | null;
  code: string | null;
  name: string;
  category: string | null;
  description: string | null;
  default_price_cents: number;
  duration_min: number | null;
  active: number;
  uuid: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  comment: string;
}

/** Colunas que o módulo aceita gravar. */
export const PROCEDURE_FIELDS = [
  'product_id', 'code', 'name', 'category', 'description', 'default_price_cents', 'duration_min', 'active',
] as const;

class ProcedureRepository extends BaseRepository<ProcedureRow> {
  constructor() {
    super('odonto_procedures');
  }

  list(opts: { q?: string; active?: boolean } = {}): ProcedureRow[] {
    const where: string[] = ['p.deleted_at IS NULL'];
    const params: unknown[] = [];
    if (opts.active !== undefined) {
      where.push('p.active = ?');
      params.push(opts.active ? 1 : 0);
    }
    const q = (opts.q ?? '').trim();
    if (q) {
      where.push('(p.name LIKE ? OR p.code LIKE ? OR p.category LIKE ?)');
      const like = `%${q}%`;
      params.push(like, like, like);
    }
    // O nome do produto vinculado ajuda a enxergar o que já existe no catálogo comercial.
    return this.raw(
      `SELECT p.*, pr.name AS product_name
         FROM odonto_procedures p
         LEFT JOIN products pr ON pr.id = p.product_id AND pr.deleted_at IS NULL
        WHERE ${where.join(' AND ')}
        ORDER BY p.active DESC, p.category, p.name`,
      ...params,
    );
  }

  findByCode(code: string): ProcedureRow | undefined {
    return this.rawOne(
      'SELECT * FROM odonto_procedures WHERE deleted_at IS NULL AND code = ? LIMIT 1',
      code,
    );
  }
}

export const procedureRepository = new ProcedureRepository();
