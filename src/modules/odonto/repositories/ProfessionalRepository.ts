import { BaseRepository, type Row } from '../../../core/database/repository';

/** Linha de `odonto_professionals` — quem atende no consultório. */
export interface ProfessionalRow extends Row {
  id: number;
  user_id: number | null;
  name: string;
  cro: string | null;
  cro_state: string | null;
  specialties: string | null;
  phone: string | null;
  email: string | null;
  active: number;
  uuid: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  comment: string;
}

/** Colunas que o módulo aceita gravar (id/uuid/datas ficam com o repositório). */
export const PROFESSIONAL_FIELDS = [
  'user_id', 'name', 'cro', 'cro_state', 'specialties', 'phone', 'email', 'active',
] as const;

class ProfessionalRepository extends BaseRepository<ProfessionalRow> {
  constructor() {
    super('odonto_professionals');
  }

  list(opts: { q?: string; active?: boolean } = {}): ProfessionalRow[] {
    const where: string[] = ['deleted_at IS NULL'];
    const params: unknown[] = [];
    if (opts.active !== undefined) {
      where.push('active = ?');
      params.push(opts.active ? 1 : 0);
    }
    const q = (opts.q ?? '').trim();
    if (q) {
      where.push('(name LIKE ? OR cro LIKE ? OR specialties LIKE ?)');
      const like = `%${q}%`;
      params.push(like, like, like);
    }
    return this.raw(
      `SELECT * FROM odonto_professionals WHERE ${where.join(' AND ')} ORDER BY active DESC, name`,
      ...params,
    );
  }

  /** Busca por nome/CRO — a agenda vai precisar escolher o profissional por nome. */
  search(term: string, limit = 20): ProfessionalRow[] {
    const like = `%${term.trim()}%`;
    return this.raw(
      `SELECT * FROM odonto_professionals
        WHERE deleted_at IS NULL AND active = 1 AND (name LIKE ? OR cro LIKE ?)
        ORDER BY name LIMIT ?`,
      like, like, limit,
    );
  }

  findByName(name: string): ProfessionalRow | undefined {
    return this.rawOne(
      'SELECT * FROM odonto_professionals WHERE deleted_at IS NULL AND name = ? LIMIT 1',
      name,
    );
  }
}

export const professionalRepository = new ProfessionalRepository();
