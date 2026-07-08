import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { getSqlite } from './connection';

/** Permissões do Core. Módulos adicionam as suas via manifesto. */
export const CORE_PERMISSIONS: { key: string; description: string }[] = [
  { key: 'users.view', description: 'Visualizar usuários' },
  { key: 'users.create', description: 'Criar usuários' },
  { key: 'users.edit', description: 'Editar usuários' },
  { key: 'users.delete', description: 'Excluir usuários' },
  { key: 'roles.view', description: 'Visualizar cargos e permissões' },
  { key: 'roles.edit', description: 'Editar cargos e permissões' },
  { key: 'audit.view', description: 'Visualizar log de auditoria' },
  { key: 'settings.view', description: 'Visualizar configurações' },
  { key: 'settings.edit', description: 'Editar configurações' },
  { key: 'backup.view', description: 'Visualizar histórico de backups' },
  { key: 'backup.run', description: 'Executar backup manual' },
  { key: 'backup.restore', description: 'Restaurar backup' },
  { key: 'license.view', description: 'Visualizar licença' },
  { key: 'license.edit', description: 'Alterar licença' },
  { key: 'sync.run', description: 'Executar sincronização manual com a nuvem' },
  { key: 'billing.view', description: 'Visualizar cobranças da nuvem' },
  { key: 'security.pin.manage', description: 'Definir/alterar o PIN de administrador' },
];

const DEFAULT_ROLES: { slug: string; name: string; permissions: string[] | '*' }[] = [
  { slug: 'administrador', name: 'Administrador', permissions: '*' },
  {
    slug: 'gerente',
    name: 'Gerente',
    permissions: ['users.view', 'users.create', 'users.edit', 'roles.view', 'audit.view', 'settings.view', 'backup.view', 'backup.run', 'sync.run', 'billing.view'],
  },
  { slug: 'operador', name: 'Operador', permissions: [] },
  { slug: 'caixa', name: 'Caixa', permissions: [] },
  { slug: 'entregador', name: 'Entregador', permissions: [] },
  { slug: 'estoquista', name: 'Estoquista', permissions: [] },
];

/** Idempotente: roda em todo boot sem duplicar nada. */
export function runSeeds(): void {
  const db = getSqlite();

  const insertPerm = db.prepare(
    `INSERT INTO permissions (key, description, module) VALUES (?, ?, 'core')
     ON CONFLICT(key) DO UPDATE SET description = excluded.description`,
  );
  for (const p of CORE_PERMISSIONS) insertPerm.run(p.key, p.description);

  const insertRole = db.prepare(
    `INSERT INTO roles (slug, name, is_system, uuid) VALUES (?, ?, 1, ?)
     ON CONFLICT(slug) DO NOTHING`,
  );
  const grant = db.prepare(
    `INSERT INTO role_permissions (role_id, permission_key) VALUES (?, ?)
     ON CONFLICT(role_id, permission_key) DO NOTHING`,
  );

  for (const role of DEFAULT_ROLES) {
    insertRole.run(role.slug, role.name, randomUUID());
    const { id } = db.prepare('SELECT id FROM roles WHERE slug = ?').get(role.slug) as {
      id: number;
    };
    const keys =
      role.permissions === '*' ? CORE_PERMISSIONS.map((p) => p.key) : role.permissions;
    for (const key of keys) grant.run(id, key);
  }

  const hasAdmin = db.prepare('SELECT id FROM users LIMIT 1').get();
  if (!hasAdmin) {
    const { id: roleId } = db
      .prepare("SELECT id FROM roles WHERE slug = 'administrador'")
      .get() as { id: number };
    db.prepare(
      `INSERT INTO users (username, name, password_hash, role_id, uuid) VALUES (?, ?, ?, ?, ?)`,
    ).run('admin', 'Administrador', bcrypt.hashSync('admin', 10), roleId, randomUUID());
    console.warn('[seeds] usuário inicial criado: admin / admin — TROQUE A SENHA no primeiro acesso.');
  }
}
