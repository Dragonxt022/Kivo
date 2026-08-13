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

/** Credenciais de fábrica criadas por `runSeeds` quando o banco nasce sem nenhum usuário. */
const FACTORY_USERNAME = 'admin';
const FACTORY_PASSWORD = 'admin';

/**
 * Instalação recém-ativada que ninguém personalizou ainda: só existe o usuário de fábrica
 * e a senha dele continua sendo a de fábrica.
 *
 * Quem acabou de aceitar o teste cai numa tela de login sem ter recebido credencial
 * nenhuma — não há como adivinhar admin/admin. Enquanto esta função devolver true, a home
 * troca o formulário de login pela criação do acesso do dono (ver POST /api/auth/first-run).
 *
 * A verificação é feita no estado real do banco, não numa flag: instalações antigas que
 * nunca trocaram a senha também são cobertas, e no instante em que a senha muda a tela
 * de primeiro acesso desaparece sozinha.
 */
export function isFirstRunSetupPending(): boolean {
  const rows = userRepository.raw(
    'SELECT username, password_hash FROM users WHERE deleted_at IS NULL',
  ) as unknown as { username: string; password_hash: string }[];
  if (rows.length !== 1) return false;
  const only = rows[0];
  return only.username === FACTORY_USERNAME && verifyPassword(FACTORY_PASSWORD, only.password_hash);
}

/**
 * Substitui as credenciais de fábrica pelas do dono da loja, no primeiro acesso.
 * Rota pública por necessidade (não existe sessão ainda), então a guarda é o próprio
 * estado de fábrica: com a senha já trocada, a operação passa a ser negada.
 */
export function completeFirstRunSetup(
  input: { name: string; username: string; password: string },
): { ok: true; userId: number } | { ok: false; error: string } {
  if (!isFirstRunSetupPending()) {
    return { ok: false, error: 'O acesso deste sistema já foi configurado. Entre com seu usuário e senha.' };
  }
  const admin = userRepository.rawOne(
    'SELECT id FROM users WHERE username = ? AND deleted_at IS NULL',
    FACTORY_USERNAME,
  ) as { id: number } | undefined;
  if (!admin) return { ok: false, error: 'Usuário inicial não encontrado.' };

  const username = input.username.trim().toLowerCase();
  userRepository.rawRun(
    `UPDATE users SET username = ?, name = ?, password_hash = ?, updated_at = datetime('now') WHERE id = ?`,
    username, input.name.trim(), hashPassword(input.password), admin.id,
  );
  // Nenhuma sessão deveria existir ainda, mas se alguém entrou com admin/admin antes de
  // chegar aqui, essa sessão não pode sobreviver à troca de dono do usuário.
  userRepository.rawRun('DELETE FROM sessions WHERE user_id = ?', admin.id);
  return { ok: true, userId: admin.id };
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

/**
 * Exportada (além do uso interno da sessão) para `core/auth/systemContext.ts`: a fila de
 * comandos do Kivo Web precisa executar no nome do usuário que pediu a ação, com o mesmo
 * conjunto de permissões que ele teria logado no desktop.
 */
export function loadAuthUser(userId: number): AuthUser | null {
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
