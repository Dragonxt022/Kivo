import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { getSqlite } from '../../core/database/connection';
import { requirePermission } from '../../core/permissions/middleware';
import { audit } from '../../core/audit/service';
import { validateDocument } from '../../shared/documents';
import { machineId } from '../../core/license/service';

/**
 * Fábrica de CRUD para cadastros simples do commercial (clientes, fornecedores).
 * Aplica RBAC, auditoria (antes/depois), soft delete e validação de CPF/CNPJ.
 */
export interface CrudConfig {
  table: string;
  entity: string;
  permPrefix: string;
  fields: string[];
  required: string[];
  /** Colunas selecionáveis (aparecem no GET) mas nunca graváveis via POST/PUT — ex.: saldos derivados. */
  readOnlyFields?: string[];
}

export function makeCrudRouter(cfg: CrudConfig): Router {
  const router = Router();
  const db = () => getSqlite();
  const cols = ['id', ...cfg.fields, ...(cfg.readOnlyFields ?? []), 'active', 'updated_at'].join(', ');
  const get = (id: string | number) =>
    db().prepare(`SELECT ${cols} FROM ${cfg.table} WHERE id = ? AND deleted_at IS NULL`).get(id);

  router.get('/', requirePermission(`${cfg.permPrefix}.view`), (req, res) => {
    const q = String(req.query.q ?? '').trim();
    const rows = q
      ? db().prepare(`SELECT ${cols} FROM ${cfg.table} WHERE deleted_at IS NULL AND name LIKE ? ORDER BY name`).all(`%${q}%`)
      : db().prepare(`SELECT ${cols} FROM ${cfg.table} WHERE deleted_at IS NULL ORDER BY name`).all();
    res.json(rows);
  });

  router.get('/:id', requirePermission(`${cfg.permPrefix}.view`), (req, res) => {
    const row = get(String(req.params.id));
    if (!row) {
      res.status(404).json({ error: 'Registro não encontrado.' });
      return;
    }
    res.json(row);
  });

  router.post('/', requirePermission(`${cfg.permPrefix}.create`), (req, res) => {
    const body = req.body ?? {};
    for (const f of cfg.required) {
      if (!body[f]) {
        res.status(400).json({ error: `Campo obrigatório: ${f}` });
        return;
      }
    }
    if (body.document && !validateDocument(String(body.document))) {
      res.status(400).json({ error: 'CPF/CNPJ inválido.' });
      return;
    }
    const values = cfg.fields.map((f) => body[f] ?? null);
    const info = db()
      .prepare(
        `INSERT INTO ${cfg.table} (${cfg.fields.join(', ')}, uuid, origin_machine) VALUES (${cfg.fields.map(() => '?').join(', ')}, ?, ?)`,
      )
      .run(...values, randomUUID(), machineId());
    const created = get(String(info.lastInsertRowid));
    audit(req, 'criar', cfg.entity, Number(info.lastInsertRowid), null, created);
    res.status(201).json(created);
  });

  router.put('/:id', requirePermission(`${cfg.permPrefix}.edit`), (req, res) => {
    const id = String(req.params.id);
    const before = get(id);
    if (!before) {
      res.status(404).json({ error: 'Registro não encontrado.' });
      return;
    }
    const body = req.body ?? {};
    if (body.document && !validateDocument(String(body.document))) {
      res.status(400).json({ error: 'CPF/CNPJ inválido.' });
      return;
    }
    const sets = cfg.fields.map((f) => `${f} = COALESCE(?, ${f})`).join(', ');
    db()
      .prepare(
        `UPDATE ${cfg.table} SET ${sets}, active = COALESCE(?, active), updated_at = datetime('now'), origin_machine = ? WHERE id = ?`,
      )
      .run(...cfg.fields.map((f) => body[f] ?? null), body.active != null ? (body.active ? 1 : 0) : null, machineId(), id);
    const after = get(id);
    audit(req, 'editar', cfg.entity, id, before, after);
    res.json(after);
  });

  router.delete('/:id', requirePermission(`${cfg.permPrefix}.delete`), (req, res) => {
    const id = String(req.params.id);
    const before = get(id);
    if (!before) {
      res.status(404).json({ error: 'Registro não encontrado.' });
      return;
    }
    db()
      .prepare(`UPDATE ${cfg.table} SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`)
      .run(id);
    audit(req, 'excluir', cfg.entity, id, before, null);
    res.json({ ok: true });
  });

  // POST (não DELETE) para não colidir com a rota '/:id' acima, que casaria "bulk-delete" como id.
  router.post('/bulk-delete', requirePermission(`${cfg.permPrefix}.delete`), (req, res) => {
    const bodyIds: unknown[] = Array.isArray(req.body?.ids) ? req.body.ids : [];
    const ids: string[] = [...new Set(bodyIds.map((id) => String(id)))];
    if (!ids.length) {
      res.status(400).json({ error: 'Informe ao menos um id.' });
      return;
    }
    const deletedIds: string[] = [];
    const skipped: string[] = [];
    db().transaction(() => {
      for (const id of ids) {
        const before = get(id);
        if (!before) {
          skipped.push(id);
          continue;
        }
        db()
          .prepare(`UPDATE ${cfg.table} SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`)
          .run(id);
        audit(req, 'excluir', cfg.entity, id, before, null);
        deletedIds.push(id);
      }
    })();
    res.json({ deleted: deletedIds.length, deletedIds, skipped });
  });

  return router;
}
