import { BaseRepository, type Row } from '../database/repository';

export class RoleRepository extends BaseRepository {
  constructor() {
    super('roles');
  }

  findBySlug(slug: string): Row | undefined {
    return this.findOneWhere({ slug });
  }

  listSlugs(): Row[] {
    return this.raw('SELECT slug, name FROM roles WHERE deleted_at IS NULL ORDER BY is_system DESC, name');
  }
}

export const roleRepository = new RoleRepository();
