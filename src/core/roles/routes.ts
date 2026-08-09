import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { getSqlite } from '../database/connection';
import { requirePermission } from '../permissions/middleware';
import { audit } from '../audit/service';
import { ROLE_PRESETS } from './presets';

const router = Router();
const db = () => getSqlite();

/** Catálogo de permissões agrupado por módulo (para a matriz da tela). */
router.get('/permissions', requirePermission('roles.view'), (_req, res) => {
  res.json(db().prepare('SELECT key, description, module FROM permissions ORDER BY module, key').all());
});

/**
 * Modelos de cargo — os mesmos que as seeds usam para criar os cargos de fábrica.
 * A tela consome isto para descrever cada cargo em linguagem de lojista e para o botão
 * "aplicar modelo", em vez de manter uma segunda cópia da lista no JavaScript da view.
 */
router.get('/presets', requirePermission('roles.view'), (_req, res) => {
  res.json(ROLE_PRESETS);
});

router.get('/', requirePermission('roles.view'), (_req, res) => {
  const roles = db().prepare(
    `SELECT r.id, r.slug, r.name, r.is_system,
            (SELECT COUNT(*) FROM users u WHERE u.role_id = r.id AND u.deleted_at IS NULL) AS users
     FROM roles r WHERE r.deleted_at IS NULL ORDER BY r.is_system DESC, r.name`,
  ).all() as { id: number }[];
  const grants = db().prepare('SELECT role_id, permission_key FROM role_permissions').all() as
    { role_id: number; permission_key: string }[];
  const byRole = new Map<number, string[]>();
  for (const g of grants) {
    if (!byRole.has(g.role_id)) byRole.set(g.role_id, []);
    byRole.get(g.role_id)!.push(g.permission_key);
  }
  res.json(roles.map((r) => ({ ...r, permissions: byRole.get(r.id) ?? [] })));
});

router.post('/', requirePermission('roles.edit'), (req, res) => {
  const { name } = req.body ?? {};
  if (!name) {
    res.status(400).json({ error: 'Campo obrigatório: name.' });
    return;
  }
  const slug = String(name).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  try {
    const info = db().prepare('INSERT INTO roles (slug, name, is_system, uuid) VALUES (?, ?, 0, ?)')
      .run(slug, name, randomUUID());
    audit(req, 'criar', 'role', Number(info.lastInsertRowid), null, { slug, name });
    res.status(201).json({ id: Number(info.lastInsertRowid), slug, name });
  } catch {
    res.status(409).json({ error: 'Já existe um cargo com esse nome.' });
  }
});

/** Substitui o conjunto de permissões do cargo (matriz da tela). */
router.put('/:id/permissions', requirePermission('roles.edit'), (req, res) => {
  const id = Number(req.params.id);
  const role = db().prepare('SELECT id, slug, is_system FROM roles WHERE id = ? AND deleted_at IS NULL').get(id) as
    { id: number; slug: string; is_system: number } | undefined;
  if (!role) {
    res.status(404).json({ error: 'Cargo não encontrado.' });
    return;
  }
  if (role.slug === 'administrador') {
    res.status(400).json({ error: 'O cargo Administrador sempre tem todas as permissões.' });
    return;
  }
  const permissions: string[] = Array.isArray(req.body?.permissions) ? req.body.permissions : [];
  const valid = new Set(
    (db().prepare('SELECT key FROM permissions').all() as { key: string }[]).map((p) => p.key),
  );
  const invalid = permissions.filter((p) => !valid.has(p));
  if (invalid.length) {
    res.status(400).json({ error: `Permissões inexistentes: ${invalid.join(', ')}` });
    return;
  }
  const before = (db().prepare('SELECT permission_key FROM role_permissions WHERE role_id = ?').all(id) as
    { permission_key: string }[]).map((p) => p.permission_key);
  db().transaction(() => {
    db().prepare('DELETE FROM role_permissions WHERE role_id = ?').run(id);
    const ins = db().prepare('INSERT INTO role_permissions (role_id, permission_key) VALUES (?, ?)');
    for (const p of permissions) ins.run(id, p);
  })();
  audit(req, 'editar_permissoes', 'role', id, { permissions: before }, { permissions });
  res.json({ ok: true, permissions });
});

router.delete('/:id', requirePermission('roles.edit'), (req, res) => {
  const id = Number(req.params.id);
  const role = db().prepare('SELECT id, slug, name, is_system FROM roles WHERE id = ? AND deleted_at IS NULL').get(id) as
    { id: number; slug: string; name: string; is_system: number } | undefined;
  if (!role) {
    res.status(404).json({ error: 'Cargo não encontrado.' });
    return;
  }
  if (role.is_system) {
    res.status(400).json({ error: 'Cargos do sistema não podem ser excluídos.' });
    return;
  }
  const inUse = db().prepare('SELECT COUNT(*) c FROM users WHERE role_id = ? AND deleted_at IS NULL').get(id) as { c: number };
  if (inUse.c > 0) {
    res.status(400).json({ error: `Cargo em uso por ${inUse.c} usuário(s).` });
    return;
  }
  db().prepare(`UPDATE roles SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).run(id);
  audit(req, 'excluir', 'role', id, role, null);
  res.json({ ok: true });
});

export default router;
