import { randomBytes } from 'node:crypto';
import os from 'node:os';
import bcrypt from 'bcryptjs';
import { userRepository } from '../repositories/UserRepository';

const SESSION_HOURS = 12;
const REMEMBER_DAYS = 30;

export interface AuthUser {
  id: number;
  username: string;
  name: string;
  roleId: number;
  roleSlug: string;
  permissions: Set<string>;
}

export function hashPassword(plain: string): string {
  return bcrypt.hashSync(plain, 12);
}

export function verifyPassword(plain: string, hash: string): boolean {
  return bcrypt.compareSync(plain, hash);
}

export interface LoginResult {
  token: string;
  expiresAt: string;
  user: AuthUser;
}

export function login(
  username: string,
  password: string,
  remember: boolean,
  ip?: string,
): LoginResult | null {
  const row = userRepository.rawOne(
    `SELECT u.id, u.username, u.name, u.password_hash, u.role_id, r.slug AS role_slug
     FROM users u JOIN roles r ON r.id = u.role_id
     WHERE u.username = ? AND u.active = 1 AND u.deleted_at IS NULL`,
    username,
  ) as
    | { id: number; username: string; name: string; password_hash: string; role_id: number; role_slug: string }
    | undefined;

  if (!row || !verifyPassword(password, row.password_hash)) return null;

  const token = randomBytes(32).toString('hex');
  const ms = remember ? REMEMBER_DAYS * 24 * 3600e3 : SESSION_HOURS * 3600e3;
  const expiresAt = new Date(Date.now() + ms).toISOString();

  userRepository.rawRun(
    `INSERT INTO sessions (token, user_id, remember, expires_at, ip, machine) VALUES (?, ?, ?, ?, ?, ?)`,
    token, row.id, remember ? 1 : 0, expiresAt, ip ?? null, os.hostname(),
  );
  userRepository.updateLastLogin(row.id);

  return { token, expiresAt, user: loadAuthUser(row.id)! };
}

export function logout(token: string): void {
  userRepository.rawRun('DELETE FROM sessions WHERE token = ?', token);
}

export function userFromToken(token: string): AuthUser | null {
  const session = userRepository.rawOne(
    `SELECT user_id FROM sessions WHERE token = ? AND expires_at > datetime('now')`,
    token,
  ) as { user_id: number } | undefined;
  return session ? loadAuthUser(session.user_id) : null;
}

function loadAuthUser(userId: number): AuthUser | null {
  const u = userRepository.rawOne(
    `SELECT u.id, u.username, u.name, u.role_id, r.slug AS role_slug
     FROM users u JOIN roles r ON r.id = u.role_id
     WHERE u.id = ? AND u.active = 1 AND u.deleted_at IS NULL`,
    userId,
  ) as
    | { id: number; username: string; name: string; role_id: number; role_slug: string }
    | undefined;
  if (!u) return null;

  const perms = userRepository.raw(
    'SELECT permission_key FROM role_permissions WHERE role_id = ?',
    u.role_id,
  ) as unknown as { permission_key: string }[];

  return {
    id: u.id,
    username: u.username,
    name: u.name,
    roleId: u.role_id,
    roleSlug: u.role_slug,
    permissions: new Set(perms.map((p) => p.permission_key)),
  };
}
