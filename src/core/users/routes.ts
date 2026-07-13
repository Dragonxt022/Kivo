import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { requirePermission } from '../permissions/middleware';
import { hashPassword } from '../auth/service';
import { audit } from '../audit/service';
import { validatePasswordStrength } from '../../shared/validation';
import { userRepository } from '../repositories/UserRepository';
import { roleRepository } from '../repositories/RoleRepository';

const router = Router();

router.get('/roles', requirePermission('users.view'), (_req, res) => {
  res.json(roleRepository.listSlugs());
});

router.get('/', requirePermission('users.view'), (_req, res) => {
  res.json(userRepository.listWithRoles());
});

router.post('/', requirePermission('users.create'), (req, res) => {
  const { username, name, email, password, roleSlug } = req.body ?? {};
  if (!username || !name || !password || !roleSlug) {
    res.status(400).json({ error: 'Campos obrigatórios: username, name, password, roleSlug.' });
    return;
  }
  const pwError = validatePasswordStrength(password);
  if (pwError) {
    res.status(400).json({ error: pwError });
    return;
  }
  const role = roleRepository.findBySlug(roleSlug) as { id: number } | undefined;
  if (!role) {
    res.status(400).json({ error: `Cargo inexistente: ${roleSlug}` });
    return;
  }
  try {
    const id = userRepository.create({
      username, name, email: email ?? null,
      password_hash: hashPassword(String(password)), role_id: role.id, uuid: randomUUID(),
    });
    const created = userRepository.findByIdWithRole(id);
    audit(req, 'criar', 'user', id, null, created);
    res.status(201).json(created);
  } catch {
    res.status(409).json({ error: 'Nome de usuário já existe.' });
  }
});

router.put('/:id', requirePermission('users.edit'), (req, res) => {
  const id = String(req.params.id);
  const before = userRepository.findByIdWithRole(id);
  if (!before) {
    res.status(404).json({ error: 'Usuário não encontrado.' });
    return;
  }
  const { name, email, roleSlug, active, password } = req.body ?? {};

  if (password) {
    const pwError = validatePasswordStrength(password);
    if (pwError) {
      res.status(400).json({ error: pwError });
      return;
    }
  }

  let roleId: number | undefined;
  if (roleSlug) {
    const role = roleRepository.findBySlug(roleSlug) as { id: number } | undefined;
    if (!role) {
      res.status(400).json({ error: `Cargo inexistente: ${roleSlug}` });
      return;
    }
    roleId = role.id;
  }

  userRepository.update(id, {
    name: name ?? null,
    email: email ?? null,
    role_id: roleId ?? null,
    active: active != null ? (active ? 1 : 0) : null,
    password_hash: password ? hashPassword(String(password)) : null,
  } as Record<string, unknown>);

  const after = userRepository.findByIdWithRole(id);
  audit(req, 'editar', 'user', id, before, after);
  res.json(after);
});

router.delete('/:id', requirePermission('users.delete'), (req, res) => {
  const id = String(req.params.id);
  const before = userRepository.findByIdWithRole(id);
  if (!before) {
    res.status(404).json({ error: 'Usuário não encontrado.' });
    return;
  }
  if (req.user && String(req.user.id) === id) {
    res.status(400).json({ error: 'Você não pode excluir o próprio usuário.' });
    return;
  }
  userRepository.softDelete(id);
  audit(req, 'excluir', 'user', id, before, null);
  res.json({ ok: true });
});

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
  userRepository.transaction(() => {
    for (const id of ids) {
      const before = userRepository.findByIdWithRole(id);
      if (!before) {
        skipped.push(id);
        continue;
      }
      userRepository.softDelete(id);
      audit(req, 'excluir', 'user', id, before, null);
      deletedIds.push(id);
    }
  });
  res.json({ deleted: deletedIds.length, deletedIds, skipped, selfSkipped });
});

export default router;
