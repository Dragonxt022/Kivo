import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { getSqlite } from '../database/connection';
import { requirePermission } from '../permissions/middleware';
import { hashPassword } from '../auth/service';
import { audit } from '../audit/service';

const router = Router();

function getUser(id: number | string) {
  return getSqlite()
    .prepare(
      `SELECT u.id, u.username, u.name, u.email, u.role_id, r.slug AS role, u.active, u.last_login_at
       FROM users u JOIN roles r ON r.id = u.role_id
       WHERE u.id = ? AND u.deleted_at IS NULL`,
    )
    .get(id);
}

/** Cargos disponíveis para o cadastro de usuário (inclui personalizados). */
router.get('/roles', requirePermission('users.view'), (_req, res) => {
  res.json(getSqlite().prepare('SELECT slug, name FROM roles WHERE deleted_at IS NULL ORDER BY is_system DESC, name').all());
});

router.get('/', requirePermission('users.view'), (_req, res) => {
  const users = getSqlite()
    .prepare(
      `SELECT u.id, u.username, u.name, u.email, r.slug AS role, u.active, u.last_login_at
       FROM users u JOIN roles r ON r.id = u.role_id
       WHERE u.deleted_at IS NULL ORDER BY u.name`,
    )
    .all();
  res.json(users);
});

router.post('/', requirePermission('users.create'), (req, res) => {
  const { username, name, email, password, roleSlug } = req.body ?? {};
  if (!username || !name || !password || !roleSlug) {
    res.status(400).json({ error: 'Campos obrigatórios: username, name, password, roleSlug.' });
    return;
  }
  const db = getSqlite();
  const role = db.prepare('SELECT id FROM roles WHERE slug = ?').get(roleSlug) as
    | { id: number }
    | undefined;
  if (!role) {
    res.status(400).json({ error: `Cargo inexistente: ${roleSlug}` });
    return;
  }
  try {
    const info = db
      .prepare(
        `INSERT INTO users (username, name, email, password_hash, role_id, uuid) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(username, name, email ?? null, hashPassword(String(password)), role.id, randomUUID());
    const created = getUser(Number(info.lastInsertRowid));
    audit(req, 'criar', 'user', Number(info.lastInsertRowid), null, created);
    res.status(201).json(created);
  } catch {
    res.status(409).json({ error: 'Nome de usuário já existe.' });
  }
});

router.put('/:id', requirePermission('users.edit'), (req, res) => {
  const id = String(req.params.id);
  const before = getUser(id);
  if (!before) {
    res.status(404).json({ error: 'Usuário não encontrado.' });
    return;
  }
  const { name, email, roleSlug, active, password } = req.body ?? {};
  const db = getSqlite();

  let roleId: number | undefined;
  if (roleSlug) {
    const role = db.prepare('SELECT id FROM roles WHERE slug = ?').get(roleSlug) as
      | { id: number }
      | undefined;
    if (!role) {
      res.status(400).json({ error: `Cargo inexistente: ${roleSlug}` });
      return;
    }
    roleId = role.id;
  }

  db.prepare(
    `UPDATE users SET
       name = COALESCE(?, name),
       email = COALESCE(?, email),
       role_id = COALESCE(?, role_id),
       active = COALESCE(?, active),
       password_hash = COALESCE(?, password_hash),
       updated_at = datetime('now')
     WHERE id = ?`,
  ).run(
    name ?? null,
    email ?? null,
    roleId ?? null,
    active != null ? (active ? 1 : 0) : null,
    password ? hashPassword(String(password)) : null,
    id,
  );

  const after = getUser(id);
  audit(req, 'editar', 'user', id, before, after);
  res.json(after);
});

router.delete('/:id', requirePermission('users.delete'), (req, res) => {
  const id = String(req.params.id);
  const before = getUser(id);
  if (!before) {
    res.status(404).json({ error: 'Usuário não encontrado.' });
    return;
  }
  if (req.user && String(req.user.id) === id) {
    res.status(400).json({ error: 'Você não pode excluir o próprio usuário.' });
    return;
  }
  // Soft delete (contrato de sincronização §6).
  getSqlite()
    .prepare(`UPDATE users SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`)
    .run(id);
  audit(req, 'excluir', 'user', id, before, null);
  res.json({ ok: true });
});

// POST (não DELETE) para não colidir com a rota '/:id' acima.
router.post('/bulk-delete', requirePermission('users.delete'), (req, res) => {
  const bodyIds: unknown[] = Array.isArray(req.body?.ids) ? req.body.ids : [];
  const rawIds: string[] = [...new Set(bodyIds.map((id) => String(id)))];
  const selfId = req.user ? String(req.user.id) : null;
  const selfSkipped = selfId != null && rawIds.includes(selfId);
  const ids = rawIds.filter((id) => id !== selfId);
  if (!ids.length) {
    res.status(400).json({ error: 'Informe ao menos um id (diferente do seu próprio usuário).' });
    return;
  }
  const deletedIds: string[] = [];
  const skipped: string[] = [];
  getSqlite().transaction(() => {
    for (const id of ids) {
      const before = getUser(id);
      if (!before) {
        skipped.push(id);
        continue;
      }
      getSqlite()
        .prepare(`UPDATE users SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`)
        .run(id);
      audit(req, 'excluir', 'user', id, before, null);
      deletedIds.push(id);
    }
  })();
  res.json({ deleted: deletedIds.length, deletedIds, skipped, selfSkipped });
});

export default router;
