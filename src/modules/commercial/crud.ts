import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { BaseRepository } from '../../core/database/repository';
import { requirePermission } from '../../core/permissions/middleware';
import { audit } from '../../core/audit/service';
import { validateDocument } from '../../shared/documents';
import { validateBody } from '../../shared/validateBody';
import { machineId } from '../../core/license/service';

export interface CrudConfig {
  table: string;
  entity: string;
  permPrefix: string;
  fields: string[];
  required: string[];
  readOnlyFields?: string[];
}

/**
 * Um campo desta fábrica sempre acaba num parâmetro de SQL, e o `better-sqlite3` só aceita
 * escalar. Mandar `{"name":{"a":1}}` para /api/commercial/customers estourava lá embaixo,
 * no bind — resposta 500 e stack no log, quando o certo é 400 dizendo qual campo veio
 * errado. Este é o formato genérico que cobre as três entidades da fábrica (clientes,
 * fornecedores, empresas conveniadas) sem precisar declarar schema para cada uma.
 */
const crudScalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);

function crudBodySchema(cfg: CrudConfig) {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const f of cfg.fields) shape[f] = crudScalar.optional();
  // `active` não está em `fields` (é coluna de todas as tabelas da fábrica) mas o UPDATE lê.
  shape.active = z.union([z.boolean(), z.number().int()]).nullable().optional();
  return z.object(shape);
}

const bulkDeleteSchema = z.object({
  ids: z.array(z.union([z.number().int().positive(), z.string().min(1)]))
    .min(1, 'Informe ao menos um id.'),
});

export function makeCrudRouter(cfg: CrudConfig): Router {
  const router = Router();
  const repo = new BaseRepository(cfg.table);
  const cols = ['id', ...cfg.fields, ...(cfg.readOnlyFields ?? []), 'active', 'updated_at'].join(', ');
  const bodySchema = crudBodySchema(cfg);

  const get = (id: string | number) =>
    repo.rawOne(`SELECT ${cols} FROM ${cfg.table} WHERE id = ? AND deleted_at IS NULL`, id);

  router.get('/', requirePermission(`${cfg.permPrefix}.view`), (req, res) => {
    const q = String(req.query.q ?? '').trim();
    const rows = q
      ? repo.raw(`SELECT ${cols} FROM ${cfg.table} WHERE deleted_at IS NULL AND name LIKE ? ORDER BY name`, `%${q}%`)
      : repo.raw(`SELECT ${cols} FROM ${cfg.table} WHERE deleted_at IS NULL ORDER BY name`);
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

  router.post('/', requirePermission(`${cfg.permPrefix}.create`), validateBody(bodySchema), (req, res) => {
    const body = req.body;
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
    const info = repo.rawRun(
      `INSERT INTO ${cfg.table} (${cfg.fields.join(', ')}, uuid, origin_machine) VALUES (${cfg.fields.map(() => '?').join(', ')}, ?, ?)`,
      ...values, randomUUID(), machineId(),
    );
    const created = get(String(info.lastInsertRowid));
    audit(req, 'criar', cfg.entity, Number(info.lastInsertRowid), null, created);
    res.status(201).json(created);
  });

  router.put('/:id', requirePermission(`${cfg.permPrefix}.edit`), validateBody(bodySchema), (req, res) => {
    const id = String(req.params.id);
    const before = get(id);
    if (!before) {
      res.status(404).json({ error: 'Registro não encontrado.' });
      return;
    }
    const body = req.body;
    if (body.document && !validateDocument(String(body.document))) {
      res.status(400).json({ error: 'CPF/CNPJ inválido.' });
      return;
    }
    const sets = cfg.fields.map((f) => `${f} = COALESCE(?, ${f})`).join(', ');
    repo.rawRun(
      `UPDATE ${cfg.table} SET ${sets}, active = COALESCE(?, active), updated_at = datetime('now'), origin_machine = ? WHERE id = ?`,
      ...cfg.fields.map((f) => body[f] ?? null),
      body.active != null ? (body.active ? 1 : 0) : null, machineId(), id,
    );
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
    repo.softDelete(id);
    audit(req, 'excluir', cfg.entity, id, before, null);
    res.json({ ok: true });
  });

  router.post('/bulk-delete', requirePermission(`${cfg.permPrefix}.delete`), validateBody(bulkDeleteSchema), (req, res) => {
    const bodyIds = req.body.ids as (number | string)[];
    const ids: string[] = [...new Set(bodyIds.map((id) => String(id)))];
    const deletedIds: string[] = [];
    const skipped: string[] = [];
    repo.transaction(() => {
      for (const id of ids) {
        const before = get(id);
        if (!before) {
          skipped.push(id);
          continue;
        }
        repo.softDelete(id);
        audit(req, 'excluir', cfg.entity, id, before, null);
        deletedIds.push(id);
      }
    });
    res.json({ deleted: deletedIds.length, deletedIds, skipped });
  });

  return router;
}
