import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { requirePermission } from '../permissions/middleware';
import { hashPassword } from '../auth/service';
import { audit } from '../audit/service';
import { validatePasswordStrength } from '../../shared/validation';
import { validateBody } from '../../shared/validateBody';
import { createUserSchema, updateUserSchema, bulkDeleteUsersSchema } from '../../shared/schemas';
import { userRepository } from '../repositories/UserRepository';
import { roleRepository } from '../repositories/RoleRepository';
import { disableQuickProfile, enableQuickProfile, hasQuickProfile } from '../auth/quickLogin';

const router = Router();

router.get('/roles', requirePermission('users.view'), (_req, res) => {
  res.json(roleRepository.listSlugs());
});

/**
 * A lista já vem dizendo quem tem entrada rápida NESTA máquina (`quickLogin`). Vem daqui, e
 * não da tabela `users`, porque a preferência é por computador e não sincroniza — ver
 * migration 0056: ligar em um terminal não pode liberar login sem senha nos outros.
 */
router.get('/', requirePermission('users.view'), (_req, res) => {
  const users = userRepository.listWithRoles() as { id: number }[];
  res.json(users.map((u) => ({ ...u, quickLogin: hasQuickProfile(u.id) })));
});

/** Liga/desliga o balão de entrada rápida deste usuário nesta máquina. */
function aplicarEntradaRapida(userId: number, ligar: unknown): void {
  if (ligar === undefined || ligar === null) return;
  if (ligar) enableQuickProfile(userId);
  else disableQuickProfile(userId);
}

router.post('/', requirePermission('users.create'), validateBody(createUserSchema), (req, res) => {
  const { username, name, email, password, roleSlug, quickLogin } = req.body;
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
    aplicarEntradaRapida(id, quickLogin);
    const created = userRepository.findByIdWithRole(id);
    audit(req, 'criar', 'user', id, null, { ...(created as object), quickLogin: !!quickLogin });
    res.status(201).json({ ...(created as object), quickLogin: hasQuickProfile(id) });
  } catch {
    res.status(409).json({ error: 'Nome de usuário já existe.' });
  }
});

router.put('/:id', requirePermission('users.edit'), validateBody(updateUserSchema), (req, res) => {
  const id = String(req.params.id);
  const before = userRepository.findByIdWithRole(id);
  if (!before) {
    res.status(404).json({ error: 'Usuário não encontrado.' });
    return;
  }
  const { name, email, roleSlug, active, password, quickLogin } = req.body;

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

  /**
   * Só as colunas que vieram no corpo.
   *
   * Antes o objeto trazia as cinco sempre, com `null` no que faltasse — e
   * `BaseRepository.update` escreve tudo o que recebe. Editar um usuário sem digitar senha
   * nova mandava `password_hash = NULL` para uma coluna NOT NULL e a tela devolvia
   * "Erro interno do servidor", que é o caso mais comum de edição (trocar o cargo, corrigir
   * o nome, desativar alguém). `role_id` e `active` corriam o mesmo risco quando o cliente
   * não mandava o campo.
   */
  const patch: Record<string, unknown> = {};
  if (name != null) patch.name = name;
  if (email !== undefined) patch.email = email || null; // e-mail aceita ficar vazio
  if (roleId != null) patch.role_id = roleId;
  if (active != null) patch.active = active ? 1 : 0;
  if (password) patch.password_hash = hashPassword(String(password));
  if (Object.keys(patch).length) userRepository.update(id, patch);

  // Usuário desativado perde o balão junto: deixá-lo na tela de login seria oferecer uma
  // entrada que o `quickLogin` recusa depois — um clique que só devolve erro.
  const nId = Number(id);
  if (active != null && !active) disableQuickProfile(nId);
  else aplicarEntradaRapida(nId, quickLogin);

  const after = userRepository.findByIdWithRole(id);
  audit(req, 'editar', 'user', id, before, after);
  res.json({ ...(after as object), quickLogin: hasQuickProfile(nId) });
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

router.post('/bulk-delete', requirePermission('users.delete'), validateBody(bulkDeleteUsersSchema), (req, res) => {
  const bodyIds = req.body.ids as (number | string)[];
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
