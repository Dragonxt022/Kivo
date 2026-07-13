import { BaseRepository, type Row } from '../database/repository';

export interface UserRow extends Row {
  id: number;
  username: string;
  name: string;
  email: string | null;
  password_hash: string;
  role_id: number;
  active: number;
  last_login_at: string | null;
}

export class UserRepository extends BaseRepository<UserRow> {
  constructor() {
    super('users');
  }

  findByUsername(username: string): UserRow | undefined {
    return this.rawOne('SELECT * FROM users WHERE username = ? AND deleted_at IS NULL', username);
  }

  findByUsernameWithPassword(username: string): UserRow | undefined {
    return this.rawOne('SELECT * FROM users WHERE username = ? AND deleted_at IS NULL', username);
  }

  listWithRoles(): Row[] {
    return this.raw(
      `SELECT u.id, u.username, u.name, u.email, r.slug AS role, u.active, u.last_login_at
       FROM users u JOIN roles r ON r.id = u.role_id
       WHERE u.deleted_at IS NULL ORDER BY u.name`,
    );
  }

  findByIdWithRole(id: number | string): Row | undefined {
    return this.rawOne(
      `SELECT u.id, u.username, u.name, u.email, u.role_id, r.slug AS role, u.active, u.last_login_at
       FROM users u JOIN roles r ON r.id = u.role_id
       WHERE u.id = ? AND u.deleted_at IS NULL`,
      id,
    );
  }

  updateLastLogin(id: number): void {
    this.rawRun("UPDATE users SET last_login_at = datetime('now') WHERE id = ?", id);
  }
}

export const userRepository = new UserRepository();
